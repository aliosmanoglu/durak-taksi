// `/stand` socket'i (docs/design/faz3-dispatch.md 3.3, 3.6). Kurallar:
// - Event adları ve payload şemaları yalnızca @duraknet/shared'dan gelir.
// - Ride içeren her event version kapısından geçer (lib/rides.ts); düşük sürüm yok sayılır.
// - Her (yeniden) bağlantıda `session_sync` listeyi değiştirir; gelmezse `session_sync_request` istenir.
// - Loglara ham konum / telefon yazılmaz (burada hiç log yok).
import { io, type Socket } from 'socket.io-client';
import { z } from 'zod';
import {
  COMMON_EVENTS,
  NAMESPACES,
  STAND_EVENTS,
  nearbyDriversSchema,
  RIDE_ROOM_EVENTS,
  rideDriverLocationSchema,
  rideCancelledSchema,
  rideCompletedSchema,
  rideDriverCancelledSchema,
  rideMatchedSchema,
  rideSearchingSchema,
  standSessionSyncSchema,
  rideStillOpenSchema,
  type Ack,
  type ErrorCode,
} from '@duraknet/shared';
import { computeClockOffset } from '../lib/clock';
import { applyDriverLocation, seedFromSync } from '../lib/driver-locations';
import {
  applyCancelled,
  applyCompleted,
  applyDriverCancelled,
  applyMatched,
  applySearching,
  applySessionSync,
  applyStillOpen,
  needsDetailSync,
  type RidesState,
} from '../lib/rides';
import { isErrorCode } from '../lib/api-result';
import { T } from '../lib/texts';
import { announce, noteAlert, pushToast, updateRides, useStore } from '../store';
import { ACK_TIMEOUT_MS, API_URL } from './config';
import { playSound } from './audio';
import { createConnectionCore } from './connection-core';
import { endSession, getAccessToken, onAuthed, onEnded, onToken, refreshAccess } from './session';

const SYNC_WAIT_MS = 5_000;
const NEARBY_STALE_MS = 25_000;
const PENDING_CREATE_TTL_MS = 60_000;

let socket: Socket | null = null;
let detailTimer: ReturnType<typeof setTimeout> | undefined;
let nearbyTimer: ReturnType<typeof setInterval> | undefined;
let syncInflight = false;
/** Kullanıcıya zaten "durum değişti" denen ride'lar: bir sonraki senkronda "siz yokken kapandı" sayılmaz. */
const quiet = new Set<string>();

export const markQuiet = (rideId: string) => void quiet.add(rideId);

/** Sunucu saatine göre düzeltilmiş şimdi (epoch ms). */
export const serverNow = (): number => Date.now() + useStore.getState().clockOffset;

export type EmitResult<T> = { ok: true; data: T } | { ok: false; code: ErrorCode | 'TIMEOUT' | 'NETWORK' };

/** Ack'li emit; 10 sn içinde yanıt gelmezse `TIMEOUT` ("sonuç bilinmiyor" — son söz session_sync'tir). */
export function emitAck<T = undefined>(event: string, payload: unknown): Promise<EmitResult<T>> {
  const s = socket;
  if (!s || !s.connected) return Promise.resolve({ ok: false, code: 'NETWORK' });
  return new Promise((resolve) => {
    s.timeout(ACK_TIMEOUT_MS).emit(event, payload, (err: Error | null, res?: Ack<T>) => {
      if (err || !res) return resolve({ ok: false, code: 'TIMEOUT' });
      if (res.ok) return resolve({ ok: true, data: res.data as T });
      const code = res.error?.code;
      resolve({ ok: false, code: isErrorCode(code) ? code : 'INTERNAL' });
    });
  });
}

const core = createConnectionCore({
  getSocket: () => socket,
  refreshAccess,
  endSession,
  setConn: (conn) => useStore.getState().set({ conn }),
  requestSync: (onFail) => requestSync(onFail),
  syncWaitMs: SYNC_WAIT_MS,
});

/** Oturum hatası ack'leri (UNAUTHORIZED / ACCOUNT_*) oturum akışına yönlendirir. Ele alındıysa `true`. */
export const handleAuthCode = core.handleAuthCode;

function handleSync(raw: unknown): void {
  const p = standSessionSyncSchema.safeParse(raw);
  if (!p.success) return;
  core.onSync();
  const st = useStore.getState();
  const offset = computeClockOffset(p.data.serverTime, Date.now());
  if (offset !== st.clockOffset) st.set({ clockOffset: offset });
  let closed = 0;
  updateRides((prev) => {
    const r = applySessionSync(prev, p.data.activeRides, Date.now() + offset, quiet);
    closed = r.closed;
    return r.state;
  });
  {
    // session_sync'teki driver.location ilk konumdur (ride'lar yukarıda güncellendi).
    const cur = useStore.getState();
    const seeded = seedFromSync(cur.driverLocs, p.data.activeRides, Date.now());
    if (seeded !== cur.driverLocs) cur.set({ driverLocs: seeded });
  }
  quiet.clear();
  if (closed > 0) pushToast(T.list.closedWhileAway(closed), 'warn');
  resolvePendingCreate();
}

/** `ride_create` zaman aşımından sonra: yeni çağrı listede göründüyse form sıfırlanır, kilit kalkar. */
function resolvePendingCreate(): void {
  const st = useStore.getState();
  const pc = st.pendingCreate;
  if (!pc) return;
  if (Date.now() - pc.sentAtMs > PENDING_CREATE_TTL_MS) return st.set({ pendingCreate: null });
  const found = Object.values(st.ridesState.rides).find(
    (r) => !pc.knownIds.includes(r.rideId) && !r.detailsMissing && r.pickupAddress === pc.pickupAddress,
  );
  if (!found) return;
  st.set({ pendingCreate: null, createLockUntil: 0, formNonce: st.formNonce + 1 });
  pushToast(T.form.created(found.shortCode), 'info');
}

/** Bağlıyken güncel durumu iste (E-5). Bağlı değilse yeniden bağlanmayı dener. */
export function requestSync(onFail?: () => void): void {
  const s = socket;
  if (!s) return;
  if (!s.connected) return void s.connect();
  if (syncInflight) return;
  syncInflight = true;
  s.timeout(ACK_TIMEOUT_MS).emit(STAND_EVENTS.sessionSyncRequest, {}, (err: Error | null, res?: Ack<unknown>) => {
    syncInflight = false;
    if (err || !res || !res.ok) return onFail?.();
    handleSync(res.data);
  });
}

function ensureDetails(): void {
  clearTimeout(detailTimer);
  if (!needsDetailSync(useStore.getState().ridesState)) return;
  // Ack henüz dönmemiş olabilir; kısa bekleyip hâlâ eksikse sunucudan iste.
  detailTimer = setTimeout(() => {
    if (needsDetailSync(useStore.getState().ridesState)) requestSync();
  }, 1_500);
}

function rideEvent<S extends z.ZodType>(
  schema: S,
  apply: (data: z.infer<S>, nowMs: number) => (s: RidesState) => RidesState,
  after?: (data: z.infer<S>, changed: boolean) => void,
) {
  return (raw: unknown) => {
    const p = schema.safeParse(raw);
    if (!p.success) return;
    const before = useStore.getState().ridesState;
    updateRides(apply(p.data, serverNow()));
    after?.(p.data, useStore.getState().ridesState !== before);
    ensureDetails();
  };
}

const codeOf = (rideId: string) => useStore.getState().ridesState.rides[rideId]?.shortCode ?? '';

function bind(s: Socket): void {
  s.on('connect', core.onConnect);
  s.on('disconnect', core.onDisconnect);
  s.on('connect_error', core.onConnectError);
  s.on(COMMON_EVENTS.authExpired, core.onAuthExpired);

  s.on(COMMON_EVENTS.sessionSync, handleSync);

  s.on(
    STAND_EVENTS.rideSearching,
    rideEvent(rideSearchingSchema, (e, now) => (st) => applySearching(st, e, now)),
  );
  s.on(
    STAND_EVENTS.rideMatched,
    rideEvent(
      rideMatchedSchema,
      (e, now) => (st) => applyMatched(st, e, now),
      (e, changed) => {
        if (!changed) return;
        playSound('matched');
        noteAlert();
        announce(T.a11y.matched(codeOf(e.rideId), e.driver.name, e.driver.plate));
      },
    ),
  );
  s.on(
    STAND_EVENTS.rideDriverCancelled,
    rideEvent(
      rideDriverCancelledSchema,
      (e, now) => (st) => applyDriverCancelled(st, e, now),
      (e, changed) => {
        if (!changed) return;
        playSound('driverCancelled');
        noteAlert();
        announce(T.a11y.driverCancelled(codeOf(e.rideId), e.driverName));
      },
    ),
  );
  s.on(
    STAND_EVENTS.rideStillOpen,
    rideEvent(
      rideStillOpenSchema,
      (e, now) => (st) => applyStillOpen(st, e, now),
      (e, changed) => {
        if (!changed) return;
        playSound('stillOpen');
        noteAlert();
        announce(T.a11y.stillOpen(codeOf(e.rideId), e.minutesOpen));
      },
    ),
  );
  s.on(
    STAND_EVENTS.rideCompleted,
    rideEvent(rideCompletedSchema, (e, now) => (st) => applyCompleted(st, e, now)),
  );
  s.on(
    STAND_EVENTS.rideCancelled,
    rideEvent(rideCancelledSchema, (e, now) => (st) => applyCancelled(st, e, now)),
  );

  s.on(RIDE_ROOM_EVENTS.driverLocation, (raw: unknown) => {
    const p = rideDriverLocationSchema.safeParse(raw);
    if (!p.success) return;
    const st = useStore.getState();
    const next = applyDriverLocation(st.driverLocs, st.ridesState, p.data, Date.now());
    if (next !== st.driverLocs) st.set({ driverLocs: next });
  });

  s.on(STAND_EVENTS.nearbyDrivers, (raw: unknown) => {
    const p = nearbyDriversSchema.safeParse(raw);
    if (p.success) useStore.getState().set({ nearby: { drivers: p.data.drivers, atMs: Date.now() } });
  });
}

function connect(): void {
  if (socket) return;
  useStore.getState().set({ conn: 'connecting' });
  const s = io(`${API_URL}${NAMESPACES.stand}`, {
    // Her (yeniden) bağlantıda güncel access token okunur.
    auth: (cb) => cb({ token: getAccessToken() ?? '' }),
    reconnection: true,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 5_000,
  });
  socket = s;
  bind(s);
  clearInterval(nearbyTimer);
  // Bayat veri gösterilmez: 25 sn `stand_nearby_drivers` gelmezse simgeler kalkar, sayaç "–" olur.
  nearbyTimer = setInterval(() => {
    const n = useStore.getState().nearby;
    if (n && Date.now() - n.atMs > NEARBY_STALE_MS) useStore.getState().set({ nearby: null });
  }, 5_000);
}

function disconnect(): void {
  core.dispose();
  clearTimeout(detailTimer);
  clearInterval(nearbyTimer);
  quiet.clear();
  syncInflight = false;
  const s = socket;
  socket = null;
  s?.removeAllListeners();
  s?.disconnect();
}

/** Bir kez, uygulama açılırken çağrılır: oturum olaylarına ve sekme/ağ olaylarına bağlanır. */
export function initRealtime(): void {
  onAuthed(connect);
  onEnded(disconnect);
  onToken((token) => {
    // Access yenilendi: bağlantıyı koparmadan `auth_refresh` (auth_expired'a da yanıt).
    const s = socket;
    if (!s) return;
    if (!s.connected) return void s.connect(); // yeni token'la (auth callback güncel token'ı okur) yeniden bağlan
    s.timeout(ACK_TIMEOUT_MS).emit(COMMON_EVENTS.authRefresh, { token }, (err: Error | null, res?: Ack) => {
      if (err || !res) return;
      if (!res.ok) handleAuthCode(isErrorCode(res.error?.code) ? res.error.code : 'INTERNAL');
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !socket) return;
    if (!socket.connected) socket.connect();
    else requestSync();
  });
  window.addEventListener('online', () => {
    if (socket && !socket.connected) socket.connect();
  });
}
