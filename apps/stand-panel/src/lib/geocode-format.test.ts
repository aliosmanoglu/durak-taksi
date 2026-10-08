import { describe, expect, it } from 'vitest';
import { formatNominatimAddress } from './geocode-format';

describe('formatNominatimAddress', () => {
  it('cadde + no + semt', () => {
    expect(
      formatNominatimAddress({ road: 'Moda Caddesi', house_number: '12', suburb: 'Caferağa', city_district: 'Kadıköy' }),
    ).toBe('Moda Cd. 12, Caferağa, Kadıköy');
  });
  it('yol yoksa display_name\'e düşer; hiçbiri yoksa null', () => {
    expect(formatNominatimAddress({}, 'Bir Yer, İstanbul')).toBe('Bir Yer, İstanbul');
    expect(formatNominatimAddress(undefined, '  ')).toBeNull();
  });
  it('tekrarlayan parçalar birleşir', () => {
    expect(formatNominatimAddress({ road: 'X Sokak', town: 'Çankaya' })).toBe('X Sk., Çankaya');
  });
});
