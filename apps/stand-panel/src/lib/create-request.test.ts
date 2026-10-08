import { describe, expect, it } from 'vitest';
import { rideCreateSchema } from '@duraknet/shared';
import {
  CREATE_AUTO_RETRIES,
  PENDING_CREATE_TTL_MS,
  createSignature,
  isRetryOfPending,
  newClientRequestId,
  requestIdFor,
  shouldAutoRetry,
} from './create-request';

const base = { pickup: { lat: 41.01, lng: 28.97 }, pickupAddress: 'Adres 1' };

describe('createSignature', () => {
  it('aynı içerik aynı imza, herhangi bir alan değişince farklı', () => {
    expect(createSignature(base)).toBe(createSignature({ ...base }));
    expect(createSignature(base)).not.toBe(createSignature({ ...base, pickupAddress: 'Adres 2' }));
    expect(createSignature(base)).not.toBe(createSignature({ ...base, pickup: { lat: 41.02, lng: 28.97 } }));
    expect(createSignature(base)).not.toBe(createSignature({ ...base, notes: 'Hastane' }));
    expect(createSignature(base)).not.toBe(createSignature({ ...base, dropoffAddress: 'X' }));
  });
});

describe('requestIdFor / isRetryOfPending', () => {
  const sig = createSignature(base);
  const pending = { clientRequestId: 'id-1', signature: sig, sentAtMs: 1_000 };

  it('bekleyen yok → yeni kimlik', () => {
    expect(requestIdFor(null, sig, 2_000, () => 'new')).toEqual({ id: 'new', retry: false });
  });

  it('aynı içerik + taze → aynı kimlik (yeniden deneme)', () => {
    expect(requestIdFor(pending, sig, 2_000, () => 'new')).toEqual({ id: 'id-1', retry: true });
    expect(isRetryOfPending(pending, sig, 1_000 + PENDING_CREATE_TTL_MS)).toBe(true);
  });

  it('içerik değişti → yeni kimlik', () => {
    expect(requestIdFor(pending, createSignature({ ...base, pickupAddress: 'Başka' }), 2_000, () => 'new')).toEqual({
      id: 'new',
      retry: false,
    });
  });

  it('kayıt eskidi (TTL) → yeni kimlik', () => {
    expect(isRetryOfPending(pending, sig, 1_000 + PENDING_CREATE_TTL_MS + 1)).toBe(false);
    expect(requestIdFor(pending, sig, 1_000 + PENDING_CREATE_TTL_MS + 1, () => 'new').id).toBe('new');
  });

  it('başarıdan / çözülmeden sonra (pending null) aynı içerik yeni kimlik alır', () => {
    let n = 0;
    const gen = () => `g${++n}`;
    expect(requestIdFor(null, sig, 1, gen).id).toBe('g1');
    expect(requestIdFor(null, sig, 2, gen).id).toBe('g2');
  });
});

describe('shouldAutoRetry', () => {
  it('yalnızca TIMEOUT, bağlıyken ve sınır dolmadan', () => {
    expect(shouldAutoRetry('TIMEOUT', 0, true)).toBe(true);
    expect(shouldAutoRetry('TIMEOUT', CREATE_AUTO_RETRIES, true)).toBe(false);
    expect(shouldAutoRetry('TIMEOUT', 0, false)).toBe(false);
    expect(shouldAutoRetry('NETWORK', 0, true)).toBe(false);
    expect(shouldAutoRetry('VALIDATION_ERROR', 0, true)).toBe(false);
    expect(shouldAutoRetry('RATE_LIMITED', 0, true)).toBe(false);
  });
});

describe('newClientRequestId', () => {
  it('sözleşme şemasından (uuid) geçer ve her seferinde farklıdır', () => {
    const a = newClientRequestId();
    const b = newClientRequestId();
    expect(a).not.toBe(b);
    expect(rideCreateSchema.safeParse({ ...base, clientRequestId: a }).success).toBe(true);
  });

  it('randomUUID yokken getRandomValues yedeği geçerli v4 üretir', () => {
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: real.getRandomValues.bind(real) },
    });
    try {
      const id = newClientRequestId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(rideCreateSchema.safeParse({ ...base, clientRequestId: id }).success).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: real });
    }
  });
});
