// Push saf mantığı (docs/design/faz5-resilience.md Bölüm 1). Push yalnızca bildirimdir: içeriğe güvenilmez,
// kabul her zaman `ride_accept` ile yapılır. RN/Expo katmanı: services/push.ts.
import { PUSH_DATA_TYPES, pushTokenSchema, type PushDataType } from '@duraknet/shared';
import type { ApiResult } from './api-result';

export type PushData = { type: PushDataType; rideId?: string };

/** Bildirim `data` alanını ayrıştırır; tanınmayan / bozuk veri `null` (yok sayılır). */
export function parsePushData(data: unknown): PushData | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const type = d.type;
  if (typeof type !== 'string' || !(PUSH_DATA_TYPES as readonly string[]).includes(type)) return null;
  const out: PushData = { type: type as PushDataType };
  if (typeof d.rideId === 'string' && d.rideId.length > 0) out.rideId = d.rideId;
  return out;
}

/**
 * Ön plandayken bildirim gösterilsin mi? `ride_requested` push'u yalnızca socket BAĞLIYKEN bastırılır (çağrıyı
 * socket zaten ekrana getirir); kopukken socket getiremez, bildirim tek uyarıdır.
 */
export function shouldPresentInForeground(data: unknown, socketConnected: boolean): boolean {
  return !(parsePushData(data)?.type === 'ride_requested' && socketConnected);
}

/**
 * Çıkışta push token silme / `/auth/logout` çağrısı sonrası: access token süresi dolmuşsa (401) bir kez
 * refresh edip aynı çağrı yeniden denenir. Ağ hatası ve diğer hatalarda yeniden deneme yok (çıkış kilitlenmez).
 */
export function needsRefreshRetry(r: ApiResult<unknown>, alreadyRetried: boolean): boolean {
  return !r.ok && !alreadyRetried && r.kind === 'http' && r.code === 'UNAUTHORIZED';
}

/** `force` çıkışta (sunucu zaten ulaşılamıyor) token silme denemesinin en çok bekleyeceği süre. */
export const FORCE_LOGOUT_DELETE_TIMEOUT_MS = 3_000;

/** Bildirime dokunma kararı: yalnızca `ride_requested` senkron + çağrı ekranı ister. */
export type TapAction = { kind: 'syncAndOpenRequests' } | { kind: 'ignore' };

export function decideTap(data: unknown, signedIn: boolean): TapAction {
  if (!signedIn) return { kind: 'ignore' };
  return parsePushData(data)?.type === 'ride_requested' ? { kind: 'syncAndOpenRequests' } : { kind: 'ignore' };
}

export type SkipReason = 'not_signed_in' | 'no_permission' | 'no_project_id' | 'unchanged' | 'invalid_token';

/** Expo token'ı almadan önce: giriş, izin ve projectId şart. */
export function decideFetch(input: {
  signedIn: boolean;
  permission: 'granted' | 'denied' | 'undetermined';
  projectId: string | null | undefined;
}): { do: 'fetch'; projectId: string } | { do: 'skip'; reason: SkipReason } {
  if (!input.signedIn) return { do: 'skip', reason: 'not_signed_in' };
  if (input.permission !== 'granted') return { do: 'skip', reason: 'no_permission' };
  if (!input.projectId) return { do: 'skip', reason: 'no_project_id' };
  return { do: 'fetch', projectId: input.projectId };
}

/** Alınan token sunucuya yazılsın mı? Aynı oturumda aynı token tekrar gönderilmez. */
export function decideRegister(
  token: string,
  lastRegistered: string | null,
): { do: 'register'; token: string } | { do: 'skip'; reason: SkipReason } {
  if (!pushTokenSchema.safeParse({ token }).success) return { do: 'skip', reason: 'invalid_token' };
  if (token === lastRegistered) return { do: 'skip', reason: 'unchanged' };
  return { do: 'register', token };
}

export const PUSH_REGISTER_MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

/**
 * Kayıt isteği sonrası tekrar kararı: ağ hatası, 5xx ve 429 sınırlı yeniden denenir (üstel geri çekilme;
 * 429'da `Retry-After` varsa o). 401/403/400/404 tekrar denenmez (oturum katmanı 401'i zaten ele alır).
 * Dönüş: bekleme (ms) ya da `null` (vazgeç).
 */
export function pushRetryDelayMs(r: ApiResult<unknown>, attempt: number): number | null {
  if (r.ok) return null;
  if (attempt + 1 >= PUSH_REGISTER_MAX_ATTEMPTS) return null;
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
  if (r.kind === 'network') return backoff;
  if (r.code === 'RATE_LIMITED') return Math.min(RETRY_MAX_MS * 2, Math.max(backoff, r.retryAfterMs ?? backoff));
  if (r.status >= 500) return backoff;
  return null;
}
