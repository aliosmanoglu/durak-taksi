import { describe, expect, it } from 'vitest';
import {
  latLngSchema,
  rideCreateSchema,
  RIDE_STATUSES,
  DISPATCH,
  REMINDER,
  RIDE_HASH,
  redisKeys,
  DRIVER_EVENTS,
  STAND_EVENTS,
  RIDE_TRANSITIONS,
  TERMINAL_RIDE_STATUSES,
  canTransition,
  findRideTransition,
  rideRequestSchema,
  rideSnapshotSchema,
  rideSearchingSchema,
  rideMatchedSchema,
  rideDriverCancelledSchema,
  rideStillOpenSchema,
  rideCompletedSchema,
  rideCancelledSchema,
  rideTakenSchema,
  nearbyDriversSchema,
  rideDriverLocationSchema,
  rideCompleteSchema,
  rideCancelSchema,
  rideDriverCancelSchema,
  rideAcceptSchema,
  ERROR_CODES,
} from './index';

const id = '0b5f2c9e-6f3a-4d0e-9a51-1d2b3c4d5e6f';
const now = '2026-09-30T10:00:00.000Z';
const pt = { lat: 41, lng: 29 };

describe('shared sözleşme', () => {
  it('geçerli koordinatı kabul eder, sınır dışını reddeder', () => {
    expect(latLngSchema.safeParse({ lat: 41.0082, lng: 28.9784 }).success).toBe(true);
    expect(latLngSchema.safeParse({ lat: 91, lng: 28.9784 }).success).toBe(false);
  });

  it('ride_create yalnızca alış konumunu zorunlu tutar', () => {
    const ok = rideCreateSchema.safeParse({
      pickup: { lat: 41.0082, lng: 28.9784 },
      pickupAddress: 'Taksim Meydanı',
    });
    expect(ok.success).toBe(true);
    expect(rideCreateSchema.safeParse({ pickupAddress: 'x' }).success).toBe(false);
  });

  it('ride durumlarında ödeme/süre aşımı durumu yoktur', () => {
    expect(RIDE_STATUSES).toEqual(['created', 'searching', 'matched', 'completed', 'cancelled']);
  });
});

describe('ride payload şemaları', () => {
  it('RideRequest / RideSnapshot geçerli gövdeyi kabul eder, eksik/yanlış alanı reddeder', () => {
    const req = {
      rideId: id, shortCode: 'AB12CD', pickup: pt, pickupAddress: 'x',
      standName: 'D', distanceM: 120, createdAt: now, version: 1, serverNow: now,
    };
    expect(rideRequestSchema.safeParse(req).success).toBe(true);
    expect(rideRequestSchema.safeParse({ ...req, serverNow: undefined }).success).toBe(false);
    expect(rideRequestSchema.safeParse({ ...req, version: undefined }).success).toBe(false);
    const snap = {
      rideId: id, shortCode: 'AB12CD', status: 'matched', version: 2,
      stand: { id, name: 'D', phone: '+905551112233', location: pt },
      pickup: pt, pickupAddress: 'x', createdAt: now,
      driver: { id, name: 'A', plate: '34ABC123', phone: '+905551112244' },
    };
    expect(rideSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(rideSnapshotSchema.safeParse({ ...snap, status: 'timeout' }).success).toBe(false);
  });

  it('sunucu event payloadları version taşır', () => {
    const searching = { rideId: id, wave: 1, radiusM: 2000, notifiedCount: 3, searchingSince: now };
    expect(rideSearchingSchema.safeParse({ ...searching, version: 1 }).success).toBe(true);
    expect(rideSearchingSchema.safeParse(searching).success).toBe(false);
    expect(
      rideMatchedSchema.safeParse({
        rideId: id, driver: { id, name: 'A', plate: 'P', phone: '1' }, distanceM: 10, version: 2,
      }).success,
    ).toBe(true);
    expect(rideDriverCancelledSchema.safeParse({ rideId: id, driverName: 'A', plate: 'P', version: 3 }).success).toBe(true);
    expect(rideStillOpenSchema.safeParse({ rideId: id, searchingSince: now, minutesOpen: 3, version: 1 }).success).toBe(true);
    expect(rideCompletedSchema.safeParse({ rideId: id, completedAt: now, version: 4 }).success).toBe(true);
    expect(rideCompletedSchema.safeParse({ rideId: id, completedAt: 'dün', version: 4 }).success).toBe(false);
    expect(rideCancelledSchema.safeParse({ rideId: id, version: 4 }).success).toBe(true);
    expect(rideTakenSchema.safeParse({ rideId: id, version: 3 }).success).toBe(true);
    expect(rideTakenSchema.safeParse({ rideId: id }).success).toBe(false);
    expect(nearbyDriversSchema.safeParse({ drivers: [{ id, location: pt }] }).success).toBe(true);
    expect(rideDriverLocationSchema.safeParse({ rideId: id, location: pt, ts: 1 }).success).toBe(true);
  });

  it('istemci → sunucu ride payloadları uuid ve version ister', () => {
    expect(rideCompleteSchema.safeParse({ rideId: id, version: 2 }).success).toBe(true);
    expect(rideCompleteSchema.safeParse({ rideId: id }).success).toBe(false);
    expect(rideCancelSchema.safeParse({ rideId: 'x', version: 1 }).success).toBe(false);
    expect(rideDriverCancelSchema.safeParse({ rideId: id, version: 1, reason: 'a'.repeat(121) }).success).toBe(false);
    expect(rideAcceptSchema.safeParse({ rideId: id }).success).toBe(true);
  });

  it('ride_complete şoför ve durak event setinde; ride_completed ikisine de gider', () => {
    expect(DRIVER_EVENTS.rideComplete).toBe('ride_complete');
    expect(STAND_EVENTS.rideComplete).toBe('ride_complete');
    expect(DRIVER_EVENTS.rideCompleted).toBe('ride_completed');
    expect(STAND_EVENTS.rideCompleted).toBe('ride_completed');
  });

  it('ride hata kodları mevcut', () => {
    for (const c of ['RIDE_NOT_AVAILABLE', 'NOT_A_CANDIDATE', 'DRIVER_NOT_AVAILABLE', 'INVALID_TRANSITION', 'VERSION_CONFLICT']) {
      expect(ERROR_CODES).toContain(c);
    }
  });
});

describe('ride durum makinesi tablosu', () => {
  it('yalnızca beklenen geçişleri içerir', () => {
    const pairs = RIDE_TRANSITIONS.map((t) => `${t.from}>${t.to}:${t.reason}`).sort();
    expect(pairs).toEqual(
      [
        'created>searching:dispatch_started',
        'searching>matched:driver_accepted',
        'matched>searching:driver_cancelled',
        'matched>searching:driver_suspended',
        'searching>cancelled:stand_cancelled',
        'matched>cancelled:stand_cancelled',
        'searching>cancelled:stand_suspended',
        'matched>cancelled:stand_suspended',
        'matched>completed:completed',
      ].sort(),
    );
  });

  it('cancelled yalnızca durak aktörüyle; tek istisna durak askıya alma (system)', () => {
    for (const from of ['searching', 'matched'] as const) {
      expect(canTransition(from, 'cancelled', 'stand_cancelled', 'stand')).toBe(true);
      expect(canTransition(from, 'cancelled', 'stand_cancelled', 'driver')).toBe(false);
      expect(canTransition(from, 'cancelled', 'stand_cancelled', 'system')).toBe(false);
      expect(canTransition(from, 'cancelled', 'stand_suspended', 'system')).toBe(true);
      expect(canTransition(from, 'cancelled', 'stand_suspended', 'stand')).toBe(false);
      expect(canTransition(from, 'cancelled', 'stand_suspended', 'driver')).toBe(false);
    }
  });

  it('matched → completed şoför ve durak için geçerli, sistem için değil', () => {
    expect(canTransition('matched', 'completed', 'completed', 'driver')).toBe(true);
    expect(canTransition('matched', 'completed', 'completed', 'stand')).toBe(true);
    expect(canTransition('matched', 'completed', 'completed', 'system')).toBe(false);
  });

  it('matched → searching: şoför iptali (driver) ve askıya alma (system)', () => {
    expect(canTransition('matched', 'searching', 'driver_cancelled', 'driver')).toBe(true);
    expect(canTransition('matched', 'searching', 'driver_cancelled', 'stand')).toBe(false);
    expect(canTransition('matched', 'searching', 'driver_suspended', 'system')).toBe(true);
  });

  it('terminal durumlardan çıkış yok; geçersiz atlamalar reddedilir', () => {
    for (const s of TERMINAL_RIDE_STATUSES) expect(RIDE_TRANSITIONS.some((t) => t.from === s)).toBe(false);
    expect(findRideTransition('created', 'matched', 'driver_accepted')).toBeUndefined();
    expect(findRideTransition('searching', 'completed', 'completed')).toBeUndefined();
    expect(canTransition('created', 'cancelled', 'stand_cancelled', 'stand')).toBe(false);
    for (const t of RIDE_TRANSITIONS) {
      expect(RIDE_STATUSES).toContain(t.from);
      expect(RIDE_STATUSES).toContain(t.to);
    }
  });
});

describe('redis sözleşmesi (Faz 3)', () => {
  it('anahtarlar Bölüm 5 ile aynı', () => {
    expect(redisKeys.ride('r')).toBe('dn:ride:r');
    expect(redisKeys.rideCandidates('r')).toBe('dn:ride:r:candidates');
    expect(redisKeys.rideExcluded('r')).toBe('dn:ride:r:excluded');
    expect(redisKeys.driverRequests('d')).toBe('dn:driver:d:requests');
    expect(redisKeys.standActiveRides('s')).toBe('dn:stand:s:active_rides');
    expect(RIDE_HASH.driverId).toBe('driverId');
  });

  it('dispatch sabitleri', () => {
    expect(DISPATCH.WAVE_DELAY_S).toEqual([20, 20, 30]);
    expect(DISPATCH.CONTINUOUS_SCAN_EVERY_S).toBe(30);
    expect(DISPATCH.GEOSEARCH_COUNT).toBe(25);
    expect(DISPATCH.LOCATION_FRESH_MS).toBe(30_000);
    expect(REMINDER).toEqual({ FIRST_SEC: 180, EVERY_SEC: 300 });
  });
});
