import { describe, expect, it } from 'vitest';
import { latLngSchema, rideCreateSchema, RIDE_STATUSES } from './index';

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
