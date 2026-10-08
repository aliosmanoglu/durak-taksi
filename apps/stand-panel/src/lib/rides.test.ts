import { describe, expect, it } from 'vitest';
import type { RideSnapshot } from '@duraknet/shared';
import {
  applyCancelled,
  applyCompleted,
  applyCreated,
  applyDriverCancelled,
  applyMatched,
  applySearching,
  applySessionSync,
  applyStillOpen,
  closeLocal,
  dismissDriverCancelled,
  dismissStillOpen,
  findDuplicate,
  initialRidesState,
  needsDetailSync,
  orderedRides,
  setUnknown,
  tickArchive,
  TERMINAL_VISIBLE_MS,
  ARCHIVE_MAX,
  CREATE_GRACE_MS,
  type RidesState,
} from './rides';
import { distanceMeters } from './geo';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const DRV = { id: '33333333-3333-4333-8333-333333333333', name: 'Ahmet Y.', plate: '34ABC123', phone: '+905321234567' };
const T0 = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

const searching = (rideId: string, version: number, extra = {}) => ({
  rideId, wave: 1, radiusM: 2000, notifiedCount: 3, searchingSince: iso(T0), version, ...extra,
});

function created(state = initialRidesState(), rideId = ID, now = T0): RidesState {
  return applyCreated(
    state,
    { rideId, shortCode: 'K7M2QX', pickup: { lat: 41, lng: 29 }, pickupAddress: 'Moda Cd. 12' },
    now,
  );
}

const snap = (over: Partial<RideSnapshot> = {}): RideSnapshot => ({
  rideId: ID, shortCode: 'K7M2QX', status: 'searching', version: 2,
  stand: { id: '44444444-4444-4444-8444-444444444444', name: 'Kadıköy', phone: '+902161112233', location: { lat: 41, lng: 29 } },
  pickup: { lat: 41, lng: 29 }, pickupAddress: 'Moda Cd. 12', createdAt: iso(T0), ...over,
});

describe('version kapısı', () => {
  it('düşük sürümlü event yok sayılır, eşit/yüksek uygulanır', () => {
    let s = applySearching(created(), searching(ID, 5), T0);
    expect(s.rides[ID]?.version).toBe(5);
    const same = applySearching(s, searching(ID, 4, { wave: 9 }), T0);
    expect(same).toBe(s);
    s = applySearching(s, searching(ID, 5, { wave: 2 }), T0);
    expect(s.rides[ID]?.wave).toBe(2);
    s = applySearching(s, searching(ID, 6, { wave: 3 }), T0);
    expect(s.rides[ID]?.wave).toBe(3);
  });

  it('eski matched, yeni searching durumunu geri almaz', () => {
    let s = applyMatched(created(), { rideId: ID, driver: DRV, distanceM: 900, version: 3 }, T0);
    s = applyDriverCancelled(s, { rideId: ID, driverName: DRV.name, plate: DRV.plate, version: 4 }, T0);
    const before = s;
    s = applyMatched(s, { rideId: ID, driver: DRV, distanceM: 900, version: 3 }, T0);
    expect(s).toBe(before);
    expect(s.rides[ID]?.status).toBe('searching');
  });

  it('terminal ride için hiçbir event uygulanmaz', () => {
    let s = applySearching(created(), searching(ID, 1), T0);
    s = applyCancelled(s, { rideId: ID, version: 2, reason: 'x' }, T0);
    const before = s;
    expect(applySearching(s, searching(ID, 9), T0)).toBe(before);
    expect(applyMatched(s, { rideId: ID, driver: DRV, distanceM: 1, version: 9 }, T0)).toBe(before);
    expect(applyCompleted(s, { rideId: ID, completedAt: iso(T0), version: 9 }, T0)).toBe(before);
  });

  it('bilinmeyen ride için tamamlanma/iptal kart açmaz', () => {
    const s = initialRidesState();
    expect(applyCompleted(s, { rideId: ID, completedAt: iso(T0), version: 1 }, T0)).toBe(s);
    expect(applyCancelled(s, { rideId: ID, version: 1 }, T0)).toBe(s);
  });
});

describe('yaşam döngüsü', () => {
  it('created -> searching -> matched -> completed', () => {
    let s = created();
    expect(s.rides[ID]?.status).toBe('created');
    s = applySearching(s, searching(ID, 1, { notifiedCount: 0 }), T0);
    expect(s.rides[ID]).toMatchObject({ status: 'searching', wave: 1, notifiedCount: 0, shortCode: 'K7M2QX' });
    s = applyMatched(s, { rideId: ID, driver: DRV, distanceM: 1200, version: 2 }, T0 + 5000);
    expect(s.rides[ID]).toMatchObject({ status: 'matched', distanceM: 1200, driver: DRV });
    expect(s.rides[ID]?.flash?.kind).toBe('matched');
    s = applyCompleted(s, { rideId: ID, completedAt: iso(T0), version: 3 }, T0 + 9000);
    expect(s.rides[ID]).toMatchObject({ status: 'completed', closedAtMs: T0 + 9000 });
  });

  it('şoför iptali: searching döner, sayaç sıfırlanır, bant açılır', () => {
    let s = applyMatched(created(), { rideId: ID, driver: DRV, distanceM: 1, version: 2 }, T0);
    s = applyDriverCancelled(s, { rideId: ID, reason: 'Araç arızası', driverName: DRV.name, plate: DRV.plate, version: 3 }, T0 + 60_000);
    const r = s.rides[ID];
    expect(r).toMatchObject({ status: 'searching', driver: undefined, searchingSince: iso(T0 + 60_000) });
    expect(r?.driverCancelled).toEqual({ name: DRV.name, plate: DRV.plate, reason: 'Araç arızası', suspended: false });
    expect(dismissDriverCancelled(s, ID).rides[ID]?.driverCancelled).toBeUndefined();
  });

  it('askıya alma sebebi ayrı metne işaretlenir (E-3)', () => {
    const s = applyDriverCancelled(
      applyMatched(created(), { rideId: ID, driver: DRV, distanceM: 1, version: 2 }, T0),
      { rideId: ID, reason: 'driver_suspended', driverName: DRV.name, plate: DRV.plate, version: 3 },
      T0,
    );
    expect(s.rides[ID]?.driverCancelled?.suspended).toBe(true);
  });

  it('still_open bandı açılır, BEKLEMEYE DEVAM kapatır; matched kartta uygulanmaz', () => {
    let s = applySearching(created(), searching(ID, 1), T0);
    s = applyStillOpen(s, { rideId: ID, searchingSince: iso(T0), minutesOpen: 3, version: 1 }, T0);
    expect(s.rides[ID]?.stillOpenMinutes).toBe(3);
    s = dismissStillOpen(s, ID);
    expect(s.rides[ID]?.stillOpenMinutes).toBeUndefined();
    s = applyStillOpen(s, { rideId: ID, searchingSince: iso(T0), minutesOpen: 8, version: 1 }, T0);
    expect(s.rides[ID]?.stillOpenMinutes).toBe(8);
    const m = applyMatched(s, { rideId: ID, driver: DRV, distanceM: 1, version: 2 }, T0);
    expect(m.rides[ID]?.stillOpenMinutes).toBeUndefined();
    expect(applyStillOpen(m, { rideId: ID, searchingSince: iso(T0), minutesOpen: 9, version: 2 }, T0)).toBe(m);
  });

  it('kendi iptal ack\'i (closeLocal) kartı kapatır; terminalde etkisiz', () => {
    let s = applySearching(created(), searching(ID, 1), T0);
    s = closeLocal(s, ID, 'cancelled', T0, 'Yanlış adres');
    expect(s.rides[ID]).toMatchObject({ status: 'cancelled', cancelReason: 'Yanlış adres' });
    expect(closeLocal(s, ID, 'completed', T0)).toBe(s);
  });

  it('setUnknown yalnızca açık ride\'da çalışır', () => {
    let s = applySearching(created(), searching(ID, 1), T0);
    s = setUnknown(s, ID, true);
    expect(s.rides[ID]?.unknown).toBe(true);
    s = applySearching(s, searching(ID, 2), T0);
    expect(s.rides[ID]?.unknown).toBeUndefined();
  });
});

describe('event ack\'ten önce gelirse', () => {
  it('placeholder açılır, ack ayrıntıyı doldurur', () => {
    let s = applySearching(initialRidesState(), searching(ID, 1), T0);
    expect(s.rides[ID]?.detailsMissing).toBe(true);
    expect(needsDetailSync(s)).toBe(true);
    s = created(s);
    expect(s.rides[ID]).toMatchObject({ detailsMissing: false, pickupAddress: 'Moda Cd. 12', status: 'searching', version: 1 });
    expect(needsDetailSync(s)).toBe(false);
  });
});

describe('session_sync', () => {
  it('listeyi değiştirir; sunucuda olmayan açık ride silinir ve sayılır', () => {
    let s = applySearching(created(initialRidesState(), ID, T0 - 60_000), searching(ID, 1), T0);
    s = created(s, ID2, T0 - 60_000);
    const r = applySessionSync(s, [snap({ rideId: ID2, shortCode: 'M4PZ8C', version: 4 })], T0);
    expect(Object.keys(r.state.rides)).toEqual([ID2]);
    expect(r.closed).toBe(1);
    expect(r.state.synced).toBe(true);
  });

  it('yeni oluşturulan ride CREATE_GRACE_MS boyunca korunur', () => {
    const s = created(initialRidesState(), ID, T0);
    expect(applySessionSync(s, [], T0 + CREATE_GRACE_MS - 1).state.rides[ID]).toBeDefined();
    const later = applySessionSync(s, [], T0 + CREATE_GRACE_MS + 1);
    expect(later.state.rides[ID]).toBeUndefined();
    expect(later.closed).toBe(1);
  });

  it('quietIds\'teki ride silinir ama kapanan sayısına girmez', () => {
    const s = created(initialRidesState(), ID, T0 - 60_000);
    const r = applySessionSync(s, [], T0, new Set([ID]));
    expect(r.state.rides[ID]).toBeUndefined();
    expect(r.closed).toBe(0);
  });

  it('ilk senkron: iskeletten çıkar, kapanan sayısı 0', () => {
    const r = applySessionSync(initialRidesState(), [snap(), snap({ rideId: ID2, status: 'matched', version: 3, matchedAt: iso(T0), driver: { ...DRV } })], T0);
    expect(r.closed).toBe(0);
    expect(r.state.rides[ID2]).toMatchObject({ status: 'matched', driver: { name: 'Ahmet Y.' } });
    expect(r.state.rides[ID]?.searchingSince).toBe(iso(T0));
  });

  it('yerel sürüm yüksekse eski anlık görüntü geri almaz; placeholder ise sunucu ayrıntısı alınır', () => {
    const s = applySearching(created(), searching(ID, 7, { wave: 3 }), T0);
    const r = applySessionSync(s, [snap({ version: 5 })], T0);
    expect(r.state.rides[ID]).toMatchObject({ version: 7, wave: 3 });
    const p = applySearching(initialRidesState(), searching(ID, 7), T0);
    const r2 = applySessionSync(p, [snap({ version: 5 })], T0);
    expect(r2.state.rides[ID]).toMatchObject({ version: 5, pickupAddress: 'Moda Cd. 12' });
    expect(r2.state.rides[ID]?.detailsMissing).toBeUndefined();
  });

  it('aynı durumdaki ride için dalga/bildirim sayısı ve bantlar korunur', () => {
    let s = applySearching(created(), searching(ID, 2, { wave: 4, notifiedCount: 9 }), T0);
    s = applyStillOpen(s, { rideId: ID, searchingSince: iso(T0), minutesOpen: 3, version: 2 }, T0);
    const r = applySessionSync(s, [snap({ version: 2 })], T0);
    expect(r.state.rides[ID]).toMatchObject({ wave: 4, notifiedCount: 9, stillOpenMinutes: 3 });
  });

  it('süresi dolmamış terminal kart senkronda kalır', () => {
    let s = applySearching(created(), searching(ID, 1), T0);
    s = applyCancelled(s, { rideId: ID, version: 2 }, T0);
    const r = applySessionSync(s, [], T0 + 1000);
    expect(r.state.rides[ID]?.status).toBe('cancelled');
    expect(r.closed).toBe(0);
  });
});

describe('arşiv ("Son çağrılar")', () => {
  it('30 sn sonra taşınır, en çok 10 tutulur', () => {
    let s = initialRidesState();
    for (let i = 0; i < 12; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      s = applyCreated(s, { rideId: id, shortCode: `C${i}`, pickup: { lat: 1, lng: 1 }, pickupAddress: `A${i}` }, T0);
      s = closeLocal(s, id, i % 2 ? 'completed' : 'cancelled', T0 + i);
    }
    expect(tickArchive(s, T0 + TERMINAL_VISIBLE_MS - 1)).toBe(s);
    const t = tickArchive(s, T0 + TERMINAL_VISIBLE_MS + 100);
    expect(Object.keys(t.rides)).toHaveLength(0);
    expect(t.archive).toHaveLength(ARCHIVE_MAX);
    expect(t.archive[0]?.shortCode).toBe('C11');
    expect(t.archive[0]?.result).toBe('completed');
  });
});

describe('sıralama ve yinelenen çağrı', () => {
  it('yeni çağrı üstte', () => {
    let s = created(initialRidesState(), ID, T0);
    s = created(s, ID2, T0 + 10_000);
    expect(orderedRides(s).map((r) => r.rideId)).toEqual([ID2, ID]);
  });

  it('50 m içindeki açık çağrı bulunur, kapalı olan sayılmaz', () => {
    let s = created();
    const near = { lat: 41.0002, lng: 29 }; // ~22 m
    expect(findDuplicate(s, near, distanceMeters)?.rideId).toBe(ID);
    expect(findDuplicate(s, { lat: 41.002, lng: 29 }, distanceMeters)).toBeUndefined();
    s = closeLocal(s, ID, 'cancelled', T0);
    expect(findDuplicate(s, near, distanceMeters)).toBeUndefined();
  });
});
