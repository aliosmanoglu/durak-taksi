// Oturum yönetimi (tasarım 4.6): açılış, giriş/kayıt/çıkış, access token yenileme, socket kimliği ve
// "oturum sonlandı" akışı. Refresh token yalnızca SecureStore'da, access token yalnızca bu modülün belleğinde.
import {
  COMMON_EVENTS,
  type AuthTokens,
  type DriverRegisterInput,
} from '@duraknet/shared';
import type { ApiResult } from '@/lib/api-result';
import { AUTH_EXPIRED_RETRY_MS } from '@/lib/constants';
import { createGeneration } from '@/lib/generation';
import { FORCE_LOGOUT_DELETE_TIMEOUT_MS, needsRefreshRetry } from '@/lib/push';
import { log } from '@/lib/log';
import { closeRealtime, connectRealtime, emitAck, initRealtime } from '@/lib/realtime';
import {
  backoffMs,
  decideConnectError,
  decideRefresh,
  isSessionEndingCode,
  proactiveRefreshDelayMs,
  sessionEndReasonOf,
  type RefreshDecision,
  type SessionEndReason,
} from '@/lib/session-policy';
import { initialAppState, showToast, store, type Profile } from '@/lib/store';
import { T } from '@/lib/texts';
import { API_URL } from './config';
import { request } from './http';
import * as location from './location';
import { notifyLocal } from './notify';
import * as presence from './presence';
import * as push from './push';
import * as rides from './rides';
import { storage } from './storage';

let accessToken: string | null = null;
/** Oturum nesli: çıkış / oturum sonu / yeni giriş artırır; geç dönen refresh eski oturumu geri yazamaz. */
const generation = createGeneration();
type RefreshOutcome = RefreshDecision | { kind: 'stale' };
let refreshInFlight: Promise<RefreshOutcome> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
let unauthorizedStreak = 0;
/** Çıkış/oturum sonu sürerken gelen `io server disconnect` hata sayılmaz. */
let loggingOut = false;

export const getAccessToken = () => accessToken;

/** Yeni oturum nesli: uçuştaki refresh sonuçları artık yazılmaz. */
function bumpGeneration() {
  generation.bump();
  refreshInFlight = null;
  clearTimers();
}

function clearTimers() {
  clearTimeout(refreshTimer);
  clearTimeout(reconnectTimer);
  refreshTimer = reconnectTimer = undefined;
}

// ---------------------------------------------------------------------------------------------
// Token yenileme

/** Tokenları yazar ve proaktif yenilemeyi kurar; nesil değiştiyse hiçbir şey yazmaz (false). */
async function saveTokens(t: Pick<AuthTokens, 'accessToken' | 'refreshToken' | 'accessExpiresIn'>, gen: number) {
  if (!generation.isCurrent(gen)) return false;
  accessToken = t.accessToken;
  scheduleProactiveRefresh(t.accessExpiresIn);
  await storage.setRefreshToken(t.refreshToken);
  if (!generation.isCurrent(gen)) {
    // Yazma sürerken oturum kapandı: geri yazılan token silinir.
    await storage.clearSession();
    return false;
  }
  return true;
}

/** Tek uçuşlu `POST /auth/refresh`. `afterRejection`: sunucu bağlantıyı reddettikten sonra mı? */
function refreshTokens(afterRejection: boolean): Promise<RefreshOutcome> {
  if (refreshInFlight) return refreshInFlight;
  const flight: Promise<RefreshOutcome> = doRefresh(generation.current(), afterRejection).finally(() => {
    // Nesil değiştiyse (bumpGeneration) yeni bir uçuş başlamış olabilir; yalnızca kendini temizler.
    if (refreshInFlight === flight) refreshInFlight = null;
  });
  refreshInFlight = flight;
  return flight;
}

async function doRefresh(gen: number, afterRejection: boolean): Promise<RefreshOutcome> {
  const rt = await storage.getRefreshToken();
  if (!generation.isCurrent(gen)) return { kind: 'stale' };
  if (!rt) return { kind: 'end', reason: 'ended' };
  const r = await request<AuthTokens>('POST', '/auth/refresh', { body: { refreshToken: rt } });
  if (!generation.isCurrent(gen)) return { kind: 'stale' };
  if (r.ok && !(await saveTokens(r.data, gen))) return { kind: 'stale' };
  const d = decideRefresh(r, afterRejection);
  log('session.refresh', { result: d.kind });
  return d;
}

function scheduleProactiveRefresh(expiresInSec: number) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshLoop(0, backoffMs), proactiveRefreshDelayMs(expiresInSec));
}

/** Yenile → bağlı socket'e `auth_refresh`. Ağ hatasında `delay(attempt)` sonra tekrar. */
async function refreshLoop(attempt: number, delay: (attempt: number) => number) {
  const d = await refreshTokens(false);
  if (d.kind === 'stale') return;
  if (d.kind === 'end') return endSession(d.reason);
  if (d.kind === 'retry') {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshLoop(attempt + 1, delay), delay(attempt));
    return;
  }
  const r = await emitAck(COMMON_EVENTS.authRefresh, { token: accessToken });
  if (!r.ok && 'code' in r && isSessionEndingCode(r.code)) endSession(sessionEndReasonOf(r.code));
}

// ---------------------------------------------------------------------------------------------
// Socket

function startRealtime() {
  initRealtime(API_URL, getAccessToken, {
    onConnect() {
      reconnectAttempt = 0;
      unauthorizedStreak = 0;
      presence.handleConnect();
    },
    onDisconnect(reason) {
      presence.handleDisconnect();
      // Sunucu kesmesinde socket.io-client kendiliğinden bağlanmaz: refresh + elle connect.
      if (reason === 'io server disconnect' && !loggingOut) void reconnectAfterRejection();
    },
    onConnectError(err, serverRejected) {
      presence.handleDisconnect();
      const d = decideConnectError(err.message, serverRejected);
      log('session.connect_error', { decision: d.kind });
      switch (d.kind) {
        case 'refreshAndReconnect':
          // "Bir kez refresh + yeniden bağlan": refresh başarılı olduğu halde tekrar reddedilirse oturum biter.
          if (++unauthorizedStreak > 1) return endSession('loggedOutElsewhere');
          return void reconnectAfterRejection();
        case 'end':
          return endSession(d.reason);
        case 'fatal':
          showToast(T.common.errServer);
          return;
        case 'retryLater':
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => connectRealtime(), backoffMs(reconnectAttempt++));
          return;
        case 'autoRetry':
          return;
      }
    },
    onSessionSync: (p) => presence.handleSessionSync(p),
    onRideRequested: rides.handleRideRequested,
    onRideTaken: rides.handleRideTaken,
    onRideAccepted: rides.handleRideAccepted,
    onRideCancelled: rides.handleRideCancelled,
    onRideCompleted: rides.handleRideCompleted,
    onAuthExpired() {
      // Proaktif yenileme kaçtıysa: hemen, ağ hatasında 5 sn aralıkla (sunucu 30 sn bekler).
      clearTimeout(refreshTimer);
      void refreshLoop(0, () => AUTH_EXPIRED_RETRY_MS);
    },
  });
  connectRealtime();
}

async function reconnectAfterRejection() {
  const d = await refreshTokens(true);
  if (d.kind === 'ok') return connectRealtime();
  if (d.kind === 'stale') return;
  if (d.kind === 'end') return endSession(d.reason);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void reconnectAfterRejection(), backoffMs(reconnectAttempt++));
}

// ---------------------------------------------------------------------------------------------
// Açılış

type MeResponse = Profile & { role: 'driver' };

async function loadProfile() {
  const r = await request<MeResponse>('GET', '/me', { token: accessToken });
  if (!r.ok) return;
  const { id, fullName, phone, plate, vehicleModel, vehicleColor } = r.data;
  const profile: Profile = { id, fullName, phone, plate, vehicleModel, vehicleColor };
  store.setState({ profile });
  await storage.setProfile(profile);
}

let persistenceBound = false;
function bindPersistence() {
  if (persistenceBound) return;
  persistenceBound = true;
  // `wantsOnline` kalıcıdır (S4); oturum açıkken her değişiklik yazılır.
  store.subscribe((s, prev) => {
    if (s.auth === 'signedIn' && s.wantsOnline !== prev.wantsOnline) void storage.setWantsOnline(s.wantsOnline);
  });
  presence.setSessionEndHandler((reason) => endSession(reason));
}

let booted = false;

export async function boot() {
  if (booted) return;
  booted = true;
  bindPersistence();
  push.initPush(getAccessToken);
  const [refresh, profile, wantsOnline, lastRoutineSentAt, tracking, soundEnabled, cachedRide] = await Promise.all([
    storage.getRefreshToken(),
    storage.getProfile(),
    storage.getWantsOnline(),
    storage.getLastRoutineSentAt(),
    location.isTracking(),
    storage.getSoundEnabled(),
    storage.getActiveRide(),
  ]);
  // Önbellekteki yolculuk yalnızca oturum varsa geçerlidir; sunucu `session_sync`'i doğrulayana kadar soluk gösterilir.
  const activeRide = refresh ? cachedRide : null;
  if (!refresh && cachedRide) void storage.setActiveRide(null);
  store.setState({
    ...initialAppState({ wantsOnline, lastRoutineSentAt, soundEnabled, activeRide }),
    profile,
    tracking,
  });
  await presence.refreshDeviceState();
  if (!refresh) {
    // Oturum yokken kalmış görev (ör. zorla kapatma) durdurulur.
    if (tracking) await location.stopTracking();
    store.setState({ auth: 'signedOut', tracking: false });
    return;
  }
  // Önceki çalışmadan kalan görev varsa session_sync gelene kadar konum gönderilmez (server = unknown).
  const d = await refreshTokens(false);
  if (d.kind === 'stale') return;
  if (d.kind === 'end') return endSession(d.reason);
  store.setState({ auth: 'signedIn' });
  if (d.kind === 'ok') {
    startRealtime();
    void loadProfile();
    void push.syncPushToken();
    void push.handleColdStartResponse();
    return;
  }
  // Ağ yok: önbellekteki profille ana ekran ("Bağlantı yok"); refresh geri çekilmeyle yeniden denenir.
  store.setState({ conn: 'disconnected', disconnectedAt: Date.now() });
  void bootRetry(0);
}

async function bootRetry(attempt: number) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (store.getState().auth !== 'signedIn') return;
    const d = await refreshTokens(false);
    if (d.kind === 'stale') return;
  if (d.kind === 'end') return endSession(d.reason);
    if (d.kind === 'retry') return void bootRetry(attempt + 1);
    startRealtime();
    void loadProfile();
    void push.syncPushToken();
    void push.handleColdStartResponse();
  }, backoffMs(attempt));
}

// ---------------------------------------------------------------------------------------------
// Giriş / kayıt / çıkış

export type LoginResult = ApiResult<AuthTokens & { role: string; id: string }>;

export async function login(phone: string, password: string): Promise<LoginResult> {
  const r = await request<AuthTokens & { role: string; id: string }>('POST', '/auth/login', {
    body: { role: 'driver', phone, password },
  });
  if (!r.ok) return r;
  bindPersistence();
  bumpGeneration();
  if (!(await saveTokens(r.data, generation.current()))) return r;
  await storage.setWantsOnline(false);
  await storage.setLastRoutineSentAt(null);
  await loadProfile();
  store.setState({
    ...initialAppState({ wantsOnline: false, lastRoutineSentAt: null, soundEnabled: store.getState().soundEnabled }),
    profile: store.getState().profile,
    perm: store.getState().perm,
    gps: store.getState().gps,
    auth: 'signedIn',
  });
  startRealtime();
  void push.syncPushToken();
  return r;
}

export function register(input: DriverRegisterInput) {
  return request<{ id: string; status: string }>('POST', '/auth/driver/register', { body: input });
}

/**
 * Çıkış (E6): konum görevi durur → `POST /auth/logout` (tüm cihazlar). Başarı veya UNAUTHORIZED → yerel
 * oturum silinir. Ağ hatasında `false` döner; ekran "TEKRAR DENE / YİNE DE ÇIK" sorar.
 */
export async function logout(force = false): Promise<boolean> {
  loggingOut = true;
  await presence.apply({ patch: {}, effects: [{ type: 'stopTracking' }] });
  // Uçuştaki token kaydı iptal edilir; silme HER çıkışta denenir (best effort, çıkışı kilitlemez).
  push.resetPush();
  if (force) {
    await push.deletePushToken(accessToken, FORCE_LOGOUT_DELETE_TIMEOUT_MS);
  } else {
    // Token, `/auth/logout` `token_version`'ı artırmadan ÖNCE silinir (sonrasında access token geçersiz olur).
    // Access token süresi dolduysa (401) önce refresh edilir. Başarısızlık loglanır, çıkış engellenmez.
    await withFreshAccess((t) => push.deletePushToken(t));
    const r = await withFreshAccess((t) => request<unknown>('POST', '/auth/logout', { token: t }));
    if (!r.ok && !(r.kind === 'http' && r.code === 'UNAUTHORIZED')) {
      loggingOut = false;
      return false;
    }
  }
  await clearLocalSession(null);
  return true;
}

/** Çağrı 401 alırsa (access token süresi dolmuş) bir kez refresh edip yeniden dener; refresh başarısızsa ilk sonuç döner. */
async function withFreshAccess<T>(call: (token: string | null) => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  const first = await call(accessToken);
  if (!needsRefreshRetry(first, false)) return first;
  const d = await refreshTokens(false);
  return d.kind === 'ok' ? call(accessToken) : first;
}

/** Çıkış vazgeçildi: sunucu hâlâ aktif sayıyorsa konum paylaşımı geri açılır. */
export function cancelLogout() {
  loggingOut = false;
  void presence.resumeTrackingIfNeeded();
  void push.syncPushToken();
}

async function clearLocalSession(reason: SessionEndReason | null) {
  loggingOut = true;
  // Askıya alma eşleşmeyi düşürür: giriş ekranı şeridi bunu söyler (faz3 4.8).
  const hadRide = store.getState().activeRide != null;
  rides.resetRideServices();
  push.resetPush();
  bumpGeneration();
  presence.stopSyncWatch();
  await location.stopTracking();
  closeRealtime();
  accessToken = null;
  await storage.clearSession();
  const { perm, gps, appActive, soundEnabled } = store.getState();
  store.setState({
    ...initialAppState({ soundEnabled }),
    perm,
    gps,
    appActive,
    auth: 'signedOut',
    sessionEnded: reason === 'suspended' && hadRide ? 'suspendedWithRide' : reason && reason !== 'pending' ? reason : null,
    showPending: reason === 'pending',
  });
  loggingOut = false;
}

let ending = false;
/** "Oturum sonlandı" akışı: görev durur → socket kapanır → SecureStore temizlenir → E1 + şerit (veya E3). */
export function endSession(reason: SessionEndReason) {
  if (ending) return;
  ending = true;
  log('session.end', { reason });
  void (async () => {
    try {
      if (!store.getState().appActive) {
        const withRide = reason === 'suspended' && store.getState().activeRide != null;
        await notifyLocal(withRide ? T.ride.notif.suspended : T.notif.sessionEnded);
      }
      await clearLocalSession(reason);
    } finally {
      ending = false;
    }
  })();
}
