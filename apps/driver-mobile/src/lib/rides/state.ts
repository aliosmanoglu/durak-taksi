// Çağrı / yolculuk istemci durumu (docs/design/faz3-dispatch.md Bölüm 4). Saf veri; React Native'e bağımlı değildir.
import type { RideRequest, RideSnapshot } from '@duraknet/shared';

/** Şoföre gösterilen açık çağrı. `taken`: kabul denendi ama başkası aldı (kart kısa süre bu durumda kalır). */
export type OpenRequest = RideRequest & { taken?: boolean };

/** REDDET sonrası 4 sn bekleyen ret (Q3): süre dolunca `ride_decline` gönderilir, GERİ AL ile iptal edilir. */
export type PendingDecline = { request: OpenRequest; sendAt: number };

/** Kabul sürüyor. `timedOut`: 10 sn içinde yanıt gelmedi; sonucu bir sonraki `session_sync` belirler. */
export type Accepting = { rideId: string; timedOut: boolean };

/** D3 (Yolculuk kapandı) içeriği. */
export type RideClosed = {
  kind: 'cancelled' | 'completedByStand' | 'completed';
  shortCode: string;
  reason?: string;
};

/** Eşleşmiş yolculukta süren kullanıcı eylemi. */
export type RideAction = 'completing' | 'cancelling' | null;

export type RidesState = {
  /** Açık çağrılar; yakından uzağa sıralı. */
  requests: OpenRequest[];
  /** Odaklı kart. */
  focusedId: string | null;
  /** Henüz odağa alınmamış (YENİ rozetli) çağrılar. */
  unseen: string[];
  /** KABUL/REDDET bu ana kadar kilitli (700 ms). */
  actionLockedUntil: number;
  accepting: Accepting | null;
  pendingDecline: PendingDecline | null;
  /** Ride başına görülen en yüksek `version` (düşük sürümlü event'i yok saymak için). */
  rideVersions: Record<string, number>;
  /** Eşleşmiş (`matched`) kendi yolculuğum. */
  activeRide: RideSnapshot | null;
  rideAction: RideAction;
  /** D2'de düğme altında kırmızı olmayan satır içi mesaj. */
  rideMessage: string | null;
  closed: RideClosed | null;
  /** Sunucu saati − cihaz saati (ms). */
  clockOffsetMs: number;
  /** Çağrı sesi (Hesap'ta anahtar, Q6); varsayılan açık. Kalıcıdır. */
  soundEnabled: boolean;
};

export const initialRides = (persisted?: { soundEnabled?: boolean; activeRide?: RideSnapshot | null }): RidesState => ({
  requests: [],
  focusedId: null,
  unseen: [],
  actionLockedUntil: 0,
  accepting: null,
  pendingDecline: null,
  rideVersions: persisted?.activeRide ? { [persisted.activeRide.rideId]: persisted.activeRide.version } : {},
  activeRide: persisted?.activeRide ?? null,
  rideAction: null,
  rideMessage: null,
  closed: null,
  clockOffsetMs: 0,
  soundEnabled: persisted?.soundEnabled ?? true,
});

/** Yakından uzağa; eşitse eskiden yeniye. */
export function sortRequests<T extends { distanceM: number; createdAt: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.distanceM - b.distanceM || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
