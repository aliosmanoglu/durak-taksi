import { describe, expect, it } from 'vitest';
import { rideSnapshotSchema, type RideSnapshot } from '@duraknet/shared';
import { ACTIVE_RIDE_MAX_BYTES, serializeActiveRide, summarizeActiveRide } from './persist';

const full = (p: Partial<RideSnapshot> = {}): RideSnapshot => ({
  rideId: '00000000-0000-4000-8000-000000000001',
  shortCode: 'K7M2QX',
  status: 'matched',
  version: 4,
  stand: { id: '00000000-0000-4000-8000-000000000090', name: 'Kadıköy Durağı', phone: '+902161234567', location: { lat: 41, lng: 29 } },
  pickup: { lat: 41.0082, lng: 28.9784 },
  pickupAddress: 'Moda Cd. 12',
  dropoff: { lat: 41.1, lng: 29.1 },
  dropoffAddress: 'Havalimanı',
  notes: 'Not',
  driver: { id: '00000000-0000-4000-8000-000000000091', name: 'Ali', plate: '34ABC123', phone: '+905551112233' },
  createdAt: '2026-09-30T10:00:00.000Z',
  matchedAt: '2026-09-30T10:01:00.000Z',
  ...p,
});

describe('activeRide özeti', () => {
  it('şoför, varış ve matchedAt atılır; şema geçerli kalır', () => {
    const s = summarizeActiveRide(full());
    expect(s).not.toHaveProperty('driver');
    expect(s).not.toHaveProperty('dropoff');
    expect(s).not.toHaveProperty('dropoffAddress');
    expect(rideSnapshotSchema.safeParse(s).success).toBe(true);
    expect(s).toMatchObject({ rideId: full().rideId, version: 4, pickupAddress: 'Moda Cd. 12' });
  });

  it('uzun not kısaltılır', () => {
    expect(summarizeActiveRide(full({ notes: 'x'.repeat(500) })).notes!.length).toBeLessThanOrEqual(80);
  });

  it('2 KB sınırını aşmaz; sığmayan girdide null döner', () => {
    const big = full({ notes: 'ş'.repeat(5000), pickupAddress: 'a'.repeat(5000), stand: { ...full().stand, name: 'd'.repeat(5000) } });
    const out = serializeActiveRide(big)!;
    expect(out).not.toBeNull();
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(ACTIVE_RIDE_MAX_BYTES);
    expect(rideSnapshotSchema.safeParse(JSON.parse(out)).success).toBe(true);
    expect(serializeActiveRide(full(), 50)).toBeNull();
  });
});
