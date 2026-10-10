import { describe, expect, it } from 'vitest';
import type { DailyReport } from '@duraknet/shared';
import {
  addDays, csvCell, csvFilename, dailyReportToCsv, daysInclusive, defaultRange, formatRate, formatSeconds,
  meetsTarget, reportPath, todayInReportTz, validateRange,
} from './reports';
import { validateStandRegister, parseCoord } from './stand-register';

describe('tarih aralığı', () => {
  it('İstanbul gününü kullanır (UTC 21:30 -> ertesi gün)', () => {
    expect(todayInReportTz(new Date('2026-10-07T21:30:00Z'))).toBe('2026-10-08');
    expect(todayInReportTz(new Date('2026-10-07T20:30:00Z'))).toBe('2026-10-07');
  });
  it('addDays ay/yıl sınırını geçer', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('varsayılan aralık 7 gündür', () => {
    const r = defaultRange(new Date('2026-10-08T10:00:00Z'));
    expect(r).toEqual({ from: '2026-10-02', to: '2026-10-08' });
    expect(daysInclusive(r.from, r.to)).toBe(7);
  });
  it('doğrular', () => {
    expect(validateRange('2026-10-01', '2026-10-01')).toBeNull();
    expect(validateRange('2026-10-02', '2026-10-01')).toBe('order');
    expect(validateRange('2026-13-01', '2026-10-01')).toBe('invalid');
    expect(validateRange('', '2026-10-01')).toBe('invalid');
    expect(validateRange('2026-01-01', '2026-04-03')).toBe('tooLong'); // 93 gün
    expect(validateRange('2026-01-01', '2026-04-02')).toBeNull(); // 92 gün
  });
  it('sorgu yolu', () => {
    expect(reportPath('2026-10-01', '2026-10-07')).toBe('/admin/reports/daily?from=2026-10-01&to=2026-10-07');
    expect(reportPath('2026-10-01', '2026-10-07', 'abc')).toContain('&standId=abc');
  });
});

describe('biçimleme', () => {
  it('süre ve oran', () => {
    expect(formatSeconds(null)).toBe('—');
    expect(formatSeconds(42.4)).toBe('42 sn');
    expect(formatSeconds(185)).toBe('3 dk 05 sn');
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0.875)).toBe('%87,5');
    expect(formatRate(1)).toBe('%100');
    expect(formatRate(0)).toBe('%0');
  });
  it('hedef', () => {
    expect(meetsTarget(null)).toBeNull();
    expect(meetsTarget(60)).toBe(true);
    expect(meetsTarget(61)).toBe(false);
  });
});

const row = { total: 4, matched: 3, completed: 2, cancelled: 1, open: 1, matchRate: 0.75, avgMatchSeconds: 41.25, medianMatchSeconds: 40, p90MatchSeconds: 70, withinTargetRate: 0.667 };

describe('CSV', () => {
  it('hücre kaçışı', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(5)).toBe('5');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('x\ny')).toBe('"x\ny"');
  });
  it('rapor: BOM, başlık, günler, toplam, ondalık virgül, boş = boş hücre', () => {
    const report: DailyReport = {
      timezone: 'Europe/Istanbul', targetSeconds: 60, from: '2026-10-01', to: '2026-10-02',
      days: [
        { date: '2026-10-01', ...row },
        { date: '2026-10-02', total: 0, matched: 0, completed: 0, cancelled: 0, open: 0, matchRate: null, avgMatchSeconds: null, medianMatchSeconds: null, p90MatchSeconds: null, withinTargetRate: null },
      ],
      totals: row,
    };
    const csv = dailyReportToCsv(report);
    expect(csv.startsWith('﻿Tarih;Çağrı;')).toBe(true);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('2026-10-01;4;3;2;1;1;0,75;41,3;40;70;0,667');
    expect(lines[2]).toBe('2026-10-02;0;0;0;0;0;;;;;');
    expect(lines[3]?.startsWith('Toplam;4;')).toBe(true);
  });
  it('dosya adı', () => {
    expect(csvFilename('2026-10-01', '2026-10-07')).toBe('duraknet-rapor-2026-10-01_2026-10-07.csv');
    expect(csvFilename('2026-10-01', '2026-10-07', 'Çarşı Durağı')).toBe('duraknet-rapor-2026-10-01_2026-10-07-ar-dura.csv');
  });
});

describe('durak kaydı doğrulaması', () => {
  const ok = { name: 'Merkez Durak', phone: '0532 123 45 67', address: '', username: 'Merkez', password: 'sifre1234', lat: '41,0082', lng: '28.9784', kvkk: true };
  it('geçerli form kvkkAccepted: true ile gider', () => {
    const r = validateStandRegister(ok);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.kvkkAccepted).toBe(true);
      expect(r.input.phone).toBe('+905321234567');
      expect(r.input.username).toBe('merkez');
      expect(r.input.location).toEqual({ lat: 41.0082, lng: 28.9784 });
      expect(r.input.address).toBeUndefined();
    }
  });
  it('onay kutusu işaretsiz reddedilir', () => {
    const r = validateStandRegister({ ...ok, kvkk: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.kvkk).toBeDefined();
  });
  it('alan hataları', () => {
    const r = validateStandRegister({ ...ok, name: '', phone: '1', username: '!', password: 'x', lat: '', lng: '999' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['location', 'name', 'password', 'phone', 'username']);
  });
  it('koordinat ayrıştırma', () => {
    expect(parseCoord(' 41,5 ')).toBe(41.5);
    expect(parseCoord('')).toBeNaN();
    expect(parseCoord('abc')).toBeNaN();
  });
});
