import { describe, expect, it } from 'vitest';
import { phoneSchema } from '@duraknet/shared';
import { formatClock, formatPhoneInput, formatPlate, formatVehicle, formatWait, maskPhone } from './format';

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
