import { describe, expect, it } from 'vitest';
import { addressMismatch, createPacer } from './pacer';

describe('createPacer', () => {
  it('ilk istek beklemez, ardışıklar 1 sn aralıkla dizilir', () => {
    const p = createPacer(1000);
    expect(p.reserve(10_000)).toBe(0);
    expect(p.reserve(10_100)).toBe(900);
    expect(p.reserve(10_100)).toBe(1900);
  });
  it('yeterince bekleyen istek gecikmez', () => {
    const p = createPacer(1000);
    p.reserve(0);
    expect(p.reserve(5_000)).toBe(0);
  });
});

describe('addressMismatch', () => {
  it('yalnızca elle düzenlenmiş adres + pin hareketinde uyarır', () => {
    expect(addressMismatch(true, true)).toBe(true);
    expect(addressMismatch(false, true)).toBe(false);
    expect(addressMismatch(true, false)).toBe(false);
  });
});
