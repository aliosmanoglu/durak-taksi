// Sunucu → istemci ride payload'larının denetimi (S → C yönü; sözleşme şemaları `packages/shared`'dan).
// Tanınmayan gövde `null` döner ve yok sayılır; hiçbir şey fırlatılmaz.
import {
  rideCancelledSchema,
  rideCompletedSchema,
  rideRequestSchema,
  rideSnapshotSchema,
  rideTakenSchema,
  type RideCancelledEvent,
  type RideCompletedEvent,
  type RideRequest,
  type RideSnapshot,
  type RideTakenEvent,
} from '@duraknet/shared';

export const parseRideRequest = (p: unknown): RideRequest | null => {
  const r = rideRequestSchema.safeParse(p);
  return r.success ? r.data : null;
};

export const parseRideSnapshot = (p: unknown): RideSnapshot | null => {
  const r = rideSnapshotSchema.safeParse(p);
  return r.success ? r.data : null;
};

export const parseRideTaken = (p: unknown): RideTakenEvent | null => {
  const r = rideTakenSchema.safeParse(p);
  return r.success ? r.data : null;
};

export const parseRideCancelled = (p: unknown): RideCancelledEvent | null => {
  const r = rideCancelledSchema.safeParse(p);
  return r.success ? r.data : null;
};

export const parseRideCompleted = (p: unknown): RideCompletedEvent | null => {
  const r = rideCompletedSchema.safeParse(p);
  return r.success ? r.data : null;
};

/** `session_sync`'in ride kısmı: geçersiz öğeler tek tek atılır (biri bozuksa tüm liste kaybolmasın). */
export type RideSyncParts = {
  openRequests: RideRequest[];
  activeRide?: RideSnapshot;
  /** `activeRide` geldi ama şemaya uymadı: yerel yolculuk korunur (bozuk gövde yolculuğu silmesin). */
  activeRideInvalid?: boolean;
  serverTime?: string;
};

export function parseRideSync(p: unknown): RideSyncParts {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const openRequests = Array.isArray(o.openRequests)
    ? o.openRequests.map(parseRideRequest).filter((r): r is RideRequest => r !== null)
    : [];
  const activeRide = o.activeRide != null ? parseRideSnapshot(o.activeRide) : null;
  return {
    openRequests,
    ...(activeRide ? { activeRide } : {}),
    ...(o.activeRide != null && !activeRide ? { activeRideInvalid: true } : {}),
    ...(typeof o.serverTime === 'string' ? { serverTime: o.serverTime } : {}),
  };
}
