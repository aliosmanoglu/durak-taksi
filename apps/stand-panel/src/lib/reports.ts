// Rapor ekranının saf mantığı: tarih aralığı, sorgu yolu, süre/oran biçimleme, CSV (Faz 6, tasarım Bölüm 4).
import { MATCH_TARGET_SECONDS, REPORT_MAX_DAYS, REPORT_TIMEZONE, type DailyReport, type DailyReportRow } from '@duraknet/shared';
import { formatElapsed } from './format';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` geçerli bir takvim günü mü? */
export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Verilen anın rapor saat dilimindeki (Europe/Istanbul) takvim günü. */
export function todayInReportTz(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** from ve to dahil gün sayısı. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Varsayılan aralık: bugün dahil son 7 gün. */
export function defaultRange(now: Date): { from: string; to: string } {
  const to = todayInReportTz(now);
  return { from: addDays(to, -6), to };
}

export type RangeError = 'invalid' | 'order' | 'tooLong';

export function validateRange(from: string, to: string): RangeError | null {
  if (!isValidDate(from) || !isValidDate(to)) return 'invalid';
  if (from > to) return 'order';
  if (daysInclusive(from, to) > REPORT_MAX_DAYS) return 'tooLong';
  return null;
}

export function reportPath(from: string, to: string, standId?: string): string {
  const q = new URLSearchParams({ from, to });
  if (standId) q.set('standId', standId);
  return `/admin/reports/daily?${q.toString()}`;
}

/** Saniye -> "42 sn" / "3 dk 05 sn"; veri yoksa "—". */
export function formatSeconds(sec: number | null): string {
  return sec === null ? '—' : formatElapsed(Math.round(sec) * 1000);
}

/** 0..1 -> "%87,5" (Türkçe ondalık); veri yoksa "—". */
export function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  const v = Math.round(rate * 1000) / 10;
  return `%${String(v).replace('.', ',')}`;
}

/** Ortalama eşleşme süresi hedefin içinde mi? (veri yoksa null) */
export function meetsTarget(avgSeconds: number | null): boolean | null {
  return avgSeconds === null ? null : avgSeconds <= MATCH_TARGET_SECONDS;
}

// ---- CSV ----
const CSV_SEP = ';'; // Türkçe Excel yerel ayarı ';' bekler
const BOM = String.fromCharCode(0xfeff);

/** Tek hücre: ayraç/tırnak/satır sonu varsa tırnaklanır; formül enjeksiyonuna karşı = + - @ ile başlayan metne ' eklenir. */
export function csvCell(v: string | number | null): string {
  if (v === null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const round = (v: number | null, f: number): string | null => (v === null ? null : String(Math.round(v * f) / f).replace('.', ','));

export const CSV_HEADERS = [
  'Tarih', 'Çağrı', 'Eşleşen', 'Tamamlanan', 'İptal', 'Açık', 'Eşleşme oranı',
  'Ort. süre (sn)', 'Medyan süre (sn)', 'p90 süre (sn)', 'Hedef içi oran',
] as const;

function csvRow(label: string, r: Omit<DailyReportRow, 'date'>): string {
  return [
    label, r.total, r.matched, r.completed, r.cancelled, r.open,
    round(r.matchRate, 1000), round(r.avgMatchSeconds, 10), round(r.medianMatchSeconds, 10),
    round(r.p90MatchSeconds, 10), round(r.withinTargetRate, 1000),
  ].map(csvCell).join(CSV_SEP);
}

/** UTF-8 BOM'lu CSV (Excel Türkçe karakterleri doğru açsın); son satır toplamlar. */
export function dailyReportToCsv(report: DailyReport): string {
  const lines = [
    CSV_HEADERS.map(csvCell).join(CSV_SEP),
    ...report.days.map((d) => csvRow(d.date, d)),
    csvRow('Toplam', report.totals),
  ];
  return BOM + lines.join('\r\n') + '\r\n';
}

export function csvFilename(from: string, to: string, standName?: string): string {
  const slug = standName?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `duraknet-rapor-${from}_${to}${slug ? `-${slug}` : ''}.csv`;
}
