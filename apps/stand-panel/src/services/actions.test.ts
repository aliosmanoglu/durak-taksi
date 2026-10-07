import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { cancelRide, completeRide } from './actions';
import { applyCreated } from '../lib/rides';
import { T } from '../lib/texts';
import { updateRides, useStore } from '../store';

const RIDE = 'r1';

function seed() {
  updateRides((s) =>
    applyCreated(s, { rideId: RIDE, shortCode: 'AB12', pickup: { lat: 41, lng: 29 }, pickupAddress: 'Adres' }, Date.now()),
  );
}
const ride = () => useStore.getState().ridesState.rides[RIDE];
const empty = () => useStore.setState({ ridesState: { rides: {}, archive: [], synced: true } });

beforeEach(() => {
  vi.clearAllMocks();
  h.handleAuthCode.mockReturnValue(false);
  empty();
  seed();
});

describe.each([
  ['cancelRide', () => cancelRide(RIDE)],
  ['completeRide', () => completeRide(RIDE)],
])('%s ack yorumlama', (_name, run) => {
  it('TIMEOUT: sonuç bilinmiyor, senkron istenir, quiet işaretlenmez', async () => {
    h.emitAck.mockResolvedValue({ ok: false, code: 'TIMEOUT' });
    expect(await run()).toEqual({ kind: 'unknown' });
    expect(ride()?.unknown).toBe(true);
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    expect(h.markQuiet).not.toHaveBeenCalled();
  });

  it.each(['VERSION_CONFLICT', 'INVALID_TRANSITION', 'NOT_FOUND'] as const)(
    '%s: changed, markQuiet + requestSync, yerelde kapatma yok',
    async (code) => {
      h.emitAck.mockResolvedValue({ ok: false, code });
      expect(await run()).toEqual({ kind: 'changed' });
      expect(h.markQuiet).toHaveBeenCalledWith(RIDE);
      expect(h.requestSync).toHaveBeenCalledTimes(1);
      expect(ride()?.status).not.toBe('cancelled');
      expect(ride()?.status).not.toBe('completed');
    },
  );

  it('ok: yerelde kapanır', async () => {
    h.emitAck.mockResolvedValue({ ok: true, data: undefined });
    expect(await run()).toEqual({ kind: 'ok' });
    expect(['cancelled', 'completed']).toContain(ride()?.status);
  });

  it('bilinmeyen ride: changed, emit yok', async () => {
    empty();
    expect(await run()).toEqual({ kind: 'changed' });
    expect(h.emitAck).not.toHaveBeenCalled();
  });

  it('NETWORK: anlaşılır Türkçe hata, senkron yok', async () => {
    h.emitAck.mockResolvedValue({ ok: false, code: 'NETWORK' });
    expect(await run()).toEqual({ kind: 'error', message: T.err.network });
    expect(h.requestSync).not.toHaveBeenCalled();
  });
});

describe('cancelRide', () => {
  it('sürümü ve kısaltılmış sebebi gönderir', async () => {
    h.emitAck.mockResolvedValue({ ok: true, data: undefined });
    await cancelRide(RIDE, `  ${'x'.repeat(200)} `);
    const payload = h.emitAck.mock.calls[0]![1] as { rideId: string; version: number; reason: string };
    expect(payload.rideId).toBe(RIDE);
    expect(payload.version).toBe(ride()!.version);
    expect(payload.reason).toHaveLength(120);
  });

  it('ACCOUNT_SUSPENDED oturum akışına yönlendirilir', async () => {
    h.emitAck.mockResolvedValue({ ok: false, code: 'ACCOUNT_SUSPENDED' });
    h.handleAuthCode.mockReturnValue(true);
    const r = await cancelRide(RIDE);
    expect(h.handleAuthCode).toHaveBeenCalledWith('ACCOUNT_SUSPENDED');
    expect(r.kind).toBe('error');
  });
});

describe('completeRide', () => {
  it('RATE_LIMITED: hata mesajı döner', async () => {
    h.emitAck.mockResolvedValue({ ok: false, code: 'RATE_LIMITED' });
    expect(await completeRide(RIDE)).toEqual({ kind: 'error', message: T.form.err.rateLimited });
  });
});
