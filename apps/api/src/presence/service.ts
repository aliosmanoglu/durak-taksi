// Şoför varlığı (CLAUDE.md Bölüm 5, Senaryo 1–2). Konum yalnızca Redis'te tutulur; PG'ye yazılmaz.
// Durum okuyup ardından yazan işlemler (online/offline/konum) Lua ile atomiktir: aksi halde
// "status oku → MULTI" arasında gelen offline/sweep, şoförü yanlışlıkla GEO'ya geri yazar.
// Her durum geçişi `presenceVersion`'ı aynı script içinde artırır; offline geçişleri `offlineReason` yazar.
import type { Redis } from 'ioredis';
import {
  DRIVER_HASH,
  DRIVER_STATUSES,
  OFFLINE_REASONS,
  PRESENCE,
  redisKeys,
  type DriverStatus,
  type DriverStatusResult,
  type LatLng,
  type OfflineReason,
  type PresenceVersion,
} from '@duraknet/shared';
import { AppError } from '../http/errors';
import { defineLua, GO_OFFLINE, GO_ONLINE, READ_STATE, UPDATE_LOCATION, type StoredOfflineReason } from './scripts';

export type LocationUpdate = { location: LatLng; heading?: number };

/** Şoförün anlık varlık durumu (`session_sync` gövdesinin varlık kısmı). */
export type PresenceState = {
  status: DriverStatus;
  /** Yalnızca `status === 'offline'` iken bulunur. Hash yoksa / sebep yazılmamışsa `not_online`. */
  offlineReason?: OfflineReason;
  presenceVersion: PresenceVersion;
};

/** Konum yazılmadı çünkü şoför offline (hash yok, pasif, sweeper düşürmüş veya zorla çıkarılmış). */
export type OfflineLocationResult = {
  status: 'offline';
  offlineReason: OfflineReason;
  presenceVersion: PresenceVersion;
};

/**
 * `ok`: yazıldı. `throttled`: `LOCATION_THROTTLE_MS` içinde ikinci güncelleme, düştü.
 * Nesne: şoför offline — konum yazılmadı; istemci bunu bilmeli ki "Aktif" görünüp çağrı alamaz halde
 * kalmasın (realtime bu nesneyle `session_sync` gönderir; sebep + sürüm aynı Lua'dan gelir).
 */
export type LocationResult = 'ok' | 'throttled' | OfflineLocationResult;

/** `updateLocation` yazıldığında (`ok`) doldurulan ek bilgi: busy şoförün ride'ı (ek Redis turu olmadan). */
export type LocationOutcome = { status?: 'available' | 'busy'; rideId?: string };

export interface PresenceService {
  /**
   * `offline` → `available`; GEO'ya ve heartbeat'e yazar, `offlineReason`'ı siler, sürümü artırır.
   * `busy` şoför `busy` kalır ve sürüm değişmez (mevcut sürüm döner).
   */
  goOnline(driverId: string, location: LatLng, now?: number): Promise<DriverStatusResult>;
  /** `available` → `offline` (sebep `user`); GEO'dan çıkarır. `busy` iken `INVALID_TRANSITION` (AppError) fırlatır. */
  goOffline(driverId: string): Promise<DriverStatusResult>;
  /**
   * Hesap askıya alınınca / çıkış yapınca: durumdan bağımsız GEO'dan ve heartbeat'ten çıkarır,
   * `offline` yapar (sebep `forced`).
   */
  forceOffline(driverId: string): Promise<void>;
  /**
   * `/auth/logout` için (Faz 3 kararı a): `busy` şoföre dokunmaz (eşleşmiş ride etkilenmez; yeniden girişte
   * `session_sync.activeRide` ile devam eder), aksi halde `forceOffline` gibi offline yapar (sebep `forced`).
   * Döner: gerçekten offline yapıldı mı.
   */
  forceOfflineUnlessBusy(driverId: string): Promise<boolean>;
  /**
   * Hash + heartbeat'i günceller; yalnızca `available` ise GEO'ya yazar. `offline` şoförün konumu yok sayılır.
   * Durum kontrolü throttle'dan önce yapılır: offline şoförün güncellemesi throttle tüketmez.
   * Throttle Redis anahtarının TTL'ine (`SET NX PX`) dayanır, `now`'a değil; `goOnline` throttle tüketmez.
   */
  updateLocation(driverId: string, update: LocationUpdate, now?: number, out?: LocationOutcome): Promise<LocationResult>;
  /** Hash yoksa `offline`. */
  getStatus(driverId: string): Promise<DriverStatus>;
  /** Durum + sebep + sürüm tek atomik okumayla. Hash yoksa `offline` / `not_online` / Redis'in o anki zamanı. */
  getState(driverId: string): Promise<PresenceState>;
}

const isDriverStatus = (v: unknown): v is DriverStatus =>
  typeof v === 'string' && (DRIVER_STATUSES as readonly string[]).includes(v);

const isOfflineReason = (v: unknown): v is OfflineReason =>
  typeof v === 'string' && (OFFLINE_REASONS as readonly string[]).includes(v);

/** Lua'dan gelen ham alanları `PresenceState`'e çevirir. Eski veride sebep yoksa `not_online`. */
function toState(rawStatus: unknown, rawReason: unknown, rawVersion: unknown): PresenceState {
  const status = isDriverStatus(rawStatus) ? rawStatus : 'offline';
  const presenceVersion = Number(rawVersion);
  if (status !== 'offline') return { status, presenceVersion };
  // status alanı hiç yoksa (hash yok) hash'te kalmış bir sebep de anlamsızdır.
  const offlineReason = rawStatus === 'offline' && isOfflineReason(rawReason) ? rawReason : 'not_online';
  return { status, offlineReason, presenceVersion };
}

// Koordinatlar Redis'e string olarak gider; Number#toString her zaman nokta ondalık ayraç kullanır.
const num = (n: number) => String(n);

const USER: StoredOfflineReason = 'user';
const FORCED: StoredOfflineReason = 'forced';

export function createPresence(redis: Redis): PresenceService {
  const goOnlineLua = defineLua(redis, 'dnPresenceGoOnline', 4, GO_ONLINE);
  const goOfflineLua = defineLua(redis, 'dnPresenceGoOffline', 4, GO_OFFLINE);
  const updateLocationLua = defineLua(redis, 'dnPresenceUpdateLocation', 5, UPDATE_LOCATION);
  const readStateLua = defineLua(redis, 'dnPresenceReadState', 2, READ_STATE);
  const ttl = PRESENCE.DRIVER_HASH_TTL_S;

  const offline = async (driverId: string, force: boolean, reason?: StoredOfflineReason) => {
    const [status, version] = (await goOfflineLua(
      redisKeys.driver(driverId), redisKeys.geoAvailable, redisKeys.heartbeat, redisKeys.driverPresenceVersion(driverId),
      driverId, ttl, force ? '1' : '0', reason ?? (force ? FORCED : USER),
    )) as [string, number];
    return { status, presenceVersion: Number(version) };
  };

  return {
    async goOnline(driverId, location, now = Date.now()) {
      const [status, version] = (await goOnlineLua(
        redisKeys.driver(driverId), redisKeys.geoAvailable, redisKeys.heartbeat, redisKeys.driverPresenceVersion(driverId),
        driverId, num(location.lat), num(location.lng), now, ttl,
      )) as [string, number];
      return { status: status === 'busy' ? 'busy' : 'available', presenceVersion: Number(version) };
    },

    async goOffline(driverId) {
      const r = await offline(driverId, false);
      if (r.status === 'busy') throw new AppError(409, 'INVALID_TRANSITION', 'Aktif iş varken pasif moda geçilemez');
      return { status: 'offline', presenceVersion: r.presenceVersion };
    },

    // Askıya alma yolunda çağıran önce `RideService.releaseDriverForSuspension` çalıştırır (busy şoförün ride'ı
    // searching'e döner); burada kalan busy da koşulsuz offline yapılır. Çıkışta `forceOfflineUnlessBusy` kullanılır.
    async forceOffline(driverId) {
      await offline(driverId, true);
    },

    async forceOfflineUnlessBusy(driverId) {
      const r = await offline(driverId, false, FORCED);
      return r.status !== 'busy';
    },

    async updateLocation(driverId, update, now = Date.now(), out) {
      const r = (await updateLocationLua(
        redisKeys.driver(driverId), redisKeys.geoAvailable, redisKeys.heartbeat, redisKeys.locationThrottle(driverId),
        redisKeys.driverPresenceVersion(driverId),
        driverId, num(update.location.lat), num(update.location.lng),
        update.heading === undefined ? '' : num(update.heading),
        now, ttl, PRESENCE.LOCATION_THROTTLE_MS,
      )) as [number, string?, string?, number?];
      if (r[0] === 1) {
        if (out) {
          out.status = r[1] === 'busy' ? 'busy' : 'available';
          if (r[2]) out.rideId = r[2];
        }
        return 'ok';
      }
      if (r[0] === 0) return 'throttled';
      const s = toState(r[1], r[2], r[3]);
      // updateLocation yalnızca status available/busy değilken -1 döner; toState burada hep offline verir.
      return { status: 'offline', offlineReason: s.offlineReason ?? 'not_online', presenceVersion: s.presenceVersion };
    },

    async getStatus(driverId) {
      const s = await redis.hget(redisKeys.driver(driverId), DRIVER_HASH.status);
      return isDriverStatus(s) ? s : 'offline';
    },

    async getState(driverId) {
      const [status, reason, version] = (await readStateLua(redisKeys.driver(driverId), redisKeys.driverPresenceVersion(driverId))) as [string, string, number];
      return toState(status, reason, version);
    },
  };
}
