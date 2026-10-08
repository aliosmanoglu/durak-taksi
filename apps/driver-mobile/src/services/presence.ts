// Varlık akışlarının yürütücüsü: saf geçişleri (src/lib/presence/transitions) çağırır, yamayı store'a yazar
// ve yan etkileri (konum görevi, socket emit, haptik, bildirim) sırayla uygular.
import { AccessibilityInfo } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  DRIVER_EVENTS,
  locationUpdateSchema,
  type DriverSessionSync,
  type DriverStatusResult,
} from '@duraknet/shared';
import { LAST_SENT_PERSIST_EVERY_MS } from '@/lib/constants';
import { log } from '@/lib/log';
import { emitAck, isConnected, sendLocation } from '@/lib/realtime';
import { accuracyBucket, canSendLocation, fixUsableForGoOnline, onLocationSent, type Fix } from '@/lib/presence/state';
import {
  beginGoOffline,
  beginGoOnline,
  checkGoOnlineReadiness,
  goOnlineFixAcquired,
  goOnlineFixFailed,
  needsSyncRequest,
  onAutoReactivateCheckFailed,
  onConnected,
  onDisconnected,
  onGoOfflineAck,
  onGoOnlineAck,
  onTrackingStartFailed,
  parseSessionSync,
  reconcileSync,
  syncWatchDelayMs,
  type Effect,
  type Step,
} from '@/lib/presence/transitions';
import { showToast, store } from '@/lib/store';
import { T } from '@/lib/texts';
import * as location from './location';
import { notifyLocal } from './notify';
import { storage } from './storage';

const get = () => store.getState();

// Oturum sonu (auth servisi kaydeder; döngüsel import yerine geri çağırma).
type SessionEndHandler = (reason: Extract<Effect, { type: 'sessionEnd' }>['reason']) => void;
let onSessionEnd: SessionEndHandler = () => {};
export function setSessionEndHandler(fn: SessionEndHandler) {
  onSessionEnd = fn;
}

/** Ride servisi bu işlevle oturum sonunu başlatır (döngüsel import yerine, aynı geri çağırma). */
export function requestSessionEnd(reason: Parameters<SessionEndHandler>[0]) {
  onSessionEnd(reason);
}

/**
 * Kabul edilmiş (sürüm kapısından geçmiş) her `session_sync` için çağrılır: ride servisi çağrı listesini ve
 * eşleşmiş yolculuğu buradan uzlaştırır. Ride servisi presence'ı içe aktarır (tersi değil) → döngü yok.
 */
type SyncListener = (payload: unknown) => void;
let syncListener: SyncListener = () => {};
export function setSyncListener(fn: SyncListener) {
  syncListener = fn;
}

// Efektler sırayla uygulanır (ör. önce görev durur, sonra go_offline — kural 3.4-5).
let queue: Promise<void> = Promise.resolve();

/**
 * Yamayı yazar ve efektleri kuyruğa ekler; dönen söz yalnızca bu adımın efektleri bitince çözülür.
 * Kuyruktaki bir efektin içinden apply() BEKLENMEZ (kendini bekler, kilitlenir): void ile çağrılır.
 */
export function apply(step: Step): Promise<void> {
  store.setState(step.patch);
  const effects = step.effects;
  if (effects.length === 0) return Promise.resolve();
  const run = queue.then(async () => {
    for (const e of effects) {
      try {
        await runEffect(e);
      } catch (err) {
        log('presence.effect_failed', { type: e.type, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
  });
  queue = run;
  return run;
}

async function runEffect(e: Effect): Promise<void> {
  switch (e.type) {
    case 'startTracking':
      return ensureTracking();
    case 'stopTracking':
      await location.stopTracking();
      store.setState({ tracking: false });
      return;
    case 'emitGoOffline':
      // Ack beklenirken kuyruk bloke olmasın.
      void emitGoOffline();
      return;
    case 'autoReactivate':
      void autoReactivate();
      return;
    case 'requestSync':
      void requestSync();
      return;
    case 'toast':
      showToast(e.text);
      return;
    case 'haptic':
      await Haptics.notificationAsync(
        e.kind === 'success' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
      ).catch(() => {});
      return;
    case 'announce':
      AccessibilityInfo.announceForAccessibility(e.text);
      return;
    case 'sessionEnd':
      onSessionEnd(e.reason);
      return;
    case 'localNotify':
      if (!get().appActive) await notifyLocal(e.text);
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Konum

let lastPersistedSentAt = 0;

/** `force`: aktif olunca yapılan zorunlu ilk gönderim; S4 10 dk ölçütüne (lastRoutineSentAt) sayılmaz. */
function handleFix(fix: Fix, force = false) {
  store.setState({ fix });
  const now = Date.now();
  if (!canSendLocation(get(), now, force)) return;
  const payload = locationUpdateSchema.safeParse({
    location: { lat: fix.lat, lng: fix.lng },
    ...(fix.heading != null ? { heading: fix.heading } : {}),
    ...(fix.accuracy != null ? { accuracy: Math.max(0, fix.accuracy) } : {}),
    ts: now,
  });
  if (!payload.success) return;
  if (sendLocation(payload.data)) {
    store.setState(onLocationSent(now, !force));
    if (!force && now - lastPersistedSentAt >= LAST_SENT_PERSIST_EVERY_MS) {
      lastPersistedSentAt = now;
      void storage.setLastRoutineSentAt(now);
    }
  }
}

location.setLocationListener((fix) => handleFix(fix));

/** Görevi (gerekirse) başlatır ve hemen bir konum gönderir (kural 3.4-4, tablo 4.5). */
async function ensureTracking() {
  const ok = await location.startTracking();
  store.setState({ tracking: ok });
  if (!ok) {
    void apply(onTrackingStartFailed(get())); // kuyruk içinden: beklenmez
    return;
  }
  const fix = get().fix;
  if (fix && fixUsableForGoOnline(fix, Date.now())) handleFix(fix, true);
  else {
    const fresh = await location.getFreshFix();
    if (fresh) handleFix(fresh, true);
  }
}

// ---------------------------------------------------------------------------------------------
// Cihaz durumu

export async function refreshDeviceState() {
  const [{ perm }, gps] = await Promise.all([location.readPermission(), location.readGps()]);
  store.setState({ perm, gps });
  // Pasifken konum çipi için son bilinen konum (GPS çalıştırılmaz).
  if (!get().tracking && !get().fix) {
    const fix = await location.getLastKnownFix();
    if (fix) store.setState({ fix });
  }
}

// ---------------------------------------------------------------------------------------------
// Aktif / Pasif

export type GoOnlineBlock = 'perm' | 'deniedForever' | 'gps' | 'conn' | 'busy';

/**
 * AKTİF OL. İzin/GPS/bağlantı eksikse akış başlamaz ve ekranın yapacağı iş döner (E5 aç, ayarlar, uyarı).
 */
export async function goOnline(): Promise<{ ok: true } | { ok: false; block: GoOnlineBlock }> {
  const s0 = get();
  if (s0.intent !== 'none' || Date.now() < s0.toggleLockedUntil) return { ok: false, block: 'busy' };
  await refreshDeviceState();
  const s = get();
  const ready = checkGoOnlineReadiness(s);
  if (!ready.ok) {
    if (ready.reason === 'perm') return { ok: false, block: s.perm === 'deniedForever' ? 'deniedForever' : 'perm' };
    if (ready.reason === 'conn') showToast(T.home.errNoConnection);
    return { ok: false, block: ready.reason };
  }

  await apply(beginGoOnline());
  const fix = await acquireFix();
  if (!fix) {
    await apply(goOnlineFixFailed());
    return { ok: true };
  }
  log('presence.go_online', { accuracy: accuracyBucket(fix.accuracy) });
  await apply(goOnlineFixAcquired());
  const res = await emitAck<DriverStatusResult>(DRIVER_EVENTS.goOnline, {
    location: { lat: fix.lat, lng: fix.lng },
  });
  await apply(onGoOnlineAck(get(), res, Date.now(), false));
  return { ok: true };
}

/** Son fix ≤ 30 sn ve ≤ 100 m ise o, değilse 10 sn içinde yeni fix. */
async function acquireFix(): Promise<Fix | null> {
  const cur = get().fix;
  if (fixUsableForGoOnline(cur, Date.now())) return cur;
  const fresh = await location.getFreshFix();
  if (fresh) store.setState({ fix: fresh });
  return fresh;
}

/** PASİF OL (kural 3.4-5). */
export async function goOffline() {
  const s = get();
  if (s.intent !== 'none' || Date.now() < s.toggleLockedUntil) return;
  await apply(beginGoOffline(s, Date.now()));
}

async function emitGoOffline() {
  if (!isConnected()) {
    store.setState({ intent: 'offlinePending' });
    return;
  }
  const res = await emitAck<DriverStatusResult>(DRIVER_EVENTS.goOffline, {});
  await apply(onGoOfflineAck(get(), res, Date.now()));
}

/** S4: otomatik yeniden aktif olma (ön planda da arka planda da aynı akış). */
async function autoReactivate() {
  await refreshDeviceState();
  const ready = checkGoOnlineReadiness(get());
  if (!ready.ok) {
    log('presence.auto_reactivate_blocked', { reason: ready.reason });
    await apply(onAutoReactivateCheckFailed(ready.reason));
    return;
  }
  const fix = await acquireFix();
  if (!fix) {
    await apply(onAutoReactivateCheckFailed('fix'));
    return;
  }
  const res = await emitAck<DriverStatusResult>(DRIVER_EVENTS.goOnline, {
    location: { lat: fix.lat, lng: fix.lng },
  });
  log('presence.auto_reactivate', { ok: res.ok });
  await apply(onGoOnlineAck(get(), res, Date.now(), true));
}

// ---------------------------------------------------------------------------------------------
// Socket olayları

export function handleConnect() {
  void apply(onConnected(get(), Date.now()));
  // Sunucu her bağlanmada session_sync gönderir; 5 sn içinde gelmezse istenir (bekçi).
  scheduleSyncWatch(true);
}

export function handleDisconnect() {
  clearTimeout(watchTimer);
  void apply(onDisconnected(get(), Date.now()));
}

// session_sync bekçisi: bağlıyken durum bilinmiyorsa (syncPending / offlinePending) geri çekilmeyle ister.
let watchTimer: ReturnType<typeof setTimeout> | undefined;
let watchAttempt = 0;

function scheduleSyncWatch(reset = false) {
  if (reset) watchAttempt = 0;
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    if (!needsSyncRequest(get())) return;
    watchAttempt++;
    void requestSync();
  }, syncWatchDelayMs(watchAttempt));
}

export function stopSyncWatch() {
  clearTimeout(watchTimer);
}

export function handleSessionSync(payload: unknown) {
  const sync = parseSessionSync(payload);
  if (!sync) {
    log('presence.sync_invalid');
    return;
  }
  const step = reconcileSync(get(), sync, Date.now());
  log('presence.sync', { status: sync.driverStatus, reason: sync.offlineReason ?? null, ignored: step.ignored });
  if (step.ignored) return;
  void apply(step);
  // Varlık yaması store'a yazıldı (apply eşzamanlı yazar); ride kısmı güncel `server` ile uzlaştırılır.
  syncListener(payload);
}

/** Bağlıyken güncel durumu ister (S3; arka plandan > 30 sn sonra dönüş). */
export async function requestSync() {
  if (!isConnected()) return;
  const wasPending = get().syncPending;
  store.setState({ syncPending: true });
  const res = await emitAck<DriverSessionSync>(DRIVER_EVENTS.sessionSyncRequest, {});
  if (res.ok && res.data) handleSessionSync(res.data);
  // Başarısızsa önceki hâl korunur: bağlantının sync'i hiç gelmediyse konum göndermeye başlanmaz.
  else store.setState({ syncPending: wasPending });
  if (needsSyncRequest(get())) scheduleSyncWatch();
  else watchAttempt = 0;
}

/** Çıkış iptal edildiyse (ağ hatası → vazgeç) ve sunucu hâlâ aktif sayıyorsa konum paylaşımı geri açılır. */
export async function resumeTrackingIfNeeded() {
  const s = get();
  if ((s.server === 'available' || s.server === 'busy') && s.intent === 'none') await ensureTracking();
}

export function dismissNotice() {
  store.setState({ notice: null });
}
