// Kullanıcı eylemleri: çağrı oluşturma, iptal, durak tamamlama, ayarlar. UI bu fonksiyonları çağırır;
// sonuçlar kullanıcıya anlaşılır Türkçe metinle döner (ham hata kodu gösterilmez).
import {
  STAND_EVENTS,
  rideCreateResultSchema,
  type LatLng,
  type RideCreateResult,
} from '@duraknet/shared';
import { errorText, T } from '../lib/texts';
import { applyCreated, closeLocal, setUnknown } from '../lib/rides';
import { pushRecent } from '../lib/recent-addresses';
import { pushToast, updateRides, useStore } from '../store';
import { handleAuthCode, emitAck, markQuiet, requestSync, serverNow } from './realtime';
import { apiAuthed } from './session';
import { saveMe, saveRecent } from './storage';
import type { Me } from './types';

export const CREATE_LOCK_MS = 15_000;

export type CreateInput = {
  pickup: LatLng;
  pickupAddress: string;
  dropoff?: LatLng;
  dropoffAddress?: string;
  notes?: string;
};

export type CreateOutcome = { ok: true } | { ok: false; message: string; field?: 'validation' };

export async function createRide(input: CreateInput): Promise<CreateOutcome> {
  const st = useStore.getState();
  if (st.conn !== 'connected') return { ok: false, message: T.form.offline };
  const lockLeft = st.createLockUntil - Date.now();
  if (lockLeft > 0) return { ok: false, message: T.form.locked(Math.ceil(lockLeft / 1000)) };

  const payload = {
    pickup: input.pickup,
    pickupAddress: input.pickupAddress.trim(),
    ...(input.dropoff ? { dropoff: input.dropoff } : {}),
    ...(input.dropoffAddress?.trim() ? { dropoffAddress: input.dropoffAddress.trim() } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };
  const knownIds = Object.keys(st.ridesState.rides);
  const res = await emitAck<RideCreateResult>(STAND_EVENTS.rideCreate, payload);

  if (res.ok) {
    const parsed = rideCreateResultSchema.safeParse(res.data);
    if (!parsed.success) return { ok: false, message: T.form.err.internal };
    const { rideId, shortCode } = parsed.data;
    updateRides((s) =>
      applyCreated(
        s,
        { rideId, shortCode, pickup: payload.pickup, pickupAddress: payload.pickupAddress, dropoffAddress: payload.dropoffAddress, notes: payload.notes },
        serverNow(),
      ),
    );
    const recent = pushRecent(useStore.getState().recent, { address: payload.pickupAddress, location: payload.pickup });
    saveRecent(recent);
    const cur = useStore.getState();
    cur.set({ recent, formNonce: cur.formNonce + 1, pendingCreate: null });
    pushToast(T.form.created(shortCode), 'info');
    return { ok: true };
  }

  if (res.code === 'TIMEOUT') {
    // Sonuç bilinmiyor: yinelenen çağrıyı önlemek için 15 sn kilit; liste senkronla doğrulanır.
    useStore.getState().set({
      createLockUntil: Date.now() + CREATE_LOCK_MS,
      pendingCreate: { pickupAddress: payload.pickupAddress, pickup: payload.pickup, knownIds, sentAtMs: Date.now() },
    });
    requestSync();
    return { ok: false, message: T.form.timeout };
  }
  if (handleAuthCode(res.code)) return { ok: false, message: errorText(res.code) };
  if (res.code === 'NETWORK') return { ok: false, message: T.form.offline };
  if (res.code === 'VALIDATION_ERROR') return { ok: false, message: T.form.err.validation, field: 'validation' };
  if (res.code === 'RATE_LIMITED') return { ok: false, message: T.form.err.rateLimited };
  return { ok: false, message: T.form.err.internal };
}

export type CloseOutcome =
  | { kind: 'ok' }
  | { kind: 'changed' }
  | { kind: 'unknown' }
  | { kind: 'error'; message: string };

function rideVersion(rideId: string): number | null {
  const r = useStore.getState().ridesState.rides[rideId];
  return r ? r.version : null;
}

/** `ride_cancel`: yerel iyimser güncelleme yok; ack ya da `ride_cancelled` event'i beklenir. */
export async function cancelRide(rideId: string, reason?: string): Promise<CloseOutcome> {
  const version = rideVersion(rideId);
  if (version === null) return { kind: 'changed' };
  const r = reason?.trim();
  const res = await emitAck(STAND_EVENTS.rideCancel, { rideId, version, ...(r ? { reason: r.slice(0, 120) } : {}) });
  if (res.ok) {
    updateRides((s) => closeLocal(s, rideId, 'cancelled', serverNow(), r));
    return { kind: 'ok' };
  }
  if (res.code === 'TIMEOUT') {
    updateRides((s) => setUnknown(s, rideId, true));
    requestSync();
    return { kind: 'unknown' };
  }
  if (res.code === 'INVALID_TRANSITION' || res.code === 'VERSION_CONFLICT' || res.code === 'NOT_FOUND') {
    // Başka tablet ya da şoför önce davrandı: durum senkronla düzelir; "siz yokken kapandı" demeyiz.
    markQuiet(rideId);
    requestSync();
    return { kind: 'changed' };
  }
  if (handleAuthCode(res.code)) return { kind: 'error', message: errorText(res.code) };
  return { kind: 'error', message: errorText(res.code) };
}

/** Durak tamamlama (E-1). Şoför aynı anda tamamladıysa sonuç aynıdır: hata gösterilmez. */
export async function completeRide(rideId: string): Promise<CloseOutcome> {
  const version = rideVersion(rideId);
  if (version === null) return { kind: 'changed' };
  const res = await emitAck(STAND_EVENTS.rideComplete, { rideId, version });
  if (res.ok) {
    updateRides((s) => closeLocal(s, rideId, 'completed', serverNow()));
    return { kind: 'ok' };
  }
  if (res.code === 'TIMEOUT') {
    updateRides((s) => setUnknown(s, rideId, true));
    requestSync();
    return { kind: 'unknown' };
  }
  if (res.code === 'INVALID_TRANSITION') {
    // Neden bilinmiyor (şoför tamamladı, durak iptal etti ya da şoför bıraktı): iyimser kapatma yok;
    // senkron gerçeği getirir, kullanıcıya "durum değişti" denir.
    markQuiet(rideId);
    requestSync();
    return { kind: 'changed' };
  }
  if (res.code === 'VERSION_CONFLICT' || res.code === 'NOT_FOUND') {
    markQuiet(rideId);
    requestSync();
    return { kind: 'changed' };
  }
  handleAuthCode(res.code);
  return { kind: 'error', message: errorText(res.code) };
}

export type SettingsOutcome = { ok: true } | { ok: false; message: string };

export async function saveRadius(initialRadiusM: number, maxRadiusM: number): Promise<SettingsOutcome> {
  if (maxRadiusM < initialRadiusM) return { ok: false, message: T.settings.err.range };
  const res = await apiAuthed<{ initialRadiusM: number; maxRadiusM: number }>('PATCH', '/stands/me/settings', {
    initialRadiusM,
    maxRadiusM,
  });
  if (res.ok) {
    const me = useStore.getState().me;
    if (me) {
      const next: Me = { ...me, initialRadiusM: res.data.initialRadiusM, maxRadiusM: res.data.maxRadiusM };
      saveMe(next);
      useStore.getState().set({ me: next });
    }
    return { ok: true };
  }
  if (res.kind === 'network') return { ok: false, message: T.err.network };
  if (res.code === 'VALIDATION_ERROR') return { ok: false, message: T.settings.err.range };
  return { ok: false, message: T.err.server };
}
