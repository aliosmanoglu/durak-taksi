// Expo push (Faz 5): token kaydı / silme ve bildirime dokunma. Karar mantığı lib/push.ts'tedir (vitest);
// bu dosya RN/Expo katmanıdır (testsiz; yalnızca typecheck + gerçek cihaz). Push yalnızca bildirimdir:
// dokunma `session_sync_request` atar, kabul yalnızca `ride_accept` ile yapılır.
import { router } from 'expo-router';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { createGeneration } from '@/lib/generation';
import { log } from '@/lib/log';
import { decideFetch, decideRegister, decideTap, pushRetryDelayMs } from '@/lib/push';
import { store } from '@/lib/store';
import { request } from './http';
import { prepareNotifications, readNotificationPermission } from './notify';
import * as presence from './presence';

let tokenProvider: () => string | null = () => null;
const generation = createGeneration();
let lastRegistered: string | null = null;
let inFlight: Promise<void> | null = null;
let listening = false;
const handledResponses = new Set<string>();

const signedIn = () => store.getState().auth === 'signedIn';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

/** Access token sağlayıcısı (döngüsel içe aktarmayı önlemek için session.ts verir) ve dinleyiciler; idempotent. */
export function initPush(getAccessToken: () => string | null) {
  tokenProvider = getAccessToken;
  void prepareNotifications().catch(() => {});
  if (listening) return;
  listening = true;
  Notifications.addNotificationResponseReceivedListener((resp) => void handleResponse(resp));
  // Cihaz token'ı değişince Expo token'ı yeniden alınıp kaydedilir (aynıysa istek atılmaz).
  Notifications.addPushTokenListener(() => void syncPushToken());
}

/** İzin verildiyse ve oturum açıksa Expo token'ı alıp `PUT /me/push-token` ile yazar. Eşzamanlı çağrılar birleşir. */
export function syncPushToken(): Promise<void> {
  if (inFlight) return inFlight;
  const p: Promise<void> = run().finally(() => {
    if (inFlight === p) inFlight = null;
  });
  inFlight = p;
  return p;
}

async function run() {
  const gen = generation.current();
  try {
    await prepareNotifications();
    const d = decideFetch({ signedIn: signedIn(), permission: await readNotificationPermission(), projectId: projectId() });
    if (d.do === 'skip') {
      log('push.skip', { reason: d.reason });
      return;
    }
    const expoToken = (await Notifications.getExpoPushTokenAsync({ projectId: d.projectId })).data;
    if (!generation.isCurrent(gen)) return;
    await registerToken(expoToken, gen);
  } catch {
    // Simülatör, Play Services yok, ağ yok vb.: push olmadan çalışmaya devam edilir. Token loglanmaz.
    log('push.token_failed');
  }
}

async function registerToken(token: string, gen: number) {
  const d = decideRegister(token, lastRegistered);
  if (d.do === 'skip') {
    log('push.skip', { reason: d.reason });
    return;
  }
  for (let attempt = 0; ; attempt++) {
    if (!generation.isCurrent(gen) || !signedIn()) return;
    const r = await request<unknown>('PUT', '/me/push-token', { body: { token: d.token }, token: tokenProvider() });
    if (!generation.isCurrent(gen)) return;
    if (r.ok) {
      lastRegistered = d.token;
      log('push.registered');
      return;
    }
    const delay = pushRetryDelayMs(r, attempt);
    log('push.register_failed', { kind: r.kind, status: r.kind === 'http' ? r.status : null, retry: delay != null });
    if (delay == null) return;
    await sleep(delay);
  }
}

/**
 * `DELETE /me/push-token` (tek deneme; çağıran 401'de refresh edip tekrarlar). Her çıkışta DENENİR: bellekteki
 * kayıt durumuna bakılmaz (uygulama yeni açılmış ya da kayıt uçuşta olabilir; sunucu silme idempotenttir).
 */
export async function deletePushToken(access: string | null, timeoutMs?: number) {
  const r = await request<unknown>('DELETE', '/me/push-token', {
    token: access,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  log('push.unregister', { ok: r.ok, status: r.ok ? 200 : r.kind === 'http' ? r.status : null });
  return r;
}

/** Oturum bitti / çıkış: uçuştaki kayıt iptal edilir, bir sonraki girişte yeniden yazılır. */
export function resetPush() {
  generation.bump();
  // Hesap değişiminde yeni hesap eski neslin uçuşundaki promise'e bağlanmasın.
  inFlight = null;
  lastRegistered = null;
  handledResponses.clear();
}

/** Soğuk açılış: uygulamayı bildirime dokunarak açtıysa (oturum açıldıktan sonra bir kez çağrılır). */
export async function handleColdStartResponse() {
  try {
    const resp = await Notifications.getLastNotificationResponseAsync();
    if (resp) await handleResponse(resp);
  } catch {
    log('push.cold_start_failed');
  }
}

async function handleResponse(resp: Notifications.NotificationResponse) {
  const key = `${resp.notification.request.identifier}:${resp.notification.date}`;
  if (handledResponses.has(key)) return;
  const action = decideTap(resp.notification.request.content.data, signedIn());
  // Oturum yokken dokunma işaretlenmez: giriş sonrası `getLastNotificationResponseAsync` yeniden ele alır.
  if (signedIn()) handledResponses.add(key);
  if (action.kind === 'ignore') return;
  // Push içeriğine güvenilmez: güncel çağrılar sunucudan istenir (bağlı değilse bağlanınca session_sync gelir).
  await presence.requestSync();
  const s = store.getState();
  if (s.activeRide == null && s.requests.some((r) => !r.taken)) {
    try {
      router.navigate('/requests');
    } catch {
      // Gezinti ağacı henüz hazır değil: RideNavigator ilk çağrıda D1'i kendisi açar.
    }
  }
}
