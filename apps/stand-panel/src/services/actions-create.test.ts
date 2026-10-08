import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  emitAck: vi.fn(),
  markQuiet: vi.fn(),
  requestSync: vi.fn(),
  handleAuthCode: vi.fn(() => false),
}));

vi.mock('./realtime', () => ({
  emitAck: h.emitAck,
  markQuiet: h.markQuiet,
  requestSync: h.requestSync,
  handleAuthCode: h.handleAuthCode,
  serverNow: () => Date.now(),
}));
vi.mock('./session', () => ({ apiAuthed: vi.fn() }));
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  saveMe: vi.fn(),
  saveRecent: vi.fn(),
}));

import { createRide, isSafeRetry } from './actions';
import { CREATE_AUTO_RETRY_DELAY_MS } from '../lib/create-request';
import { initialRidesState } from '../lib/rides';
import { useStore } from '../store';

const INPUT = { pickup: { lat: 41, lng: 29 }, pickupAddress: 'Adres 1' };
const OK = { ok: true, data: { rideId: '0b0f3f0e-8f5a-4a5e-9a52-0c2d8f0b7d11', shortCode: 'AB12' } };
const TIMEOUT = { ok: false, code: 'TIMEOUT' };
const sent = () => h.emitAck.mock.calls.map((c) => (c[1] as { clientRequestId: string }).clientRequestId);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.handleAuthCode.mockReturnValue(false);
  useStore.setState({
    conn: 'connected',
    ridesState: initialRidesState(),
    pendingCreate: null,
    createLockUntil: 0,
    formNonce: 0,
  });
});
afterEach(() => vi.useRealTimers());

async function run(input = INPUT) {
  const p = createRide(input);
  await vi.advanceTimersByTimeAsync(CREATE_AUTO_RETRY_DELAY_MS + 10);
  return p;
}

describe('createRide clientRequestId', () => {
  it('her gönderime uuid kimliği ekler', async () => {
    h.emitAck.mockResolvedValue(OK);
    expect((await run()).ok).toBe(true);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('TIMEOUT: aynı kimlikle bir otomatik yeniden deneme; ikincisi başarılıysa temiz sonuç', async () => {
    h.emitAck.mockResolvedValueOnce(TIMEOUT).mockResolvedValueOnce(OK);
    expect((await run()).ok).toBe(true);
    const ids = sent();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(useStore.getState().pendingCreate).toBeNull();
    expect(useStore.getState().formNonce).toBe(1);
  });

  it('iki TIMEOUT: bekleyen kayıt kimliği saklar; aynı içerik kilide takılmadan AYNI kimlikle tekrar gönderilir', async () => {
    h.emitAck.mockResolvedValue(TIMEOUT);
    const r = await run();
    expect(r.ok).toBe(false);
    expect(sent()).toHaveLength(2);
    const pc = useStore.getState().pendingCreate!;
    expect(pc.clientRequestId).toBe(sent()[0]);
    expect(useStore.getState().createLockUntil).toBeGreaterThan(Date.now());
    expect(isSafeRetry(INPUT)).toBe(true);

    h.emitAck.mockClear();
    h.emitAck.mockResolvedValue(OK);
    expect((await run()).ok).toBe(true);
    expect(sent()).toEqual([pc.clientRequestId]);
  });

  it('içerik değişirse kilit uygulanır ve yeni kimlik gerekir', async () => {
    h.emitAck.mockResolvedValue(TIMEOUT);
    await run();
    h.emitAck.mockClear();
    const changed = { ...INPUT, pickupAddress: 'Adres 2' };
    expect(isSafeRetry(changed)).toBe(false);
    const r = await run(changed);
    expect(r.ok).toBe(false);
    expect(h.emitAck).not.toHaveBeenCalled();
  });

  it('başarıdan sonra aynı içerikli bilinçli ikinci çağrı YENİ kimlik alır', async () => {
    h.emitAck.mockResolvedValue(OK);
    await run();
    await run();
    const ids = sent();
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('TIMEOUT dışı hatalar otomatik yeniden denenmez', async () => {
    h.emitAck.mockResolvedValue({ ok: false, code: 'RATE_LIMITED' });
    await run();
    expect(h.emitAck).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pendingCreate).toBeNull();
  });

  it('bekleme sırasında bağlantı koparsa yeniden deneme yapılmaz', async () => {
    h.emitAck.mockImplementationOnce(async () => {
      useStore.setState({ conn: 'disconnected' });
      return TIMEOUT;
    });
    await run();
    expect(h.emitAck).toHaveBeenCalledTimes(1);
  });
});
