import { z } from 'zod';

/** Rapor günleri bu saat diliminde kesilir (pilot: Türkiye). */
export const REPORT_TIMEZONE = 'Europe/Istanbul';
/** Pilot hedefi: ortalama eşleşme süresi (sn). */
export const MATCH_TARGET_SECONDS = 60;
/** Tek istekte en çok kaç gün. */
export const REPORT_MAX_DAYS = 92;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** GET /admin/reports/daily?from=YYYY-MM-DD&to=YYYY-MM-DD&standId=uuid (to dahil, REPORT_TIMEZONE günleri). */
export const reportQuerySchema = z
  .object({ from: dateOnly, to: dateOnly, standId: z.uuid().optional() })
  .refine((q) => q.from <= q.to, { message: 'from, to değerinden büyük olamaz' });

/**
 * Bir günün özeti (gün = `rides.created_at`'in REPORT_TIMEZONE günü).
 * - `matched`: matched_at dolu ride sayısı (sonradan şoför iptaliyle yeniden aramaya düşse de son eşleşme sayılır).
 * - `matchRate`: matched / total (total=0 ise null).
 * - Süreler `matched_at - searching_at` (sn); yalnızca matched_at dolu ve farkı >= 0 olanlar. Şoför iptali sonrası
 *   `searching_at` yeniden başladığı için bu "son aramadan eşleşmeye" süredir.
 */
export const dailyReportRowSchema = z.object({
  date: dateOnly,
  total: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  matchRate: z.number().min(0).max(1).nullable(),
  avgMatchSeconds: z.number().nonnegative().nullable(),
  medianMatchSeconds: z.number().nonnegative().nullable(),
  p90MatchSeconds: z.number().nonnegative().nullable(),
  withinTargetRate: z.number().min(0).max(1).nullable(),
});
export type DailyReportRow = z.infer<typeof dailyReportRowSchema>;

export const dailyReportSchema = z.object({
  timezone: z.literal(REPORT_TIMEZONE),
  targetSeconds: z.literal(MATCH_TARGET_SECONDS),
  from: dateOnly,
  to: dateOnly,
  days: z.array(dailyReportRowSchema),
  /** Tüm aralık için (günlerin toplamı; süreler ride bazında yeniden hesaplanır). */
  totals: dailyReportRowSchema.omit({ date: true }),
});
export type DailyReport = z.infer<typeof dailyReportSchema>;

/**
 * GET /admin/reports/consistency — "kayıp çağrı sıfır" kanıtı. Salt okunur; onarım uzlaştırıcıdadır.
 * `kind`: pg_open_redis_missing (PG açık, Redis hash yok), status_mismatch, driver_mismatch,
 * stale_created (created ve eski), redis_open_pg_closed (Redis açık, PG terminal).
 */
export const CONSISTENCY_KINDS = [
  'pg_open_redis_missing', 'status_mismatch', 'driver_mismatch', 'stale_created', 'redis_open_pg_closed',
] as const;
export const consistencyReportSchema = z.object({
  checkedAt: z.string(),
  openRides: z.number().int().nonnegative(),
  issues: z.array(
    z.object({
      rideId: z.uuid(),
      shortCode: z.string(),
      kind: z.enum(CONSISTENCY_KINDS),
      pgStatus: z.string(),
      redisStatus: z.string().nullable(),
      ageSeconds: z.number().int().nonnegative(),
    }),
  ),
});
export type ConsistencyReport = z.infer<typeof consistencyReportSchema>;

/** Şoför kaydındaki KVKK aydınlatma onayı (kayıt gövdesine `kvkkAccepted: true` eklenir). */
export const KVKK_NOTICE_VERSION = '2026-10-taslak-1';
