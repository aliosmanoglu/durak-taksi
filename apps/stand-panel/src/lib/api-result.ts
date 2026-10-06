// REST yanıtının istemci yorumu: `{ ok: true, data } | { ok: false, error: { code, message } }`.
import { ERROR_CODES, type ErrorCode } from '@duraknet/shared';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'http'; status: number; code: ErrorCode; retryAfterMs?: number }
  | { ok: false; kind: 'network' };

export const RATE_LIMIT_FALLBACK_MS = 60_000;

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);
}

/** `Retry-After` (saniye ya da HTTP tarihi) -> ms. */
export function parseRetryAfterMs(headers: { get(name: string): string | null }, nowMs: number): number | undefined {
  const ra = headers.get('retry-after');
  if (!ra) return undefined;
  const sec = Number(ra);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

export function toApiResult<T>(
  status: number,
  body: unknown,
  headers: { get(name: string): string | null },
  nowMs: number,
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
  if (code === 'RATE_LIMITED') res.retryAfterMs = parseRetryAfterMs(headers, nowMs) ?? RATE_LIMIT_FALLBACK_MS;
  return res;
}
