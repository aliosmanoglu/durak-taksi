import { describe, expect, it } from 'vitest';
import { clockOffset, elapsedSince } from './clock';

const NOW = 1_800_000_000_000;

describe('sunucu saati farkı (E-6)', () => {
  it('sunucu − cihaz farkını verir; geçersiz/yok → null', () => {
    expect(clockOffset(new Date(NOW + 90_000).toISOString(), NOW)).toBe(90_000);
    expect(clockOffset(new Date(NOW - 5_000).toISOString(), NOW)).toBe(-5_000);
    expect(clockOffset('saçma', NOW)).toBeNull();
    expect(clockOffset(undefined, NOW)).toBeNull();
  });

  it('cihaz saati geride olsa da geçen süre sunucuya göre doğru çıkar', () => {
    // Çağrı sunucuda 30 sn önce oluştu; cihaz saati 10 dk geride.
    const createdAt = new Date(NOW + 10 * 60_000 - 30_000).toISOString();
    const offset = 10 * 60_000;
    expect(elapsedSince(createdAt, NOW, offset)).toBe(30_000);
    // Farksız hesap negatif çıkardı (ve 0'a sabitlenirdi).
    expect(elapsedSince(createdAt, NOW, 0)).toBe(0);
  });

  it('negatif süre 0, geçersiz tarih 0', () => {
    expect(elapsedSince(new Date(NOW + 5000).toISOString(), NOW, 0)).toBe(0);
    expect(elapsedSince('x', NOW, 0)).toBe(0);
  });
});
