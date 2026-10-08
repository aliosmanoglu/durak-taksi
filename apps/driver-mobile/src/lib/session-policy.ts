// Oturum kararları (tasarım 4.6): refresh zamanlaması, geri çekilme, connect_error ve refresh hatalarının yorumu.
import type { ErrorCode } from '@duraknet/shared';
import {
  PROACTIVE_REFRESH_RATIO,
  REFRESH_BACKOFF_BASE_MS,
  REFRESH_BACKOFF_MAX_MS,
} from './constants';
import { isErrorCode, type ApiResult } from './api-result';

export type SessionEndReason = 'ended' | 'suspended' | 'loggedOutElsewhere' | 'pending';

/** Proaktif yenileme gecikmesi: access süresinin %80'i. */
export function proactiveRefreshDelayMs(accessExpiresInSec: number): number {
  return Math.max(0, Math.floor(accessExpiresInSec * 1000 * PROACTIVE_REFRESH_RATIO));
}

/** Üstel geri çekilme: 2, 4, 8, 16, 30, 30 … sn (attempt 0'dan başlar). */
export function backoffMs(attempt: number): number {
  return Math.min(REFRESH_BACKOFF_MAX_MS, REFRESH_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
}

/**
 * `POST /auth/refresh` sonucunun yorumu.
 * - `retry`: ağ, 429 veya 5xx → geri çekilmeyle tekrar; ekran değişmez.
 * - `end`: oturum sonlandı (neden login ekranındaki şeridi belirler).
 * @param afterRejection Refresh, sunucunun bağlantıyı reddetmesinden (connect_error UNAUTHORIZED /
 *   io server disconnect) sonra mı yapıldı? O durumda UNAUTHORIZED "başka yerden çıkış" demektir.
 */
export type RefreshDecision = { kind: 'ok' } | { kind: 'retry' } | { kind: 'end'; reason: SessionEndReason };

export function decideRefresh(r: ApiResult<unknown>, afterRejection: boolean): RefreshDecision {
  if (r.ok) return { kind: 'ok' };
  if (r.kind === 'network') return { kind: 'retry' };
  switch (r.code) {
    case 'UNAUTHORIZED':
      return { kind: 'end', reason: afterRejection ? 'loggedOutElsewhere' : 'ended' };
    case 'ACCOUNT_SUSPENDED':
      return { kind: 'end', reason: 'suspended' };
    case 'ACCOUNT_PENDING':
      return { kind: 'end', reason: 'pending' };
    case 'VALIDATION_ERROR':
      // Saklı refresh token bozuk: yeniden denemenin anlamı yok.
      return { kind: 'end', reason: 'ended' };
    default:
      return { kind: 'retry' };
  }
}

/**
 * Socket `connect_error` yorumu (tasarım 4.6 hata eşlemesi). `err.message` = hata kodu.
 * `serverRejected`: istemci `socket.active === false` ise sunucu ara katmanı reddetti demektir;
 * socket.io-client bu durumda kendiliğinden yeniden denemez.
 */
export type ConnectErrorDecision =
  | { kind: 'refreshAndReconnect' }
  | { kind: 'end'; reason: SessionEndReason }
  | { kind: 'fatal' }
  | { kind: 'retryLater' }
  | { kind: 'autoRetry' };

export function decideConnectError(message: string | undefined, serverRejected: boolean): ConnectErrorDecision {
  const code: ErrorCode | undefined = isErrorCode(message) ? message : undefined;
  switch (code) {
    case 'UNAUTHORIZED':
      return { kind: 'refreshAndReconnect' };
    case 'ACCOUNT_SUSPENDED':
      return { kind: 'end', reason: 'suspended' };
    case 'ACCOUNT_PENDING':
      return { kind: 'end', reason: 'pending' };
    case 'FORBIDDEN':
      return { kind: 'fatal' };
    default:
      // INTERNAL veya taşıma hatası. Sunucu reddettiyse istemci kendisi yeniden denemez → elle, geri çekilmeyle.
      return serverRejected ? { kind: 'retryLater' } : { kind: 'autoRetry' };
  }
}

/** `auth_refresh` / `driver_*` ack hatalarından hangisi oturumun bittiğini gösterir. */
export function isSessionEndingCode(code: ErrorCode): boolean {
  return code === 'UNAUTHORIZED' || code === 'ACCOUNT_SUSPENDED' || code === 'ACCOUNT_PENDING';
}

export function sessionEndReasonOf(code: ErrorCode): SessionEndReason {
  if (code === 'ACCOUNT_SUSPENDED') return 'suspended';
  if (code === 'ACCOUNT_PENDING') return 'pending';
  return 'loggedOutElsewhere';
}

/**
 * Ön plana dönüşte `session_sync_request` gerekir mi? Arka planda `thresholdMs`'den uzun kalındıysa evet.
 * Harici navigasyondan dönüş (`navigationLaunched`) süre ne olursa olsun yeniden eşitler: ride ekranı
 * sunucudaki gerçek duruma (ör. durak iptal etti / tamamladı) göre geri yüklenir.
 */
export function shouldResyncOnForeground(awayMs: number, navigationLaunched: boolean, thresholdMs: number): boolean {
  return navigationLaunched || awayMs > thresholdMs;
}

/** Navigasyon bayrağı bu süreden sonra geçersizdir (dönüş hiç gelmediyse bayat bayrak kalmasın). */
export const NAV_FLAG_MAX_AGE_MS = 120_000;

/**
 * Ön plana dönüşte navigasyon bayrağının kaderi. Sahte `inactive -> active` geçişleri (iOS "Aç?" uyarısı,
 * Android uygulama seçicisi) bayrağı tüketmemeli: yalnızca `background` görüldükten sonraki `active` tüketir.
 * - `none`: bayrak yok ya da süresi doldu (bayrak temizlenir)
 * - `keep`: arka plan henüz görülmedi; bayrak korunur, eşitleme yok
 * - `resync`: gerçek dönüş; bayrak tüketilir, eşitleme gerekir
 */
export function navigationFlagOnForeground(
  launchedAt: number | null,
  nowMs: number,
  sawBackground: boolean,
  maxAgeMs: number = NAV_FLAG_MAX_AGE_MS,
): 'none' | 'keep' | 'resync' {
  if (launchedAt == null || nowMs - launchedAt > maxAgeMs) return 'none';
  return sawBackground ? 'resync' : 'keep';
}
