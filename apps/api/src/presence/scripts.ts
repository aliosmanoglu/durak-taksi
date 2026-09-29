// Presence Lua script'leri (CLAUDE.md Bölüm 5, Senaryo 1–2). Her biri durumu okuyup aynı script
// içinde yazar: Redis script'leri tek parça çalışır, araya başka komut (offline, sweep, Faz 3 kabul
// Lua'sı) giremez. Böylece "status oku → yaz" yarışında şoför yanlışlıkla GEO'ya geri yazılmaz.
// GEOADD sırası (lng, lat). Script'ler yalnızca KEYS ile verilen anahtarlara dokunur.
import type { Redis } from 'ioredis';

export type LuaFn = (...args: (string | number)[]) => Promise<unknown>;

/** `defineCommand` ile EVALSHA (+ NOSCRIPT'te EVAL) kullanan tipli bir çağırıcı döndürür. */
export function defineLua(redis: Redis, name: string, numberOfKeys: number, lua: string): LuaFn {
  redis.defineCommand(name, { numberOfKeys, lua });
  const fn = (redis as unknown as Record<string, LuaFn | undefined>)[name];
  if (typeof fn !== 'function') throw new Error(`Lua komutu tanımlanamadı: ${name}`);
  return (...args) => fn.apply(redis, args);
}

// KEYS: 1=dn:driver:{id} 2=geo 3=heartbeat
// ARGV: 1=driverId 2=lat 3=lng 4=now(ms) 5=hashTtlS
// Döner: 'available' | 'busy'. busy şoför busy kalır (GEO'ya yazılmaz), yalnızca konumu güncellenir.
export const GO_ONLINE = `
local st = redis.call('HGET', KEYS[1], 'status')
redis.call('HSET', KEYS[1], 'lat', ARGV[2], 'lng', ARGV[3], 'updatedAt', ARGV[4])
redis.call('HDEL', KEYS[1], 'heading')
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[1])
if st == 'busy' then
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  return 'busy'
end
redis.call('HSET', KEYS[1], 'status', 'available')
redis.call('GEOADD', KEYS[2], ARGV[3], ARGV[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 'available'
`;

// KEYS: 1=dn:driver:{id} 2=geo 3=heartbeat
// ARGV: 1=driverId 2=hashTtlS 3=force('1'|'0')
// Döner: 'offline' | 'busy' (force değilse ve aktif iş varsa dokunulmaz).
export const GO_OFFLINE = `
if ARGV[3] ~= '1' and redis.call('HGET', KEYS[1], 'status') == 'busy' then
  return 'busy'
end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('HSET', KEYS[1], 'status', 'offline')
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 'offline'
`;

// KEYS: 1=dn:driver:{id} 2=geo 3=heartbeat 4=dn:ratelimit:loc:{id}
// ARGV: 1=driverId 2=lat 3=lng 4=heading('' = yok) 5=now(ms) 6=hashTtlS 7=throttleMs
// Döner: 1 = yazıldı, 0 = throttle, -1 = offline/hash yok (konum yazılmadı).
// Durum kontrolü throttle'dan önce: offline şoförün düşen güncellemeleri throttle hakkı tüketmez.
export const UPDATE_LOCATION = `
local st = redis.call('HGET', KEYS[1], 'status')
if st ~= 'available' and st ~= 'busy' then return -1 end
if not redis.call('SET', KEYS[4], '1', 'NX', 'PX', ARGV[7]) then return 0 end
redis.call('HSET', KEYS[1], 'lat', ARGV[2], 'lng', ARGV[3], 'updatedAt', ARGV[5])
if ARGV[4] ~= '' then
  redis.call('HSET', KEYS[1], 'heading', ARGV[4])
else
  redis.call('HDEL', KEYS[1], 'heading')
end
redis.call('EXPIRE', KEYS[1], ARGV[6])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[1])
if st == 'available' then
  redis.call('GEOADD', KEYS[2], ARGV[3], ARGV[2], ARGV[1])
end
return 1
`;
