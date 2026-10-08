import { describe, expect, it } from 'vitest';
import type { RideSnapshot } from '@duraknet/shared';
import {
  LOCATION_STALE_MS, TS_SKEW_TOLERANCE_MS, applyDriverLocation, initialDriverLocs, isLocationStale, locationAgeMs, mapVehicles,
  pruneLocations, seedFromSync,
} from './driver-locations';
import {
  applyCancelled, applyCompleted, applyDriverCancelled, applyMatched, applySearching, initialRidesState, type RidesState,
} from './rides';

const ID = '11111111-1111-4111-8111-111111111111';
const DRV = { id: '33333333-3333-4333-8333-333333333333', name: 'Ahmet Y.', plate: '34ABC123', vehicle: 'Egea', phone: '+905321234567' };
const T0 = 1_800_000_000_000;
const P1 = { lat: 41, lng: 29 };
const P2 = { lat: 41.001, lng: 29.001 };
const SEARCH = { rideId: ID, wave: 1, radiusM: 2000, notifiedCount: 1, searchingSince: new Date(T0).toISOString(), version: 1 };

function matchedState(): RidesState {
  const s = applySearching(initialRidesState(), SEARCH, T0);
  return applyMatched(s, { rideId: ID, driver: DRV, distanceM: 500, version: 2 }, T0);
}
const ev = (ts: number, location = P1) => ({ rideId: ID, location, ts });

describe('applyDriverLocation', () => {
  it('matched ride için konumu kaydeder', () => {
    const l = applyDriverLocation(initialDriverLocs(), matchedState(), ev(100), T0);
    expect(l[ID]).toMatchObject({ location: P1, ts: 100, receivedAtMs: T0 });
  });
  it('matched olmayan veya bilinmeyen ride için yok sayar', () => {
    const searching = applySearching(initialRidesState(), SEARCH, T0);
    expect(applyDriverLocation(initialDriverLocs(), searching, ev(100), T0)).toEqual({});
    expect(applyDriverLocation(initialDriverLocs(), initialRidesState(), ev(100), T0)).toEqual({});
  });
  it('toleranstan fazla eski ts yok sayılır; tolerans içindeki sapma kabul edilir', () => {
    const rs = matchedState();
    const a = applyDriverLocation(initialDriverLocs(), rs, ev(10_000, P1), T0);
    expect(applyDriverLocation(a, rs, ev(10_000 - TS_SKEW_TOLERANCE_MS - 1, P2), T0 + 1)).toBe(a);
    expect(applyDriverLocation(a, rs, ev(10_000 - 500, P2), T0 + 1)[ID]!.location).toEqual(P2);
    expect(applyDriverLocation(a, rs, ev(20_000, P2), T0 + 1)[ID]!.location).toEqual(P2);
  });
  it('kayıt eşleşen şoförün kimliğini taşır', () => {
    expect(applyDriverLocation(initialDriverLocs(), matchedState(), ev(100), T0)[ID]!.driverId).toBe(DRV.id);
  });
});

describe('seedFromSync', () => {
  const snap = (status: RideSnapshot['status'], location?: typeof P1) =>
    ({ rideId: ID, status, driver: { ...DRV, location } }) as unknown as RideSnapshot;
  it('matched snapshot driver.location ilk konum olur; sonraki event ezer', () => {
    const l = seedFromSync(initialDriverLocs(), [snap('matched', P1)], T0);
    expect(l[ID]).toMatchObject({ location: P1, ts: 0 });
    expect(applyDriverLocation(l, matchedState(), ev(5, P2), T0 + 1)[ID]!.location).toEqual(P2);
  });
  it('reconnect sırasında şoför A -> B değiştiyse eski şoförün konumu yeni şoföre taşınmaz', () => {
    const old = applyDriverLocation(initialDriverLocs(), matchedState(), ev(100, P1), T0);
    const other = '44444444-4444-4444-8444-444444444444';
    const bSnap = (location?: typeof P1) =>
      ({ rideId: ID, status: 'matched', driver: { ...DRV, id: other, location } }) as unknown as RideSnapshot;
    expect(seedFromSync(old, [bSnap(P2)], T0 + 1)[ID]).toMatchObject({ driverId: other, location: P2, ts: 0 });
    expect(seedFromSync(old, [bSnap()], T0 + 1)).toEqual({});
  });
  it('prune: ride başka şoföre geçtiyse eski kayıt silinir', () => {
    const old = applyDriverLocation(initialDriverLocs(), matchedState(), ev(100, P1), T0);
    const rs = matchedState();
    const swapped = { ...rs, rides: { ...rs.rides, [ID]: { ...rs.rides[ID]!, driver: { ...DRV, id: 'x' } } } };
    expect(pruneLocations(old, swapped)).toEqual({});
  });
  it('mevcut konumu ezmez; konumsuz veya matched olmayanı eklemez', () => {
    const have = applyDriverLocation(initialDriverLocs(), matchedState(), ev(100, P2), T0);
    expect(seedFromSync(have, [snap('matched', P1)], T0 + 1)).toBe(have);
    expect(seedFromSync(initialDriverLocs(), [snap('matched')], T0)).toEqual({});
    expect(seedFromSync(initialDriverLocs(), [snap('searching', P1)], T0)).toEqual({});
  });
});

describe('pruneLocations', () => {
  const withLoc = () => applyDriverLocation(initialDriverLocs(), matchedState(), ev(100), T0);
  it('matched iken korur', () => {
    const l = withLoc();
    expect(pruneLocations(l, matchedState())).toBe(l);
  });
  it('completed / cancelled / şoför iptali sonrası temizler', () => {
    const rs = matchedState();
    expect(pruneLocations(withLoc(), applyCompleted(rs, { rideId: ID, completedAt: 'x', version: 3 }, T0))).toEqual({});
    expect(pruneLocations(withLoc(), applyCancelled(rs, { rideId: ID, version: 3 }, T0))).toEqual({});
    expect(
      pruneLocations(withLoc(), applyDriverCancelled(rs, { rideId: ID, driverName: 'A', plate: 'P', version: 3 }, T0)),
    ).toEqual({});
  });
});

describe('tazelik ve mapVehicles', () => {
  it('20 sn dolunca eski sayılır', () => {
    const l = applyDriverLocation(initialDriverLocs(), matchedState(), ev(100), T0)[ID]!;
    expect(isLocationStale(l, T0 + LOCATION_STALE_MS - 1)).toBe(false);
    expect(isLocationStale(l, T0 + LOCATION_STALE_MS)).toBe(true);
    expect(locationAgeMs(l, T0 - 500)).toBe(0);
  });
  it('plaka ve yaş bilgisini verir', () => {
    const rs = matchedState();
    const l = applyDriverLocation(initialDriverLocs(), rs, ev(100), T0);
    expect(mapVehicles(l, rs, T0 + 7_900)).toEqual([
      { rideId: ID, plate: '34ABC123', location: P1, heading: undefined, stale: false, ageSec: 7 },
    ]);
    expect(mapVehicles(l, rs, T0 + 25_000)[0]!.stale).toBe(true);
  });
});
