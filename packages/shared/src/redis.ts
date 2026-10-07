// CLAUDE.md Bölüm 5 — Redis anahtar şeması. API ve worker aynı anahtarları buradan alır.
// GEO komutlarında sıra (longitude, latitude)'dır.

export const redisKeys = {
  geoAvailable: 'dn:geo:drivers:available',
  heartbeat: 'dn:drivers:heartbeat',
  driver: (driverId: string) => `dn:driver:${driverId}`,
  driverRequests: (driverId: string) => `dn:driver:${driverId}:requests`,
  /** Varlık sürümü (`PresenceVersion`), STRING, TTL yok: hash silinse/süresi dolsa bile sürüm geri gitmez. */
  driverPresenceVersion: (driverId: string) => `dn:driver:${driverId}:pv`,
  locationThrottle: (driverId: string) => `dn:ratelimit:loc:${driverId}`,
  ride: (rideId: string) => `dn:ride:${rideId}`,
  rideCandidates: (rideId: string) => `dn:ride:${rideId}:candidates`,
  rideExcluded: (rideId: string) => `dn:ride:${rideId}:excluded`,
  standActiveRides: (standId: string) => `dn:stand:${standId}:active_rides`,
} as const;

/** Varlık (presence) zamanlamaları. Worker'daki değerler ortam değişkeniyle ezilebilir (kabul testi için). */
export const PRESENCE = {
  /** Bu süredir konum göndermeyen (busy olmayan) şoför sweeper tarafından offline yapılır. */
  HEARTBEAT_STALE_MS: 60_000,
  /** Sweeper tarama aralığı. En kötü durumda GEO'dan çıkış = STALE + SWEEP = 70 sn (kabul sınırı 75 sn). */
  SWEEP_EVERY_MS: 10_000,
  /** Dispatch aramasında şoförün konumu bu süreden eskiyse aday sayılmaz (Faz 3). */
  LOCATION_FRESH_MS: 30_000,
  /** Şoför başına konum güncellemesi en fazla bu aralıkla işlenir; fazlası sessizce düşer. */
  LOCATION_THROTTLE_MS: 1_000,
  /** `dn:driver:{id}` hash'inin TTL'i; her güncellemede yenilenir. */
  DRIVER_HASH_TTL_S: 86_400,
} as const;

/**
 * `dn:driver:{id}` hash'inin alan adları. API Lua script'leri ve worker sweeper'ı bu adları kullanır.
 * `offlineReason`: yalnızca `status = offline` iken anlamlıdır (`OfflineReason`; `not_online` yazılmaz,
 * kayıt yokluğunu ifade eder). Sürüm hash'te değil, ayrı `redisKeys.driverPresenceVersion` anahtarındadır.
 */
export const DRIVER_HASH = {
  status: 'status',
  lat: 'lat',
  lng: 'lng',
  heading: 'heading',
  updatedAt: 'updatedAt',
  rideId: 'rideId',
  offlineReason: 'offlineReason',
} as const;

/**
 * Presence Lua script'lerinin başına eklenen ortak yardımcılar (API ve worker aynı kuralı kullansın diye).
 * `pvKey` = `redisKeys.driverPresenceVersion(id)`; script'e KEYS ile verilir.
 * - `dnNowMs()`: Redis `TIME`'dan epoch ms. Redis ≥ 5 (effect replication) yazmadan önce `TIME`'a izin verir.
 * - `dnReadVersion(pvKey, nowMs)`: saklı sürüm; yoksa `nowMs`.
 * - `dnBumpVersion(pvKey, nowMs)`: yeni sürüm = max(nowMs + 1, eski + 1); yazar ve döndürür.
 *   `+1`: kayıt yokken okunan sürüm `nowMs`'dir; aynı milisaniyedeki geçiş ondan kesin büyük olmalı.
 *   Anahtarın TTL'i yok ve hash'ten ayrı: hash silinse bile sürüm geri gitmez.
 */
export const PRESENCE_VERSION_LUA = `
local function dnNowMs()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local function dnReadVersion(pvKey, nowMs)
  return tonumber(redis.call('GET', pvKey)) or nowMs
end
local function dnBumpVersion(pvKey, nowMs)
  local prev = tonumber(redis.call('GET', pvKey)) or 0
  local v = math.max(nowMs + 1, prev + 1)
  redis.call('SET', pvKey, string.format('%.0f', v))
  return v
end
`;
