// REST yanıtlarının istemci tarafı yorumu. Yanıt biçimi: `{ ok: true, data } | { ok: false, error: { code, message } }`.
import { ERROR_CODES, type ErrorCode } from '@duraknet/shared';
import { RATE_LIMIT_FALLBACK_MS } from './constants';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'http'; status: number; code: ErrorCode; retryAfterMs?: number }
  | { ok: false; kind: 'network' };

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);
}

/**
 * `Retry-After` (saniye veya HTTP tarihi) ya da IETF taslak-8 `RateLimit` başlığındaki `t=` değerinden
 * bekleme süresini çıkarır. Bulunamazsa `undefined`.
 */
export function parseRetryAfterMs(
  headers: { get(name: string): string | null },
  now: number,
): number | undefined {
  const ra = headers.get('retry-after');
  if (ra) {
    const sec = Number(ra);
    if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const rl = headers.get('ratelimit');
  const m = rl ? /(?:^|[;,\s])t=(\d+)/.exec(rl) : null;
  if (m?.[1]) return Number(m[1]) * 1000;
  return undefined;
}

/** Ham HTTP yanıtını sonuca çevirir. Gövde sözleşmeye uymuyorsa durum koduna göre `INTERNAL` / `UNAUTHORIZED`. */
export function toApiResult<T>(
  status: number,
  body: unknown,
  headers: { get(name: string): string | null },
  now: number,
): ApiResult<T> {
  const b = body as { ok?: unknown; data?: unknown; error?: { code?: unknown } } | null;
  if (status >= 200 && status < 300 && b && b.ok === true) return { ok: true, data: b.data as T };
  const code: ErrorCode = isErrorCode(b?.error?.code)
    ? b.error.code
    : status === 429
      ? 'RATE_LIMITED'
      : status === 401
        ? 'UNAUTHORIZED'
        : 'INTERNAL';
  const res: ApiResult<T> = { ok: false, kind: 'http', status, code };
  if (code === 'RATE_LIMITED') res.retryAfterMs = parseRetryAfterMs(headers, now) ?? RATE_LIMIT_FALLBACK_MS;
  return res;
}
