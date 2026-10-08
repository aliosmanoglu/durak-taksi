// REST istemcisi: 15 sn zaman aşımı, `{ ok, data | error }` sözleşmesi → ApiResult.
import { HTTP_TIMEOUT_MS } from '@/lib/constants';
import { toApiResult, type ApiResult } from '@/lib/api-result';
import { API_URL } from './config';

export async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { body?: unknown; token?: string | null; timeoutMs?: number } = {},
): Promise<ApiResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return toApiResult<T>(res.status, body, res.headers, Date.now());
  } catch {
    return { ok: false, kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
