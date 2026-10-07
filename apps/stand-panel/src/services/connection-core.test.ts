import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createConnectionCore } from './connection-core';
import type { RefreshResult } from '../lib/session-policy';

type FakeSocket = { connected: boolean; active: boolean; connect: Mock; disconnect: Mock };

function fakeSocket(over: Partial<{ connected: boolean; active: boolean }> = {}): FakeSocket {
  return { connected: false, active: false, connect: vi.fn(), disconnect: vi.fn(), ...over };
}

function setup(refresh: RefreshResult | RefreshResult[] = 'ok') {
  const state: { socket: FakeSocket | null } = { socket: fakeSocket() };
  const queue = Array.isArray(refresh) ? [...refresh] : null;
  const refreshAccess = vi.fn(async (): Promise<RefreshResult> => (queue ? (queue.shift() ?? 'network') : (refresh as RefreshResult)));
  const endSession = vi.fn();
  const setConn = vi.fn();
  const requestSync = vi.fn();
  const core = createConnectionCore({
    getSocket: () => state.socket,
    refreshAccess,
    endSession,
    setConn,
    requestSync,
    syncWaitMs: 5_000,
  });
  return { state, core, refreshAccess, endSession, setConn, requestSync };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('connect_error', () => {
  it('ACCOUNT_SUSPENDED: oturumu askıda ekranına alır, yeniden bağlanma planlamaz', async () => {
    const t = setup();
    t.core.onConnectError({ message: 'ACCOUNT_SUSPENDED', data: { code: 'ACCOUNT_SUSPENDED' } });
    expect(t.endSession).toHaveBeenCalledWith(undefined, 'suspended');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.state.socket!.connect).not.toHaveBeenCalled();
    expect(t.refreshAccess).not.toHaveBeenCalled();
  });

  it('ACCOUNT_PENDING: onay bekleniyor ekranı', () => {
    const t = setup();
    t.core.onConnectError({ message: 'x', data: { code: 'ACCOUNT_PENDING' } });
    expect(t.endSession).toHaveBeenCalledWith(undefined, 'pending');
  });

  it('kod err.message içinde gelirse de tanınır', () => {
    const t = setup();
    t.core.onConnectError({ message: 'ACCOUNT_SUSPENDED' });
    expect(t.endSession).toHaveBeenCalledWith(undefined, 'suspended');
  });

  it('UNAUTHORIZED: geri çekilmeyle önce token yeniler, sonra bağlanır', async () => {
    const t = setup('ok');
    t.core.onConnectError({ message: 'UNAUTHORIZED', data: { code: 'UNAUTHORIZED' } });
    expect(t.refreshAccess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.refreshAccess).toHaveBeenCalledTimes(1);
    expect(t.state.socket!.connect).toHaveBeenCalledTimes(1);
  });

  it('UNAUTHORIZED sonrası yenileme reddedilirse (askıya alma) bağlanmaz ve döngü durur', async () => {
    const t = setup('rejected');
    t.core.onConnectError({ message: 'UNAUTHORIZED', data: { code: 'UNAUTHORIZED' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.refreshAccess).toHaveBeenCalledTimes(1);
    expect(t.state.socket!.connect).not.toHaveBeenCalled();
  });

  it('diğer hatalarda deneme sayısı arttıkça bekleme uzar (1, 2 sn)', async () => {
    const t = setup();
    t.core.onConnectError({ message: 'xhr poll error' });
    await vi.advanceTimersByTimeAsync(999);
    expect(t.state.socket!.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.state.socket!.connect).toHaveBeenCalledTimes(1);
    t.core.onConnectError({ message: 'xhr poll error' });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(t.state.socket!.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.state.socket!.connect).toHaveBeenCalledTimes(2);
  });

  it('socket.io kendisi yeniden deniyorsa (active) ek zamanlayıcı kurmaz', async () => {
    const t = setup();
    const s = fakeSocket({ active: true });
    t.state.socket = s;
    t.core.onConnectError({ message: 'xhr poll error' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.connect).not.toHaveBeenCalled();
  });

  it('başarılı bağlantı deneme sayacını sıfırlar', async () => {
    const t = setup();
    t.core.onConnectError({ message: 'e' });
    await vi.advanceTimersByTimeAsync(1_000);
    t.core.onConnect();
    t.core.onSync();
    t.core.onConnectError({ message: 'e' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.state.socket!.connect).toHaveBeenCalledTimes(2);
  });
});

describe('disconnect', () => {
  it('io server disconnect: önce refresh, sonra connect', async () => {
    const t = setup('ok');
    t.core.onDisconnect('io server disconnect');
    expect(t.setConn).toHaveBeenCalledWith('disconnected');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.refreshAccess).toHaveBeenCalledTimes(1);
    expect(t.state.socket!.connect).toHaveBeenCalledTimes(1);
  });

  it('io server disconnect + askıya alma: bağlanmaz', async () => {
    const t = setup('rejected');
    t.core.onDisconnect('io server disconnect');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.state.socket!.connect).not.toHaveBeenCalled();
  });

  it('transport close: socket.io kendi dener, çekirdek dokunmaz', async () => {
    const t = setup();
    t.core.onDisconnect('transport close');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.refreshAccess).not.toHaveBeenCalled();
    expect(t.state.socket!.connect).not.toHaveBeenCalled();
  });

  it('refresh ağ hatası: 1, 2 sn geri çekilmeyle tekrar dener, sonunda bağlanır', async () => {
    const t = setup(['network', 'network', 'ok']);
    t.core.onDisconnect('io server disconnect');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.refreshAccess).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.refreshAccess).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.refreshAccess).toHaveBeenCalledTimes(3);
    expect(t.state.socket!.connect).toHaveBeenCalledTimes(1);
  });

  it('yenileme sürerken socket değişirse (oturum kapandı) eski çağrı etkisiz', async () => {
    const t = setup('ok');
    const old = t.state.socket!;
    t.core.refreshThenConnect();
    t.state.socket = null;
    await vi.advanceTimersByTimeAsync(0);
    expect(old.connect).not.toHaveBeenCalled();
  });
});

describe('auth_expired ve handleAuthCode', () => {
  it('auth_expired: refresh çağırır; bağlıysa yeniden bağlanmaz (auth_refresh onToken ile gider)', async () => {
    const t = setup('ok');
    const s = fakeSocket({ connected: true });
    t.state.socket = s;
    t.core.onAuthExpired();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.refreshAccess).toHaveBeenCalledTimes(1);
    expect(s.connect).not.toHaveBeenCalled();
  });

  it('handleAuthCode: ACCOUNT_* ve UNAUTHORIZED ele alınır, diğerleri değil', async () => {
    const t = setup('ok');
    expect(t.core.handleAuthCode('ACCOUNT_SUSPENDED')).toBe(true);
    expect(t.endSession).toHaveBeenLastCalledWith(undefined, 'suspended');
    expect(t.core.handleAuthCode('ACCOUNT_PENDING')).toBe(true);
    expect(t.endSession).toHaveBeenLastCalledWith(undefined, 'pending');
    expect(t.core.handleAuthCode('UNAUTHORIZED')).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.refreshAccess).toHaveBeenCalledTimes(1);
    expect(t.core.handleAuthCode('VERSION_CONFLICT')).toBe(false);
    expect(t.core.handleAuthCode('TIMEOUT')).toBe(false);
  });
});

describe('connect sonrası senkron beklemesi', () => {
  it('5 sn içinde session_sync gelmezse senkron ister; o da düşerse bağlantıyı yeniler', async () => {
    const t = setup();
    t.core.onConnect();
    expect(t.setConn).toHaveBeenCalledWith('connected');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.requestSync).toHaveBeenCalledTimes(1);
    const onFail = t.requestSync.mock.calls[0]![0] as () => void;
    onFail();
    expect(t.state.socket!.disconnect).toHaveBeenCalled();
    expect(t.state.socket!.connect).toHaveBeenCalled();
  });

  it('session_sync zamanında gelirse istek atılmaz', async () => {
    const t = setup();
    t.core.onConnect();
    t.core.onSync();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.requestSync).not.toHaveBeenCalled();
  });
});
