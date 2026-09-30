// Heartbeat sweeper (CLAUDE.md Bölüm 5, Senaryo 3). Her şoför için eşik kontrolü Lua içinde yeniden
// yapılır: tarama ile ZREM arasında konum gönderen şoför düşürülmez. `busy` şoföre dokunulmaz.
//
// Atomiklik: ZRANGEBYSCORE yalnızca aday listesi üretir (atomik olması gerekmez). Asıl karar, aday
// partileri için çalışan Lua script'inde verilir: skor yeniden okunur, durum okunur ve temizlik aynı
// script'te yapılır; araya presence script'leri (go_online, konum) veya Faz 3 kabul Lua'sı giremez.
// Tüm listeyi tek script'te işlemek yerine partiler: çok sayıda eski şoförde Redis'i uzun süre
// bloklamamak için. Script'in dokunduğu her anahtar KEYS ile verilir (dinamik anahtar üretilmez).
//
// Düşürülen şoförün hash'ine `offlineReason = stale_heartbeat` yazılır ve `presenceVersion` API'deki
// presence script'leriyle aynı kuralla (shared `PRESENCE_VERSION_LUA`) ayrı `dn:driver:{id}:pv` anahtarında artırılır.
import type { Redis } from 'ioredis';
import { DRIVER_HASH as F, PRESENCE_VERSION_LUA, redisKeys, type OfflineReason } from '@duraknet/shared';

export type SweepOptions = { staleMs: number; now?: number };

/** Tek script çağrısında işlenen en fazla şoför sayısı. */
const BATCH = 100;
/** Tek taramada okunacak en fazla aday; kalanlar sonraki taramaya kalır. */
const SCAN_LIMIT = 5_000;

const STALE_REASON: OfflineReason = 'stale_heartbeat';

// KEYS: 1=geo 2=heartbeat, ardından her şoför için (ARGV sırasıyla) dn:driver:{id}, dn:driver:{id}:pv
// ARGV: 1=cutoff(ms; skor < cutoff ise eski) 2..=driverId
// Döner: offline yapılan driverId'ler.
const SWEEP_LUA = `${PRESENCE_VERSION_LUA}
local cutoff = tonumber(ARGV[1])
local nowMs = dnNowMs()
local out = {}
for i = 2, #ARGV do
  local id = ARGV[i]
  local hkey = KEYS[2 * i - 1]
  local pvKey = KEYS[2 * i]
  local score = redis.call('ZSCORE', KEYS[2], id)
  if score and tonumber(score) < cutoff and redis.call('HGET', hkey, '${F.status}') ~= 'busy' then
    redis.call('ZREM', KEYS[1], id)
    redis.call('ZREM', KEYS[2], id)
    -- Hash'i süresi dolmuş şoför için yeni (TTL'siz) hash ve sürüm yazılmaz: durumu zaten offline/not_online.
    if redis.call('EXISTS', hkey) == 1 then
      redis.call('HSET', hkey, '${F.status}', 'offline', '${F.offlineReason}', '${STALE_REASON}')
      dnBumpVersion(pvKey, nowMs)
    end
    out[#out + 1] = id
  end
end
return out
`;

const COMMAND = 'dnSweepStaleDrivers';
type SweepFn = (numKeys: number, ...args: (string | number)[]) => Promise<string[]>;

function sweepCommand(redis: Redis): SweepFn {
  const r = redis as unknown as Record<string, SweepFn | undefined>;
  // numberOfKeys verilmez: anahtar sayısı partiye göre değişir, ilk argüman olarak geçilir.
  if (typeof r[COMMAND] !== 'function') redis.defineCommand(COMMAND, { lua: SWEEP_LUA });
  const fn = r[COMMAND];
  if (typeof fn !== 'function') throw new Error(`Lua komutu tanımlanamadı: ${COMMAND}`);
  return (...args) => fn.apply(redis, args);
}

/** Eşikten eski ve `busy` olmayan şoförleri offline yapar; offline yapılan driverId'leri döndürür. */
export async function sweepStaleDrivers(redis: Redis, opts: SweepOptions): Promise<string[]> {
  const cutoff = (opts.now ?? Date.now()) - opts.staleMs;
  // Özel aralık: skor < cutoff.
  const stale = await redis.zrangebyscore(redisKeys.heartbeat, '-inf', `(${cutoff}`, 'LIMIT', 0, SCAN_LIMIT);
  if (stale.length === 0) return [];

  const sweep = sweepCommand(redis);
  const removed: string[] = [];
  for (let i = 0; i < stale.length; i += BATCH) {
    const ids = stale.slice(i, i + BATCH);
    const keys = [
      redisKeys.geoAvailable,
      redisKeys.heartbeat,
      ...ids.flatMap((id) => [redisKeys.driver(id), redisKeys.driverPresenceVersion(id)]),
    ];
    removed.push(...(await sweep(keys.length, ...keys, cutoff, ...ids)));
  }
  return removed;
}
