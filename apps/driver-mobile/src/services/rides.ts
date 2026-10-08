// Çağrı / yolculuk akışlarının yürütücüsü: saf geçişleri (src/lib/rides/transitions) çağırır, yamayı store'a yazar
// ve yan etkileri (socket emit, ses, haptik, bildirim, zamanlayıcı, kalıcı kayıt) uygular.
// Event adları ve payload tipleri yalnızca `@duraknet/shared`'dandır.
import { AccessibilityInfo } from 'react-native';
import * as Haptics from 'expo-haptics';
import { DRIVER_EVENTS, type RideAcceptAck, type RideCompletedEvent } from '@duraknet/shared';
import { log } from '@/lib/log';
import { emitAck } from '@/lib/realtime';
import {
  parseRideCancelled,
  parseRideAcceptAck,
  parseRideCompleted,
  parseRideRequest,
  parseRideSnapshot,
  parseRideSync,
  parseRideTaken,
} from '@/lib/rides/parse';
import {
  applyRideSync,
  beginAccept,
  beginComplete,
  beginDecline,
  beginDriverCancel,
  clearRequests,
  dismissClosed as dismissClosedStep,
  clearRideMessage,
  expireTaken,
  flushDecline,
  focusRequest,
  markFocusedSeen,
  onAcceptAck,
  onCompleteAck,
  onDeclineAck,
  onDriverCancelAck,
  onRideAccepted,
  onRideCancelled,
  onRideCompleted,
  onRideRequested,
  onRideTaken,
  undoDecline,
  type AcceptOutcome,
  type ActionOutcome,
  type RideEffect,
  type RideStep,
} from '@/lib/rides/transitions';
import type { AckOutcome } from '@/lib/presence/transitions';
import type { OpenRequest } from '@/lib/rides/state';
import { showToast, store, type AppState } from '@/lib/store';
import { notifyLocal } from './notify';
import * as presence from './presence';
import { startRing, stopRing } from './ringer';
import { storage } from './storage';

const get = () => store.getState();

/** Yamayı store'a yazar ve yan etkileri uygular (eşzamanlı; emit'ler arka planda sürer). */
function run(step: RideStep) {
  const keys = Object.keys(step.patch);
  if (keys.length > 0) store.setState(step.patch as Partial<AppState>);
  for (const e of step.effects) {
    try {
      runEffect(e);
    } catch (err) {
      log('rides.effect_failed', { type: e.type, error: err instanceof Error ? err.name : 'unknown' });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Zamanlayıcılar (ret gecikmesi, "başka şoföre gitti" kartı)

let declineTimer: ReturnType<typeof setTimeout> | undefined;
const takenTimers = new Map<string, ReturnType<typeof setTimeout>>();

function runEffect(e: RideEffect) {
  switch (e.type) {
    case 'emitAccept':
      void emitAccept(e.rideId);
      return;
    case 'emitDecline':
      void emitDecline(e.rideId, e.request);
      return;
    case 'emitComplete':
      void emitComplete(e.rideId, e.version);
      return;
    case 'emitDriverCancel':
      void emitDriverCancel(e.rideId, e.version, e.reason);
      return;
    case 'scheduleDeclineFlush':
      clearTimeout(declineTimer);
      declineTimer = setTimeout(() => run(flushDecline(get(), e.rideId)), e.delayMs);
      return;
    case 'cancelDeclineFlush':
      clearTimeout(declineTimer);
      declineTimer = undefined;
      return;
    case 'scheduleTakenRemoval': {
      clearTimeout(takenTimers.get(e.rideId));
      takenTimers.set(
        e.rideId,
        setTimeout(() => {
          takenTimers.delete(e.rideId);
          run(expireTaken(get(), e.rideId, Date.now()));
        }, e.delayMs),
      );
      return;
    }
    case 'ring':
      // Yalnızca ön planda çalar (arka planı Faz 5 push üstlenir).
      if (get().appActive) startRing(e.kind);
      return;
    case 'stopRing':
      stopRing();
      return;
    case 'haptic':
      void Haptics.notificationAsync(
        e.kind === 'success' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
      ).catch(() => {});
      return;
    case 'toast':
      showToast(e.text, e.ms);
      return;
    case 'announce':
      AccessibilityInfo.announceForAccessibility(e.text);
      return;
    case 'localNotify':
      if (!get().appActive) void notifyLocal(e.text);
      return;
    case 'requestSync':
      void presence.requestSync();
      return;
    case 'persistActiveRide':
      void storage.setActiveRide(e.ride);
      return;
    case 'sessionEnd':
      presence.requestSessionEnd(e.reason);
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Socket emit'leri (ack'li; 10 sn zaman aşımı = sonuç bilinmiyor)

async function emitAccept(rideId: string) {
  const r = await emitAck<RideAcceptAck>(DRIVER_EVENTS.rideAccept, { rideId });
  let outcome: AcceptOutcome;
  if (r.ok) {
    // Başarılı ack'in gövdesi bozuksa sonuç "bilinmiyor" sayılır; session_sync belirler.
    const ack = parseRideAcceptAck(r.data);
    outcome = ack ? { kind: 'ok', ride: ack.ride, presenceVersion: ack.presenceVersion } : { kind: 'timeout' };
  } else if ('timeout' in r) outcome = { kind: 'timeout' };
  else outcome = { kind: 'error', code: r.code };
  log('rides.accept', { result: outcome.kind === 'error' ? outcome.code : outcome.kind });
  run(onAcceptAck(get(), rideId, outcome, Date.now()));
}

async function emitDecline(rideId: string, request: OpenRequest) {
  const r = await emitAck<undefined>(DRIVER_EVENTS.rideDecline, { rideId });
  run(onDeclineAck(get(), request, r, Date.now()));
}

function actionOutcome(r: AckOutcome<{ version: number }>): ActionOutcome {
  if (r.ok) return { kind: 'ok', ...(typeof r.data?.version === 'number' ? { version: r.data.version } : {}) };
  if ('timeout' in r) return { kind: 'timeout' };
  return { kind: 'error', code: r.code };
}

async function emitComplete(rideId: string, version: number) {
  const r = await emitAck<RideCompletedEvent>(DRIVER_EVENTS.rideComplete, { rideId, version });
  const o = actionOutcome(r);
  log('rides.complete', { result: o.kind === 'error' ? o.code : o.kind });
  run(onCompleteAck(get(), o));
}

async function emitDriverCancel(rideId: string, version: number, reason?: string) {
  const r = await emitAck<{ rideId: string; version: number }>(DRIVER_EVENTS.rideDriverCancel, {
    rideId,
    version,
    ...(reason ? { reason } : {}),
  });
  const o = actionOutcome(r);
  log('rides.driver_cancel', { result: o.kind === 'error' ? o.code : o.kind });
  run(onDriverCancelAck(get(), o));
}

// ---------------------------------------------------------------------------------------------
// Sunucu event'leri (payload doğrulanır; bozuk gövde yok sayılır)

export function handleRideRequested(payload: unknown) {
  const req = parseRideRequest(payload);
  if (!req) return void log('rides.invalid', { event: 'ride_requested' });
  run(onRideRequested(get(), req, Date.now()));
}

export function handleRideTaken(payload: unknown) {
  const ev = parseRideTaken(payload);
  if (!ev) return void log('rides.invalid', { event: 'ride_taken' });
  run(onRideTaken(get(), ev.rideId, ev.version, Date.now()));
}

export function handleRideAccepted(payload: unknown) {
  const ride = parseRideSnapshot(payload);
  if (!ride) return void log('rides.invalid', { event: 'ride_accepted' });
  run(onRideAccepted(get(), ride));
}

export function handleRideCancelled(payload: unknown) {
  const ev = parseRideCancelled(payload);
  if (!ev) return void log('rides.invalid', { event: 'ride_cancelled' });
  run(onRideCancelled(get(), ev, Date.now()));
}

export function handleRideCompleted(payload: unknown) {
  const ev = parseRideCompleted(payload);
  if (!ev) return void log('rides.invalid', { event: 'ride_completed' });
  run(onRideCompleted(get(), ev));
}

// `session_sync` (presence servisi sürüm kapısından geçirdikten sonra çağırır): ride durumunu değiştirir.
presence.setSyncListener((payload) => run(applyRideSync(get(), parseRideSync(payload), Date.now())));

// Yerel varlık `available` dışına çıkınca (pasif / eşleşmiş) çağrı listesi, bekleyen ret ve kabul temizlenir.
store.subscribe((s) => {
  if ((s.server === 'offline' || s.server === 'busy') && (s.requests.length > 0 || s.pendingDecline || s.accepting)) {
    run(clearRequests(s));
  }
});

// ---------------------------------------------------------------------------------------------
// Ekranların eylemleri

export const acceptRide = (rideId: string) => run(beginAccept(get(), rideId, Date.now()));
export const declineRide = (rideId: string) => run(beginDecline(get(), rideId, Date.now()));
export const undoDeclineRide = () => run(undoDecline(get(), Date.now()));
export const focusOnRequest = (rideId: string) => run(focusRequest(get(), rideId, Date.now()));
export const markRequestsViewed = () => run(markFocusedSeen(get()));
export const completeRide = () => run(beginComplete(get()));
export const cancelActiveRide = (reason?: string) => run(beginDriverCancel(get(), reason));
export const dismissClosed = () => run(dismissClosedStep());
export const clearRideNotice = () => run(clearRideMessage());

/** Hesap'taki "Çağrı sesi" anahtarı (Q6). */
export function setSoundEnabled(on: boolean) {
  store.setState({ soundEnabled: on });
  void storage.setSoundEnabled(on);
  if (!on) stopRing();
}

/** Oturum kapanınca (çıkış / oturum sonu): zamanlayıcılar ve ses durur. */
export function resetRideServices() {
  clearTimeout(declineTimer);
  declineTimer = undefined;
  for (const t of takenTimers.values()) clearTimeout(t);
  takenTimers.clear();
  stopRing();
}

