// Şoför varlığı (CLAUDE.md Bölüm 5, Senaryo 1–2). Konum yalnızca Redis'te tutulur; PG'ye yazılmaz.
// Durum okuyup ardından yazan işlemler (online/offline/konum) Lua ile atomiktir: aksi halde
// "status oku → MULTI" arasında gelen offline/sweep, şoförü yanlışlıkla GEO'ya geri yazar.
import type { Redis } from 'ioredis';
import { DRIVER_STATUSES, PRESENCE, redisKeys, type DriverStatus, type LatLng } from '@duraknet/shared';
import { AppError } from '../http/errors';
import { defineLua, GO_OFFLINE, GO_ONLINE, UPDATE_LOCATION } from './scripts';

export type LocationUpdate = { location: LatLng; heading?: number };

/**
 * `ok`: yazıldı. `throttled`: `LOCATION_THROTTLE_MS` içinde ikinci güncelleme, düştü.
 * `offline`: şoför offline (hash yok, pasif veya sweeper düşürmüş) — konum yazılmadı; istemci bunu
 * bilmeli ki "Aktif" görünüp çağrı alamaz halde kalmasın (realtime `session_sync` gönderir).
 */
export type LocationResult = 'ok' | 'throttled' | 'offline';

export interface PresenceService {
  /** `offline` → `available`; GEO'ya ve heartbeat'e yazar. `busy` şoför `busy` kalır. */
  goOnline(driverId: string, location: LatLng, now?: number): Promise<DriverStatus>;
  /** `available` → `offline`; GEO'dan çıkarır. `busy` iken `INVALID_TRANSITION` (AppError) fırlatır. */
  goOffline(driverId: string): Promise<DriverStatus>;
  /** Hesap askıya alınınca / çıkış yapınca: durumdan bağımsız GEO'dan ve heartbeat'ten çıkarır, `offline` yapar. */
  forceOffline(driverId: string): Promise<void>;
  /**
   * Hash + heartbeat'i günceller; yalnızca `available` ise GEO'ya yazar. `offline` şoförün konumu yok sayılır.
   * Durum kontrolü throttle'dan önce yapılır: offline şoförün güncellemesi throttle tüketmez.
   * Throttle Redis anahtarının TTL'ine (`SET NX PX`) dayanır, `now`'a değil; `goOnline` throttle tüketmez.
   */
  updateLocation(driverId: string, update: LocationUpdate, now?: number): Promise<LocationResult>;
  /** Hash yoksa `offline`. */
  getStatus(driverId: string): Promise<DriverStatus>;
}

const isDriverStatus = (v: unknown): v is DriverStatus =>
  typeof v === 'string' && (DRIVER_STATUSES as readonly string[]).includes(v);

// Koordinatlar Redis'e string olarak gider; Number#toString her zaman nokta ondalık ayraç kullanır.
const num = (n: number) => String(n);

export function createPresence(redis: Redis): PresenceService {
  const goOnlineLua = defineLua(redis, 'dnPresenceGoOnline', 3, GO_ONLINE);
  const goOfflineLua = defineLua(redis, 'dnPresenceGoOffline', 3, GO_OFFLINE);
  const updateLocationLua = defineLua(redis, 'dnPresenceUpdateLocation', 4, UPDATE_LOCATION);
  const ttl = PRESENCE.DRIVER_HASH_TTL_S;

  const offline = (driverId: string, force: boolean) =>
    goOfflineLua(
      redisKeys.driver(driverId), redisKeys.geoAvailable, redisKeys.heartbeat,
      driverId, ttl, force ? '1' : '0',
    );

  return {
    async goOnline(driverId, location, now = Date.now()) {
      const r = await goOnlineLua(
        redisKeys.driver(driverId), redisKeys.geoAvailable, redisKeys.heartbeat,
        driverId, num(location.lat), num(location.lng), now, ttl,
      );
      return r === 'busy' ? 'busy' : 'available';
    },

    async goOffline(driverId) {
      const r = await offline(driverId, false);
      if (r === 'busy') throw new AppError(409, 'INVALID_TRANSITION', 'Aktif iş varken pasif moda geçilemez');
      return 'offline';
    },

    // Faz 3 notu: busy şoför de koşulsuz offline yapılır; hash'teki `rideId` ve eşleşmiş ride'ın
    // kendisi burada ele alınmaz. Askıya alınan şoförün aktif işinin ne olacağı Faz 3'te karara bağlanmalı.
    async forceOffline(driverId) {
      await offline(driverId, true);
    },

    async updateLocation(driverId, update, now = Date.now()) {
      const r = await updateLocationLua(
        redisKeys.driver(driverId), redisKeys.geoAvailable, redisKeys.heartbeat, redisKeys.locationThrottle(driverId),
        driverId, num(update.location.lat), num(update.location.lng),
        update.heading === undefined ? '' : num(update.heading),
        now, ttl, PRESENCE.LOCATION_THROTTLE_MS,
      );
      return r === 1 ? 'ok' : r === 0 ? 'throttled' : 'offline';
    },

    async getStatus(driverId) {
      const s = await redis.hget(redisKeys.driver(driverId), 'status');
      return isDriverStatus(s) ? s : 'offline';
    },
  };
}
