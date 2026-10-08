// CLAUDE.md Bölüm 6 — ortak tipler. Sözleşmenin tek kaynağı burasıdır.
import type { RideRequest, RideSnapshot } from './schemas';

export const RIDE_STATUSES = ['created', 'searching', 'matched', 'completed', 'cancelled'] as const;
export type RideStatus = (typeof RIDE_STATUSES)[number];

export const TERMINAL_RIDE_STATUSES: readonly RideStatus[] = ['completed', 'cancelled'];

export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'RIDE_NOT_AVAILABLE',
  'NOT_A_CANDIDATE',
  'DRIVER_NOT_AVAILABLE',
  'INVALID_TRANSITION',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_PENDING',
  'ACCOUNT_SUSPENDED',
  'CONFLICT',
  'NOT_FOUND',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type LatLng = { lat: number; lng: number };

export type Ack<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: { code: ErrorCode; message: string } };

export const DRIVER_STATUSES = ['offline', 'available', 'busy'] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

// RideRequest / RideSnapshot ve ride event payload tipleri zod şemalarından türetilir (schemas.ts).

/**
 * Şoförün neden `offline` olduğu (sunucu `dn:driver:{id}` hash'inde tutar):
 * - `user`: şoför `driver_go_offline` gönderdi.
 * - `stale_heartbeat`: sweeper, konum gelmediği için düşürdü.
 * - `forced`: askıya alma veya `/auth/logout` (`forceOffline`).
 * - `not_online`: hiç aktif olmadı ya da hash'in süresi doldu (kayıt yok).
 */
export const OFFLINE_REASONS = ['user', 'stale_heartbeat', 'forced', 'not_online'] as const;
export type OfflineReason = (typeof OFFLINE_REASONS)[number];

/**
 * Varlık durumunun sürümü: her durum geçişinde (online, offline, sweep, force) kesin artan sayı.
 * Redis `TIME`'dan türetilir (epoch ms, en az önceki + 1), hash'in süresi dolsa da geri gitmez.
 * İstemci aynı socket bağlantısında elindekinden küçük sürümlü `session_sync`'i / ack'i yok sayar.
 */
export type PresenceVersion = number;

/** `driver_go_online` / `driver_go_offline` ack verisi. Aktif işi olan şoför `busy` kalır. */
export type DriverStatusResult = { status: DriverStatus; presenceVersion: PresenceVersion };

/**
 * `session_sync` — her (yeniden) bağlanmada, offline şoför konum gönderdiğinde ve
 * `session_sync_request` ack'inde gelir; istemci state'ini bununla düzeltir.
 */
export type DriverSessionSync = {
  driverStatus: DriverStatus;
  /** Yalnızca `driverStatus === 'offline'` iken bulunur. */
  offlineReason?: OfflineReason;
  presenceVersion: PresenceVersion;
  /** Şoförün `matched` ride'ı varsa. */
  activeRide?: RideSnapshot;
  /** Şoföre gösterilen, hâlâ `searching` olan çağrılar (`dn:driver:{id}:requests`). */
  openRequests: RideRequest[];
  /** Sunucu saati (ISO-8601 `Z`); istemci cihaz saati farkını bununla hesaplar. */
  serverTime: string;
};
/** Durağın açık (`searching` / `matched`) ride'ları. `session_sync` ve `/stand` `session_sync_request` ack'i. */
export type StandSessionSync = { activeRides: RideSnapshot[]; serverTime: string };
