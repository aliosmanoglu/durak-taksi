import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs, toApiResult } from './api-result';
import {
  backoffMs,
  decideConnectError,
  decideRefresh,
  isSessionEndingCode,
  NAV_FLAG_MAX_AGE_MS,
  navigationFlagOnForeground,
  proactiveRefreshDelayMs,
  shouldResyncOnForeground,
} from './session-policy';

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe('token yenileme zamanlaması', () => {
  it('access süresinin %80inde yeniler (15 dk → 12 dk)', () => {
    expect(proactiveRefreshDelayMs(900)).toBe(720_000);
    expect(proactiveRefreshDelayMs(0)).toBe(0);
  });
  it('geri çekilme 2, 4, 8, 16, 30, 30 sn', () => {
    expect([0, 1, 2, 3, 4, 5].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe('REST yanıtı', () => {
  it('başarılı gövdeyi döndürür', () => {
    expect(toApiResult(200, { ok: true, data: { a: 1 } }, headers({}), 0)).toEqual({ ok: true, data: { a: 1 } });
  });
  it('hata kodunu gövdeden alır; tanınmayan gövdede durum kodundan türetir', () => {
    expect(toApiResult(403, { ok: false, error: { code: 'ACCOUNT_PENDING' } }, headers({}), 0)).toMatchObject({
      code: 'ACCOUNT_PENDING',
    });
    expect(toApiResult(502, 'bad gateway', headers({}), 0)).toMatchObject({ code: 'INTERNAL', status: 502 });
    expect(toApiResult(401, null, headers({}), 0)).toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('429 bekleme süresini Retry-After, RateLimit t= veya varsayılan 60 sn olarak verir', () => {
    const body = { ok: false, error: { code: 'RATE_LIMITED' } };
    expect(toApiResult(429, body, headers({ 'retry-after': '720' }), 0)).toMatchObject({ retryAfterMs: 720_000 });
    expect(toApiResult(429, body, headers({ ratelimit: '"login-acct";r=0;t=300' }), 0)).toMatchObject({
      retryAfterMs: 300_000,
    });
    expect(toApiResult(429, body, headers({}), 0)).toMatchObject({ retryAfterMs: 60_000 });
    expect(parseRetryAfterMs(headers({ 'retry-after': new Date(10_000).toUTCString() }), 4_000)).toBe(6_000);
  });
});

describe('refresh kararı', () => {
  const err = (code: string, status = 400) => toApiResult(status, { ok: false, error: { code } }, headers({}), 0);
  it('ağ, 429 ve 5xx tekrar denenir', () => {
    expect(decideRefresh({ ok: false, kind: 'network' }, false)).toEqual({ kind: 'retry' });
    expect(decideRefresh(err('RATE_LIMITED', 429), false)).toEqual({ kind: 'retry' });
    expect(decideRefresh(err('INTERNAL', 500), false)).toEqual({ kind: 'retry' });
  });
  it('UNAUTHORIZED açılışta "sona erdi", ret sonrası "başka yerden kapatıldı"', () => {
    expect(decideRefresh(err('UNAUTHORIZED', 401), false)).toEqual({ kind: 'end', reason: 'ended' });
    expect(decideRefresh(err('UNAUTHORIZED', 401), true)).toEqual({ kind: 'end', reason: 'loggedOutElsewhere' });
  });
  it('askıya alma ve onay bekleme oturumu bitirir', () => {
    expect(decideRefresh(err('ACCOUNT_SUSPENDED', 403), false)).toEqual({ kind: 'end', reason: 'suspended' });
    expect(decideRefresh(err('ACCOUNT_PENDING', 403), false)).toEqual({ kind: 'end', reason: 'pending' });
  });
});

describe('connect_error kararı', () => {
  it('kodlara göre', () => {
    expect(decideConnectError('UNAUTHORIZED', true)).toEqual({ kind: 'refreshAndReconnect' });
    expect(decideConnectError('ACCOUNT_SUSPENDED', true)).toEqual({ kind: 'end', reason: 'suspended' });
    expect(decideConnectError('ACCOUNT_PENDING', true)).toEqual({ kind: 'end', reason: 'pending' });
    expect(decideConnectError('FORBIDDEN', true)).toEqual({ kind: 'fatal' });
  });
  it('INTERNAL sunucu reddiyse elle tekrar, taşıma hatasıysa istemci kendisi dener', () => {
    expect(decideConnectError('INTERNAL', true)).toEqual({ kind: 'retryLater' });
    expect(decideConnectError('websocket error', false)).toEqual({ kind: 'autoRetry' });
  });
  it('oturumu bitiren ack kodları', () => {
    expect(isSessionEndingCode('UNAUTHORIZED')).toBe(true);
    expect(isSessionEndingCode('ACCOUNT_SUSPENDED')).toBe(true);
    expect(isSessionEndingCode('INTERNAL')).toBe(false);
  });
});

describe('shouldResyncOnForeground', () => {
  it('kısa arka plan: eşitleme yok; eşik aşılırsa var', () => {
    expect(shouldResyncOnForeground(5_000, false, 30_000)).toBe(false);
    expect(shouldResyncOnForeground(30_000, false, 30_000)).toBe(false);
    expect(shouldResyncOnForeground(30_001, false, 30_000)).toBe(true);
  });
  it('navigasyondan dönüş süreden bağımsız eşitler', () => {
    expect(shouldResyncOnForeground(0, true, 30_000)).toBe(true);
    expect(shouldResyncOnForeground(3_000, true, 30_000)).toBe(true);
  });
});

describe('navigationFlagOnForeground', () => {
  it('bayrak yoksa veya süresi dolduysa none', () => {
    expect(navigationFlagOnForeground(null, 1_000, true)).toBe('none');
    expect(navigationFlagOnForeground(0, NAV_FLAG_MAX_AGE_MS + 1, true)).toBe('none');
  });
  it('arka plan görülmeden active (sahte geçiş) bayrağı korur', () => {
    expect(navigationFlagOnForeground(0, 5_000, false)).toBe('keep');
  });
  it('arka plan görüldükten sonraki active eşitler', () => {
    expect(navigationFlagOnForeground(0, 5_000, true)).toBe('resync');
    expect(navigationFlagOnForeground(0, NAV_FLAG_MAX_AGE_MS, true)).toBe('resync');
  });
});
