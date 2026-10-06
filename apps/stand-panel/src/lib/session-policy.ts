// Oturum zamanlaması (docs/design/faz3-dispatch.md Bölüm 3.3): access %80'inde sessiz yenileme,
// yeniden denemede 1 -> 5 sn geri çekilme.

export const REFRESH_AT_FRACTION = 0.8;
/** `auth_expired` sonrası sunucu 30 sn bekler; bu süre içinde yenileme bitmeli. */
export const AUTH_EXPIRED_GRACE_MS = 30_000;

/** Access token alındıktan kaç ms sonra sessizce yenilenmeli (en az 1 sn). */
export function refreshDelayMs(accessExpiresInSec: number): number {
  return Math.max(1_000, Math.floor(accessExpiresInSec * 1000 * REFRESH_AT_FRACTION));
}

/** Yenileme başarısızsa tekrar deneme aralığı: 1, 2, 3, 4, 5, 5... sn. */
export function backoffMs(attempt: number): number {
  return Math.min(5, Math.max(1, attempt)) * 1000;
}
