import { describe, expect, it } from 'vitest';
import type { ApiResult } from './api-result';
import {
  decideFetch,
  decideRegister,
  decideTap,
  needsRefreshRetry,
  parsePushData,
  PUSH_REGISTER_MAX_ATTEMPTS,
  pushRetryDelayMs,
  shouldPresentInForeground,
} from './push';

const TOKEN = 'ExponentPushToken[abc-123_X]';
const http = (status: number, code: 'INTERNAL' | 'RATE_LIMITED' | 'UNAUTHORIZED' | 'VALIDATION_ERROR', retryAfterMs?: number): ApiResult<unknown> => ({
  ok: false,
  kind: 'http',
  status,
  code,
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
});

describe('parsePushData', () => {
  it('tanınan tipleri ayrıştırır, rideId yalnızca boş olmayan dizeyse alınır', () => {
    expect(parsePushData({ type: 'ride_requested', rideId: 'r1' })).toEqual({ type: 'ride_requested', rideId: 'r1' });
    expect(parsePushData({ type: 'account_suspended' })).toEqual({ type: 'account_suspended' });
    expect(parsePushData({ type: 'ride_requested', rideId: 5 })).toEqual({ type: 'ride_requested' });
    expect(parsePushData({ type: 'ride_requested', rideId: '' })).toEqual({ type: 'ride_requested' });
  });

  it('bozuk veya bilinmeyen veri null', () => {
    expect(parsePushData(null)).toBeNull();
    expect(parsePushData('x')).toBeNull();
    expect(parsePushData({})).toBeNull();
    expect(parsePushData({ type: 'other' })).toBeNull();
    expect(parsePushData({ type: 7 })).toBeNull();
  });
});

describe('ön plan bastırma', () => {
  it('yalnızca ride_requested bastırılır; yerel bildirimler (veri yok) ve diğerleri gösterilir', () => {
    expect(shouldPresentInForeground({ type: 'ride_requested', rideId: 'r1' }, true)).toBe(false);
    expect(shouldPresentInForeground({ type: 'account_suspended' }, true)).toBe(true);
    expect(shouldPresentInForeground(undefined, true)).toBe(true);
    expect(shouldPresentInForeground({}, true)).toBe(true);
  });
});

describe('ön plan bastırma: socket kopukken', () => {
  it('ride_requested socket bağlı değilse gösterilir', () => {
    expect(shouldPresentInForeground({ type: 'ride_requested', rideId: 'r1' }, false)).toBe(true);
  });
});

describe('needsRefreshRetry', () => {
  it('yalnızca ilk 401 için refresh + yeniden deneme', () => {
    expect(needsRefreshRetry(http(401, 'UNAUTHORIZED'), false)).toBe(true);
    expect(needsRefreshRetry(http(401, 'UNAUTHORIZED'), true)).toBe(false);
    expect(needsRefreshRetry({ ok: false, kind: 'network' }, false)).toBe(false);
    expect(needsRefreshRetry(http(503, 'INTERNAL'), false)).toBe(false);
    expect(needsRefreshRetry({ ok: true, data: null }, false)).toBe(false);
  });
});

describe('decideTap', () => {
  it('oturum açıkken ride_requested senkron + çağrı ekranı ister', () => {
    expect(decideTap({ type: 'ride_requested', rideId: 'r1' }, true)).toEqual({ kind: 'syncAndOpenRequests' });
  });
  it('oturum yoksa, başka tipte veya bozuk veride yok sayılır', () => {
    expect(decideTap({ type: 'ride_requested' }, false)).toEqual({ kind: 'ignore' });
    expect(decideTap({ type: 'account_suspended' }, true)).toEqual({ kind: 'ignore' });
    expect(decideTap(undefined, true)).toEqual({ kind: 'ignore' });
  });
});

describe('token kaydı kararı', () => {
  it('giriş, izin ve projectId şart', () => {
    expect(decideFetch({ signedIn: false, permission: 'granted', projectId: 'p' })).toEqual({ do: 'skip', reason: 'not_signed_in' });
    expect(decideFetch({ signedIn: true, permission: 'denied', projectId: 'p' })).toEqual({ do: 'skip', reason: 'no_permission' });
    expect(decideFetch({ signedIn: true, permission: 'undetermined', projectId: 'p' })).toEqual({ do: 'skip', reason: 'no_permission' });
    expect(decideFetch({ signedIn: true, permission: 'granted', projectId: undefined })).toEqual({ do: 'skip', reason: 'no_project_id' });
    expect(decideFetch({ signedIn: true, permission: 'granted', projectId: '' })).toEqual({ do: 'skip', reason: 'no_project_id' });
    expect(decideFetch({ signedIn: true, permission: 'granted', projectId: 'p' })).toEqual({ do: 'fetch', projectId: 'p' });
  });

  it('aynı token tekrar gönderilmez, biçimi bozuk token reddedilir', () => {
    expect(decideRegister(TOKEN, null)).toEqual({ do: 'register', token: TOKEN });
    expect(decideRegister(TOKEN, 'ExponentPushToken[old]')).toEqual({ do: 'register', token: TOKEN });
    expect(decideRegister(TOKEN, TOKEN)).toEqual({ do: 'skip', reason: 'unchanged' });
    expect(decideRegister('fcm:abc', null)).toEqual({ do: 'skip', reason: 'invalid_token' });
  });
});

describe('pushRetryDelayMs', () => {
  it('ağ hatası ve 5xx üstel geri çekilmeyle, sınırlı sayıda denenir', () => {
    expect(pushRetryDelayMs({ ok: false, kind: 'network' }, 0)).toBe(2_000);
    expect(pushRetryDelayMs({ ok: false, kind: 'network' }, 1)).toBe(4_000);
    expect(pushRetryDelayMs(http(503, 'INTERNAL'), 0)).toBe(2_000);
    expect(pushRetryDelayMs({ ok: false, kind: 'network' }, PUSH_REGISTER_MAX_ATTEMPTS - 1)).toBeNull();
  });

  it('429 Retry-After varsa onu bekler', () => {
    expect(pushRetryDelayMs(http(429, 'RATE_LIMITED', 20_000), 0)).toBe(20_000);
    expect(pushRetryDelayMs(http(429, 'RATE_LIMITED'), 0)).toBe(2_000);
  });

  it('başarı ve kalıcı hatalar (401, 400) tekrar edilmez', () => {
    expect(pushRetryDelayMs({ ok: true, data: null }, 0)).toBeNull();
    expect(pushRetryDelayMs(http(401, 'UNAUTHORIZED'), 0)).toBeNull();
    expect(pushRetryDelayMs(http(400, 'VALIDATION_ERROR'), 0)).toBeNull();
  });
});
