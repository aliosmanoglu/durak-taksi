// CLAUDE.md Bölüm 5 — Redis anahtar şeması. API ve worker aynı anahtarları buradan alır.
// GEO komutlarında sıra (longitude, latitude)'dır.

export const redisKeys = {
  geoAvailable: 'dn:geo:drivers:available',
  heartbeat: 'dn:drivers:heartbeat',
  driver: (driverId: string) => `dn:driver:${driverId}`,
  driverRequests: (driverId: string) => `dn:driver:${driverId}:requests`,
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
