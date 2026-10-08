import { describe, expect, it } from 'vitest';
import { formatDistance, formatElapsed, formatElapsedA11y, formatPhone, formatRadiusKm, telHref } from './format';
import { computeClockOffset, elapsedSince } from './clock';
import { composeNote, noteForRequest, NOTE_MAX } from './notes';
import { parseRecent, pushRecent } from './recent-addresses';
import { backoffMs, refreshDelayMs } from './session-policy';
import { toApiResult } from './api-result';
import { errorText } from './texts';

describe('formatElapsed', () => {
  it('biçimler', () => {
    expect(formatElapsed(42_000)).toBe('42 sn');
    expect(formatElapsed(59_999)).toBe('59 sn');
    expect(formatElapsed(185_000)).toBe('3 dk 05 sn');
    expect(formatElapsed(60 * 60_000)).toBe('1 sa 00 dk');
    expect(formatElapsed(72 * 60_000 + 30_000)).toBe('1 sa 12 dk');
  });
  it('negatif ve geçersiz 0\'a sabitlenir', () => {
    expect(formatElapsed(-5000)).toBe('0 sn');
    expect(formatElapsed(NaN)).toBe('0 sn');
  });
  it('a11y yalnızca dakika', () => {
    expect(formatElapsedA11y(30_000)).toBe('1 dakikadan az');
    expect(formatElapsedA11y(185_000)).toBe('3 dakika');
  });
});

describe('mesafe, yarıçap, telefon', () => {
  it('mesafe', () => {
    expect(formatDistance(850.4)).toBe('850 m');
    expect(formatDistance(1200)).toBe('1,2 km');
    expect(formatDistance(2000)).toBe('2 km');
    expect(formatDistance(-3)).toBe('0 m');
  });
  it('yarıçap', () => {
    expect(formatRadiusKm(4000)).toBe('4 km');
    expect(formatRadiusKm(2500)).toBe('2,5 km');
    expect(formatRadiusKm(500)).toBe('0,5 km');
  });
  it('telefon', () => {
    expect(formatPhone('+905321234567')).toBe('0532 123 45 67');
    expect(formatPhone('bilinmeyen')).toBe('bilinmeyen');
    expect(telHref('+90 532 123 45 67')).toBe('tel:+905321234567');
  });
});

describe('saat farkı', () => {
  it('sunucu ileride ise geçen süre sunucuya göre hesaplanır', () => {
    const device = 1_000_000;
    const offset = computeClockOffset(new Date(device + 120_000).toISOString(), device); // sunucu 2 dk ileri
    expect(offset).toBe(120_000);
    // Sunucu saatiyle 10 sn önce başlamış arama.
    const since = new Date(device + 120_000 - 10_000).toISOString();
    expect(elapsedSince(since, device, offset)).toBe(10_000);
    // Düzeltme olmasaydı negatif çıkacaktı.
    expect(elapsedSince(since, device, 0)).toBe(0);
  });
  it('geçersiz tarih güvenli', () => {
    expect(computeClockOffset('bozuk', 5)).toBe(0);
    expect(elapsedSince(undefined, 5, 0)).toBe(0);
    expect(elapsedSince('bozuk', 5, 0)).toBe(0);
  });
});

describe('not', () => {
  it('etiketler ve serbest metin birleşir; boşsa undefined', () => {
    expect(composeNote(['Bagaj var', 'Engelli yolcu'], '  3. kat ')).toBe('Bagaj var, Engelli yolcu, 3. kat');
    expect(noteForRequest([], '   ')).toBeUndefined();
    expect(noteForRequest([], 'x'.repeat(400))).toHaveLength(NOTE_MAX);
  });
});

describe('son adresler', () => {
  const a = (address: string) => ({ address, location: { lat: 1, lng: 2 } });
  it('başa ekler, tekrarı birleştirir, 5 ile sınırlar', () => {
    let l = [a('A')];
    l = pushRecent(l, a('B'));
    l = pushRecent(l, a('a '));
    expect(l.map((x) => x.address)).toEqual(['a', 'B']);
    for (const c of ['C', 'D', 'E', 'F', 'G']) l = pushRecent(l, a(c));
    expect(l).toHaveLength(5);
    expect(l[0]?.address).toBe('G');
    expect(pushRecent(l, a('  '))).toEqual(l);
  });
  it('bozuk veriyi eler', () => {
    expect(parseRecent('x')).toEqual([]);
    expect(parseRecent([{ address: 'ok', location: { lat: 1, lng: 2 } }, { address: '', location: { lat: 1, lng: 2 } }, { nope: 1 }, null]))
      .toEqual([{ address: 'ok', location: { lat: 1, lng: 2 } }]);
  });
});

describe('oturum zamanlaması', () => {
  it('access süresinin %80\'inde yenilenir', () => {
    expect(refreshDelayMs(900)).toBe(720_000);
    expect(refreshDelayMs(0)).toBe(1000);
  });
  it('geri çekilme 1..5 sn', () => {
    expect([0, 1, 2, 5, 9].map(backoffMs)).toEqual([1000, 1000, 2000, 5000, 5000]);
  });
});

describe('api sonucu ve hata metni', () => {
  const h = (m: Record<string, string>) => ({ get: (k: string) => m[k.toLowerCase()] ?? null });
  it('başarı / hata kodu / 429', () => {
    expect(toApiResult(200, { ok: true, data: 1 }, h({}), 0)).toEqual({ ok: true, data: 1 });
    expect(toApiResult(401, { ok: false, error: { code: 'INVALID_CREDENTIALS' } }, h({}), 0))
      .toMatchObject({ ok: false, code: 'INVALID_CREDENTIALS' });
    expect(toApiResult(429, {}, h({ 'retry-after': '12' }), 0)).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 12_000 });
    expect(toApiResult(502, 'html', h({}), 0)).toMatchObject({ code: 'INTERNAL' });
  });
  it('ride kodları anlaşılır Türkçe', () => {
    expect(errorText('VERSION_CONFLICT')).toBe('Çağrı durumu değişti.');
    expect(errorText('TIMEOUT')).toContain('Yanıt gelmedi');
  });
});
