// Presence Lua script'leri (CLAUDE.md Bölüm 5, Senaryo 1–2). Her biri durumu okuyup aynı script
// içinde yazar: Redis script'leri tek parça çalışır, araya başka komut (offline, sweep, Faz 3 kabul
// Lua'sı) giremez. Böylece "status oku → yaz" yarışında şoför yanlışlıkla GEO'ya geri yazılmaz.
// GEOADD sırası (lng, lat). Script'ler yalnızca KEYS ile verilen anahtarlara dokunur.
//
// `presenceVersion` her durum geçişinde (online, offline, force; sweep worker'da) aynı script içinde
// artırılır (`PRESENCE_VERSION_LUA`, Redis `TIME` tabanlı). Sürüm hash'te değil, TTL'siz ayrı
// `dn:driver:{id}:pv` anahtarındadır (hash silinse bile geri gitmez). Durum + sebep + sürüm aynı script'te döner; istemci aynı bağlantıda küçük sürümlü ack / `session_sync`'i yok sayar.
import type { Redis } from 'ioredis';
import { DRIVER_HASH as F, PRESENCE_VERSION_LUA, type OfflineReason } from '@duraknet/shared';

export type LuaFn = (...args: (string | number)[]) => Promise<unknown>;

/** `defineCommand` ile EVALSHA (+ NOSCRIPT'te EVAL) kullanan tipli bir çağırıcı döndürür. */
export function defineLua(redis: Redis, name: string, numberOfKeys: number, lua: string): LuaFn {
  redis.defineCommand(name, { numberOfKeys, lua });
  const fn = (redis as unknown as Record<string, LuaFn | undefined>)[name];
  if (typeof fn !== 'function') throw new Error(`Lua komutu tanımlanamadı: ${name}`);
  return (...args) => fn.apply(redis, args);
}

/** Hash'e yazılan offline sebepleri (`not_online` yazılmaz: kayıt yokluğunu ifade eder). */
export type StoredOfflineReason = Exclude<OfflineReason, 'not_online'>;

// KEYS: 1=dn:driver:{id} 2=geo 3=heartbeat 4=dn:driver:{id}:pv
// ARGV: 1=driverId 2=lat 3=lng 4=now(ms; updatedAt/heartbeat skoru) 5=hashTtlS
// Döner: {status, presenceVersion}; status 'available' | 'busy'. busy şoför busy kalır (GEO'ya yazılmaz),
// yalnızca konumu güncellenir ve sürüm değişmez (mevcut sürüm döner).
export const GO_ONLINE = `${PRESENCE_VERSION_LUA}
local nowMs = dnNowMs()
local st = redis.call('HGET', KEYS[1], '${F.status}')
redis.call('HSET', KEYS[1], '${F.lat}', ARGV[2], '${F.lng}', ARGV[3], '${F.updatedAt}', ARGV[4])
redis.call('HDEL', KEYS[1], '${F.heading}')
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[1])
if st == 'busy' then
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  return {'busy', dnReadVersion(KEYS[4], nowMs)}
end
redis.call('HSET', KEYS[1], '${F.status}', 'available')
redis.call('HDEL', KEYS[1], '${F.offlineReason}')
local v = dnBumpVersion(KEYS[4], nowMs)
redis.call('GEOADD', KEYS[2], ARGV[3], ARGV[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return {'available', v}
`;

// KEYS: 1=dn:driver:{id} 2=geo 3=heartbeat 4=dn:driver:{id}:pv
// ARGV: 1=driverId 2=hashTtlS 3=force('1'|'0') 4=offlineReason(StoredOfflineReason)
// Döner: {status, presenceVersion}; status 'offline' | 'busy' (force değilse ve aktif iş varsa dokunulmaz,
// sürüm değişmez).
export const GO_OFFLINE = `${PRESENCE_VERSION_LUA}
local nowMs = dnNowMs()
if ARGV[3] ~= '1' and redis.call('HGET', KEYS[1], '${F.status}') == 'busy' then
  return {'busy', dnReadVersion(KEYS[4], nowMs)}
end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('HSET', KEYS[1], '${F.status}', 'offline', '${F.offlineReason}', ARGV[4])
local v = dnBumpVersion(KEYS[4], nowMs)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return {'offline', v}
`;

// KEYS: 1=dn:driver:{id} 2=geo 3=heartbeat 4=dn:ratelimit:loc:{id} 5=dn:driver:{id}:pv
// ARGV: 1=driverId 2=lat 3=lng 4=heading('' = yok) 5=now(ms) 6=hashTtlS 7=throttleMs
// Döner: {1} = yazıldı, {0} = throttle,
//        {-1, status, offlineReason, presenceVersion} = offline/hash yok (konum yazılmadı; eksik alan '').
// Offline yanıtı sebep + sürümü taşır: realtime ek round-trip olmadan `session_sync` gönderir.
// Durum kontrolü throttle'dan önce: offline şoförün düşen güncellemeleri throttle hakkı tüketmez.
export const UPDATE_LOCATION = `${PRESENCE_VERSION_LUA}
local h = redis.call('HMGET', KEYS[1], '${F.status}', '${F.offlineReason}')
local st = h[1]
if st ~= 'available' and st ~= 'busy' then
  return {-1, st or '', h[2] or '', dnReadVersion(KEYS[5], dnNowMs())}
end
if not redis.call('SET', KEYS[4], '1', 'NX', 'PX', ARGV[7]) then return {0} end
redis.call('HSET', KEYS[1], '${F.lat}', ARGV[2], '${F.lng}', ARGV[3], '${F.updatedAt}', ARGV[5])
if ARGV[4] ~= '' then
  redis.call('HSET', KEYS[1], '${F.heading}', ARGV[4])
else
  redis.call('HDEL', KEYS[1], '${F.heading}')
end
redis.call('EXPIRE', KEYS[1], ARGV[6])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[1])
if st == 'available' then
  redis.call('GEOADD', KEYS[2], ARGV[3], ARGV[2], ARGV[1])
end
return {1}
`;

// KEYS: 1=dn:driver:{id} 2=dn:driver:{id}:pv
// Döner: {status, offlineReason, presenceVersion} (eksik alan ''; sürüm yoksa Redis'in o anki zamanı).
// Salt okuma; status/sebep (HMGET) ve sürüm (GET, yoksa TIME) aynı script'te: araya geçiş giremez.
export const READ_STATE = `${PRESENCE_VERSION_LUA}
local h = redis.call('HMGET', KEYS[1], '${F.status}', '${F.offlineReason}')
return {h[1] or '', h[2] or '', dnReadVersion(KEYS[2], dnNowMs())}
`;
