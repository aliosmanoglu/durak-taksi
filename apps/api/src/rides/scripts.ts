// Ride Lua script'leri (CLAUDE.md Bölüm 5, Senaryo 5). Yarışabilen işlemlerin Redis tarafı burada atomiktir;
// asıl hakem PG'deki koşullu UPDATE'tir (state-machine.ts). Redis cluster modunda çalışmaz (çok anahtarlı).
// Şoför `busy`/`available` geçişleri `presenceVersion`'ı presence Lua'larıyla aynı kuralla artırır.
import { DRIVER_HASH as D, PRESENCE_VERSION_LUA, RIDE_HASH as R } from '@duraknet/shared';

// Şoförü `busy → available` yapar (yalnızca hash'teki rideId bu ride ise). Çıkış yapmış/hash'i olmayan şoför
// (status != busy) olduğu gibi kalır: busy kalmaz, available'a da yazılmaz. Başarıda GEO'ya (lng, lat) geri yazılır
// ve heartbeat'te yoksa eklenir ki sweeper ileride temizleyebilsin.
const RELEASE_DRIVER_LUA = `
local function releaseDriver(driverKey, geoKey, hbKey, pvKey, driverId, rideId, ttl)
  if driverId == '' then return 0 end
  if redis.call('HGET', driverKey, '${D.status}') ~= 'busy' then return 0 end
  if redis.call('HGET', driverKey, '${D.rideId}') ~= rideId then return 0 end
  redis.call('HSET', driverKey, '${D.status}', 'available')
  redis.call('HDEL', driverKey, '${D.rideId}')
  redis.call('EXPIRE', driverKey, ttl)
  dnBumpVersion(pvKey, dnNowMs())
  local pos = redis.call('HMGET', driverKey, '${D.lng}', '${D.lat}')
  if pos[1] and pos[2] then redis.call('GEOADD', geoKey, pos[1], pos[2], driverId) end
  redis.call('ZADD', hbKey, 'NX', dnNowMs(), driverId)
  return 1
end
`;

// KEYS: 1=ride 2=driver 3=geo 4=candidates 5=excluded 6=driver pv
// ARGV: 1=driverId 2=rideId
// Döner: {0, kod} | {1, yeniSürüm, presenceVersion}. (Senaryo 5; `excluded` ve presenceVersion eklendi.)
export const ACCEPT = `${PRESENCE_VERSION_LUA}
if redis.call('HGET', KEYS[1], '${R.status}') ~= 'searching' then return {0, 'RIDE_NOT_AVAILABLE'} end
if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 0 or redis.call('SISMEMBER', KEYS[5], ARGV[1]) == 1 then
  return {0, 'NOT_A_CANDIDATE'}
end
if redis.call('HGET', KEYS[2], '${D.status}') ~= 'available' then return {0, 'DRIVER_NOT_AVAILABLE'} end
redis.call('HSET', KEYS[1], '${R.status}', 'matched', '${R.driverId}', ARGV[1])
local v = redis.call('HINCRBY', KEYS[1], '${R.version}', 1)
redis.call('HSET', KEYS[2], '${D.status}', 'busy', '${D.rideId}', ARGV[2])
redis.call('ZREM', KEYS[3], ARGV[1])
local pv = dnBumpVersion(KEYS[6], dnNowMs())
return {1, v, pv}
`;

// PG koşullu UPDATE 0 satır döndürünce (veya hata verince) Redis'i geri alır. Şoför, ride'ın durumundan bağımsız
// serbest bırakılır (araya giren durak iptali ride'ı zaten `cancelled` yapmış olabilir); ride hash'i yalnızca hâlâ
// bu şoföre `matched` ise `searching`'e döndürülür.
// KEYS: 1=ride 2=driver 3=geo 4=heartbeat 5=driver pv
// ARGV: 1=driverId 2=rideId 3=önceki sürüm 4=driverHashTtlS
export const ACCEPT_ROLLBACK = `${PRESENCE_VERSION_LUA}${RELEASE_DRIVER_LUA}
if redis.call('HGET', KEYS[1], '${R.status}') == 'matched' and redis.call('HGET', KEYS[1], '${R.driverId}') == ARGV[1] then
  redis.call('HSET', KEYS[1], '${R.status}', 'searching', '${R.version}', ARGV[3])
  redis.call('HDEL', KEYS[1], '${R.driverId}')
end
releaseDriver(KEYS[2], KEYS[3], KEYS[4], KEYS[5], ARGV[1], ARGV[2], ARGV[4])
return 1
`;

// PG geçişi commit olduktan sonra Redis önbelleğini ona uydurur (PG kazanır). İdempotenttir; önbellekteki sürüm
// yeni sürümden küçük değilse (aynı geçişin tekrarı / sıra dışı ulaşma) hiçbir şey yapmaz.
// KEYS: 1=ride 2=candidates 3=excluded 4=stand active_rides 5=driver 6=geo 7=heartbeat 8=driver pv
// ARGV: 1=rideId 2=yeniDurum 3=yeniSürüm 4=serbestBırakılacakŞoför('' yok) 5=şoförüExcludedYap('1'|'0')
//       6=terminalTtlS 7=driverHashTtlS
// Döner: önceki adaylar (yalnızca `searching`'e dönüş veya terminal geçişte; çağıran `ride_taken`/requests temizliği için).
export const MIRROR = `${PRESENCE_VERSION_LUA}${RELEASE_DRIVER_LUA}
local cur = tonumber(redis.call('HGET', KEYS[1], '${R.version}'))
if cur and cur >= tonumber(ARGV[3]) then return {} end
local cands = redis.call('SMEMBERS', KEYS[2])
redis.call('HSET', KEYS[1], '${R.status}', ARGV[2], '${R.version}', ARGV[3])
if ARGV[2] == 'searching' then
  redis.call('HDEL', KEYS[1], '${R.driverId}')
  redis.call('HSET', KEYS[1], '${R.wave}', 0)
  redis.call('DEL', KEYS[2])
  if ARGV[5] == '1' and ARGV[4] ~= '' then redis.call('SADD', KEYS[3], ARGV[4]) end
else
  redis.call('SREM', KEYS[4], ARGV[1])
  redis.call('EXPIRE', KEYS[1], ARGV[6])
  redis.call('EXPIRE', KEYS[2], ARGV[6])
  redis.call('EXPIRE', KEYS[3], ARGV[6])
end
releaseDriver(KEYS[5], KEYS[6], KEYS[7], KEYS[8], ARGV[4], ARGV[1], ARGV[7])
return cands
`;

// KEYS: 1=ride 2=candidates 3=excluded 4=driver requests
// ARGV: 1=driverId 2=rideId
// Döner: 1 = excluded'a eklendi, 0 = ride zaten kapalı (idempotent), -1 = aday değil.
export const DECLINE = `
redis.call('SREM', KEYS[4], ARGV[2])
if redis.call('HGET', KEYS[1], '${R.status}') ~= 'searching' then return 0 end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 0 then return -1 end
redis.call('SADD', KEYS[3], ARGV[1])
return 1
`;
