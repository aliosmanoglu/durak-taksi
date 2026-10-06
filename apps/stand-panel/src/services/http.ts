import { toApiResult, type ApiResult } from '../lib/api-result';
import { API_URL, HTTP_TIMEOUT_MS } from './config';

export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  opts: { body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<ApiResult<T>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
    });
    const body: unknown = await res.json().catch(() => null);
    return toApiResult<T>(res.status, body, res.headers, Date.now());
  } catch {
    return { ok: false, kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
