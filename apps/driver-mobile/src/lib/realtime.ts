// `/driver` namespace'ine tek socket bağlantısı. Arka plandaki konum görevi de socket'e yalnızca bu modül
// üzerinden erişir (tasarım 4.7). React Native'e bağımlı değildir.
import { io, type Socket } from 'socket.io-client';
import {
  COMMON_EVENTS,
  DRIVER_EVENTS,
  NAMESPACES,
  type Ack,
  type ErrorCode,
} from '@duraknet/shared';
import type { goOnlineSchema, locationUpdateSchema } from '@duraknet/shared';
import { ACK_TIMEOUT_MS } from './constants';
import type { AckOutcome } from './presence/transitions';

/** Sözleşme şemalarından türetilen gövde tipleri (elle tip yazılmaz). */
export type LocationUpdatePayload = ReturnType<typeof locationUpdateSchema.parse>;
export type GoOnlinePayload = ReturnType<typeof goOnlineSchema.parse>;

export type RealtimeHandlers = {
  onConnect(): void;
  onDisconnect(reason: string): void;
  /** `serverRejected`: sunucu ara katmanı reddetti; istemci kendiliğinden yeniden denemez. */
  onConnectError(err: { message: string; data?: unknown }, serverRejected: boolean): void;
  onSessionSync(payload: unknown): void;
  onAuthExpired(): void;
  /** Ride event'leri (Faz 3): payload'lar doğrulanmadan gelir; denetim ride servisindedir. */
  onRideRequested(payload: unknown): void;
  onRideTaken(payload: unknown): void;
  onRideAccepted(payload: unknown): void;
  onRideCancelled(payload: unknown): void;
  onRideCompleted(payload: unknown): void;
};

type AckEvent =
  | typeof DRIVER_EVENTS.goOnline
  | typeof DRIVER_EVENTS.goOffline
  | typeof DRIVER_EVENTS.sessionSyncRequest
  | typeof DRIVER_EVENTS.rideAccept
  | typeof DRIVER_EVENTS.rideDecline
  | typeof DRIVER_EVENTS.rideDriverCancel
  | typeof DRIVER_EVENTS.rideComplete
  | typeof COMMON_EVENTS.authRefresh;

let socket: Socket | null = null;

/** Socket'i kurar (bağlanmaz). Token her (yeniden) bağlanmada `getToken`'dan okunur. */
export function initRealtime(url: string, getToken: () => string | null, h: RealtimeHandlers) {
  closeRealtime();
  const s = io(`${url}${NAMESPACES.driver}`, {
    autoConnect: false,
    transports: ['websocket'],
    auth: (cb) => cb({ token: getToken() ?? '' }),
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 5_000,
  });
  s.on('connect', () => h.onConnect());
  s.on('disconnect', (reason) => h.onDisconnect(reason));
  s.on('connect_error', (err: Error & { data?: unknown }) => h.onConnectError(err, !s.active));
  s.on(COMMON_EVENTS.sessionSync, (p: unknown) => h.onSessionSync(p));
  s.on(COMMON_EVENTS.authExpired, () => h.onAuthExpired());
  s.on(DRIVER_EVENTS.rideRequested, (p: unknown) => h.onRideRequested(p));
  s.on(DRIVER_EVENTS.rideTaken, (p: unknown) => h.onRideTaken(p));
  s.on(DRIVER_EVENTS.rideAccepted, (p: unknown) => h.onRideAccepted(p));
  s.on(DRIVER_EVENTS.rideCancelled, (p: unknown) => h.onRideCancelled(p));
  s.on(DRIVER_EVENTS.rideCompleted, (p: unknown) => h.onRideCompleted(p));
  socket = s;
}

export function connectRealtime() {
  if (socket && !socket.connected) socket.connect();
}

export function closeRealtime() {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

export const isConnected = () => socket?.connected === true;

/**
 * Ack'li emit (kural 3.4-3): `socket.timeout(10_000).emitWithAck`. Bağlı değilken gönderilmez (tamponlanıp
 * yeniden bağlanınca gitmesin); bu durumda ve zaman aşımında `{ timeout: true }` döner = sonuç bilinmiyor.
 */
export async function emitAck<T>(event: AckEvent, payload: object): Promise<AckOutcome<T>> {
  const s = socket;
  if (!s?.connected) return { ok: false, timeout: true };
  try {
    const r = (await s.timeout(ACK_TIMEOUT_MS).emitWithAck(event, payload)) as Ack<T> | undefined;
    if (!r || typeof r !== 'object') return { ok: false, code: 'INTERNAL' };
    if (r.ok) return { ok: true, data: r.data };
    return { ok: false, code: (r.error?.code ?? 'INTERNAL') as ErrorCode };
  } catch {
    return { ok: false, timeout: true };
  }
}

/**
 * Konum (kural 3.4-2): `volatile` — kopukken tamponlanmaz; aksi halde yeniden bağlanınca eski konumlar
 * topluca gider ve sunucu kendi saatini yazdığı için taze sayılır. Yalnızca bağlıyken gönderilir.
 */
export function sendLocation(p: LocationUpdatePayload): boolean {
  const s = socket;
  if (!s?.connected) return false;
  s.volatile.emit(DRIVER_EVENTS.locationUpdate, p);
  return true;
}
