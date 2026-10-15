import { describe, expect, it } from 'vitest';
import { approvePath, formatCreatedAt, pendingListPath, removeById, vehicleLabel } from './pending';

describe('bekleyen hesaplar', () => {
  it('yolları kurar', () => {
    expect(pendingListPath('drivers')).toBe('/admin/drivers?status=pending');
    expect(pendingListPath('stands')).toBe('/admin/stands?status=pending');
    expect(approvePath('stands', 'abc')).toBe('/admin/stands/abc/approve');
  });
  it('onaylanan satırı çıkarır', () => {
    const l = [{ id: 'a' }, { id: 'b' }];
    expect(removeById(l, 'a')).toEqual([{ id: 'b' }]);
    expect(removeById(l, 'x')).toEqual(l);
  });
  it('araç etiketi', () => {
    expect(vehicleLabel('Fiat Egea', 'Sarı')).toBe('Fiat Egea · Sarı');
    expect(vehicleLabel(null, 'Sarı')).toBe('Sarı');
    expect(vehicleLabel(' ', null)).toBe('—');
  });
  it('geçersiz tarih tire olur', () => {
    expect(formatCreatedAt('bozuk')).toBe('—');
    expect(formatCreatedAt('2026-10-07T20:30:00Z')).toContain('2026');
  });
});
