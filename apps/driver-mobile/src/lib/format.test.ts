import { describe, expect, it } from 'vitest';
import { phoneSchema } from '@duraknet/shared';
import { formatClock, formatPhoneInput, formatPlate, formatVehicle, formatWait, maskPhone, formatDistance, formatElapsed, formatElapsedA11y } from './format';

describe('telefon', () => {
  it('yazılanı 05XX XXX XX XX biçimine getirir', () => {
    expect(formatPhoneInput('05321234567')).toBe('0532 123 45 67');
    expect(formatPhoneInput('5321234567')).toBe('0532 123 45 67');
    expect(formatPhoneInput('+90 532 123 45 67')).toBe('0532 123 45 67');
    expect(formatPhoneInput('0532')).toBe('0532');
    expect(formatPhoneInput('')).toBe('');
    expect(formatPhoneInput('053212345678999')).toBe('0532 123 45 67');
  });

  it('biçimlenmiş değer sözleşme şemasından geçer', () => {
    expect(phoneSchema.parse(formatPhoneInput('5321234567'))).toBe('+905321234567');
  });

  it('maskeler: yalnızca ilk hane ve son iki hane görünür', () => {
    expect(maskPhone('+905321234567')).toBe('+90 5** *** ** 67');
    expect(maskPhone('12')).toBe('*** 12');
  });
});

describe('plaka / süre / araç', () => {
  it('plakayı boşluklu gösterir', () => {
    expect(formatPlate('34ABC123')).toBe('34 ABC 123');
    expect(formatPlate('06a1234')).toBe('06 A 1234');
    expect(formatPlate('XYZ')).toBe('XYZ');
  });
  it('bekleme süresini yazar', () => {
    expect(formatWait(720_000)).toBe('12 dk');
    expect(formatWait(45_000)).toBe('45 sn');
    expect(formatWait(0)).toBe('1 sn');
    expect(formatClock(708_000)).toBe('11:48');
  });
  it('aracı renk + model olarak birleştirir', () => {
    expect(formatVehicle('Beyaz', 'Fiat Egea')).toBe('Beyaz Fiat Egea');
    expect(formatVehicle(null, ' ')).toBeNull();
  });
});

describe('Faz 3 biçimleri', () => {
  it('formatDistance: < 1000 m metre, ≥ 1000 m Türkçe ondalık virgüllü km', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(999.7)).toBe('1,0 km');
    expect(formatDistance(1200)).toBe('1,2 km');
    expect(formatDistance(12_000)).toBe('12,0 km');
    expect(formatDistance(-5)).toBe('0 m');
  });

  it('formatElapsed: sn / dk sn / sa dk; negatif 0', () => {
    expect(formatElapsed(42_000)).toBe('42 sn');
    expect(formatElapsed(59_999)).toBe('59 sn');
    expect(formatElapsed(185_000)).toBe('3 dk 05 sn');
    expect(formatElapsed(60_000)).toBe('1 dk 00 sn');
    expect(formatElapsed(72 * 60_000)).toBe('1 sa 12 dk');
    expect(formatElapsed(-5000)).toBe('0 sn');
  });

  it('formatElapsedA11y yalnızca dakika eşiklerini söyler', () => {
    expect(formatElapsedA11y(30_000)).toBe('1 dakikadan az');
    expect(formatElapsedA11y(130_000)).toBe('2 dakika');
    expect(formatElapsedA11y(75 * 60_000)).toBe('1 saat 15 dakika');
  });
});
