import { describe, expect, it } from 'vitest';
import type { RideSnapshot } from '@duraknet/shared';
import { ACTION_LOCK_MS, MAX_LISTED_REQUESTS } from '../constants';
import { initialPresence } from '../presence/state';
import { T } from '../texts';
import { initialRides } from './state';
import { deriveDetail, deriveRequests } from './ride-view';
import type { RideCtx } from './transitions';

const NOW = 1_800_000_000_000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const req = (n: number, distanceM: number, p: Record<string, unknown> = {}) => ({
  rideId: uuid(n),
  shortCode: `K${n}`,
  pickup: { lat: 41, lng: 29 },
  pickupAddress: `Adres ${n}`,
  standName: 'Durak',
  distanceM,
  createdAt: new Date(NOW - 130_000).toISOString(),
  version: 1,
  serverNow: new Date(NOW).toISOString(),
  ...p,
});
const ctx = (p: Partial<RideCtx> = {}): RideCtx => ({
  ...initialRides(),
  ...initialPresence(),
  conn: 'connected',
  server: 'available',
  syncPending: false,
  ...p,
});
const ride = (p: Partial<RideSnapshot> = {}): RideSnapshot => ({
  rideId: uuid(1),
  shortCode: 'K7M2QX',
  status: 'matched',
  version: 3,
  stand: { id: uuid(90), name: 'Durak', phone: '+902161234567', location: { lat: 41, lng: 29 } },
  pickup: { lat: 41, lng: 29 },
  pickupAddress: 'Moda',
  createdAt: new Date(NOW).toISOString(),
  ...p,
});

describe('D1 görünümü', () => {
  it('odaklı kart, geçen süre (sunucu farkıyla), mesafe, etkin düğmeler', () => {
    const s = ctx({ requests: [req(1, 1250), req(2, 3400)], focusedId: uuid(1), unseen: [uuid(2)] });
    const v = deriveRequests(s, NOW);
    expect(v.focused?.rideId).toBe(uuid(1));
    expect(v.others.map((r) => r.rideId)).toEqual([uuid(2)]);
    expect(v.total).toBe(2);
    expect(v.elapsedText).toBe(T.ride.req.elapsed('2 dk 10 sn'));
    expect(v.distanceText).toBe('1,3 km');
    expect(v.canAct).toBe(true);
    expect(v.focusedIsNew).toBe(false);
  });

  it('cihaz saati geride olsa da süre doğru: clockOffsetMs uygulanır', () => {
    const s = ctx({ requests: [req(1, 100)], focusedId: uuid(1), clockOffsetMs: 600_000 });
    // createdAt = NOW-130 sn; sunucu saati = NOW+10 dk → 12 dk 10 sn
    expect(deriveRequests(s, NOW).elapsedText).toBe(T.ride.req.elapsed('12 dk 10 sn'));
  });

  it('700 ms kilit, bağlantı yok ve kabul sürüyor durumunda düğmeler kapanır', () => {
    const base = { requests: [req(1, 100)], focusedId: uuid(1) };
    expect(deriveRequests(ctx({ ...base, actionLockedUntil: NOW + ACTION_LOCK_MS }), NOW)).toMatchObject({
      locked: true,
      canAct: false,
    });
    expect(deriveRequests(ctx({ ...base, conn: 'disconnected' }), NOW)).toMatchObject({ offline: true, canAct: false });
    expect(
      deriveRequests(ctx({ ...base, accepting: { rideId: uuid(1), timedOut: false } }), NOW),
    ).toMatchObject({ accepting: true, canAct: false, waiting: false });
    expect(deriveRequests(ctx({ ...base, accepting: { rideId: uuid(1), timedOut: true } }), NOW).waiting).toBe(true);
  });

  it('başka şoföre giden (taken) kartta düğme yok; toplamdan düşer', () => {
    const s = ctx({ requests: [{ ...req(1, 100), taken: true }, req(2, 200)], focusedId: uuid(1) });
    const v = deriveRequests(s, NOW);
    expect(v.canAct).toBe(false);
    expect(v.total).toBe(1);
  });

  it('en çok 10 çağrı listelenir, fazlası "+n çağrı daha"', () => {
    const list = Array.from({ length: 14 }, (_, i) => req(i + 1, (i + 1) * 100));
    const v = deriveRequests(ctx({ requests: list, focusedId: uuid(1) }), NOW);
    expect(1 + v.others.length).toBe(MAX_LISTED_REQUESTS);
    expect(v.moreCount).toBe(4);
  });

  it('çok yeni çağrı "az önce"', () => {
    const s = ctx({ requests: [req(1, 100, { createdAt: new Date(NOW - 1000).toISOString() })], focusedId: uuid(1) });
    expect(deriveRequests(s, NOW).elapsedText).toBe(T.ride.req.justNow);
  });
});

describe('D2 görünümü', () => {
  const base = { activeRide: ride(), server: 'busy' as const, tracking: true };

  it('normal: tüm eylemler etkin, konum paylaşılıyor', () => {
    const v = deriveDetail(ctx(base));
    expect(v).toMatchObject({
      loading: false,
      offline: false,
      noLocation: false,
      sharing: true,
      serverActionsEnabled: true,
      navigateEnabled: true,
      callStandEnabled: true,
    });
  });

  it('çevrimdışı: NAVİGASYON etkin, TAMAMLA/iptal devre dışı', () => {
    const v = deriveDetail(ctx({ ...base, conn: 'disconnected' }));
    expect(v).toMatchObject({ offline: true, navigateEnabled: true, serverActionsEnabled: false });
  });

  it('soğuk açılış (sunucu durumu bilinmiyor): yükleniyor, NAVİGASYON etkin, diğerleri kapalı', () => {
    const v = deriveDetail(ctx({ ...base, server: 'unknown', conn: 'connecting' }));
    expect(v).toMatchObject({ loading: true, navigateEnabled: true, serverActionsEnabled: false, noLocation: false });
  });

  it('sync bekleniyorken sunucu eylemleri kapalı', () => {
    expect(deriveDetail(ctx({ ...base, syncPending: true })).serverActionsEnabled).toBe(false);
  });

  it('yeniden giriş: server offline → "Konumunuz paylaşılmıyor" + KONUM PAYLAŞ; eylemler yine etkin', () => {
    const v = deriveDetail(ctx({ activeRide: ride(), server: 'offline' }));
    expect(v).toMatchObject({ noLocation: true, sharing: false, serverActionsEnabled: true, navigateEnabled: true });
  });

  it('sunucu busy ama konum görevi çalışmıyor: KONUM PAYLAŞ gösterilir, paylaşılıyor denmez', () => {
    const v = deriveDetail(ctx({ activeRide: ride(), server: 'busy', tracking: false }));
    expect(v).toMatchObject({ noLocation: true, sharing: false, serverActionsEnabled: true });
  });

  it('eylem sürerken diğer sunucu eylemleri kapalı', () => {
    const v = deriveDetail(ctx({ ...base, rideAction: 'completing' }));
    expect(v).toMatchObject({ completing: true, serverActionsEnabled: false });
  });

  it('durak telefonu yoksa DURAĞI ARA gizlenir', () => {
    const r = ride({ stand: { ...ride().stand, phone: '  ' } });
    expect(deriveDetail(ctx({ activeRide: r, server: 'busy' })).callStandEnabled).toBe(false);
  });
});
