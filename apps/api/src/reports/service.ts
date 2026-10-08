import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import {
  dailyReportSchema,
  MATCH_TARGET_SECONDS,
  REPORT_MAX_DAYS,
  REPORT_TIMEZONE,
  redisKeys,
  RIDE_HASH,
  type ConsistencyReport,
  type DailyReport,
} from '@duraknet/shared';
import type { Db } from '../db';
import { errors } from '../http/errors';

const DAY_MS = 86_400_000;
/** Yeni açılmış ride'ın Redis'e yansıması için tanınan süre (yarış yanlış alarmı vermesin). */
const MIRROR_GRACE_S = 5;

/** 'YYYY-MM-DD' gerçek bir takvim günü mü (2026-02-31 gibi değerleri reddeder)? */
function dayNumber(s: string): number | null {
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return Math.round(t / DAY_MS);
}

type RawRow = {
  date: string | null;
  total: number;
  matched: number;
  completed: number;
  cancelled: number;
  open: number;
  avg: number | null;
  median: number | null;
  p90: number | null;
  valid: number;
  within: number;
};

/**
 * Günlük rapor. Gün = `rides.created_at`'in REPORT_TIMEZONE günü. Tek sorgu: ROLLUP son satırda tüm aralığın
 * toplamını verir (süreler günlük ortalamaların ortalaması değil, ride bazında yeniden hesaplanır).
 * Süre = matched_at - searching_at (son aramadan); yalnızca matched_at dolu ve fark >= 0 olanlar.
 */
export async function dailyReport(
  db: Db,
  q: { from: string; to: string; standId?: string | undefined },
): Promise<DailyReport> {
  const a = dayNumber(q.from);
  const b = dayNumber(q.to);
  if (a === null || b === null) throw errors.validation('Geçersiz tarih');
  if (b - a + 1 > REPORT_MAX_DAYS) throw errors.validation(`Aralık en fazla ${REPORT_MAX_DAYS} gün olabilir`);

  const standId = q.standId ?? null;
  const { rows } = await sql<RawRow>`
    WITH days AS (
      SELECT d::date AS day FROM generate_series(${q.from}::date, ${q.to}::date, interval '1 day') d
    ), r AS (
      SELECT (created_at AT TIME ZONE ${REPORT_TIMEZONE}::text)::date AS day, status, matched_at,
             EXTRACT(EPOCH FROM (matched_at - searching_at))::float8 AS secs
        FROM rides
       WHERE created_at >= (${q.from}::date)::timestamp AT TIME ZONE ${REPORT_TIMEZONE}::text
         AND created_at <  ((${q.to}::date + 1))::timestamp AT TIME ZONE ${REPORT_TIMEZONE}::text
         AND (${standId}::uuid IS NULL OR stand_id = ${standId}::uuid)
    )
    SELECT days.day::text AS date,
           count(r.status)::int AS total,
           (count(*) FILTER (WHERE r.matched_at IS NOT NULL))::int AS matched,
           (count(*) FILTER (WHERE r.status = 'completed'))::int AS completed,
           (count(*) FILTER (WHERE r.status = 'cancelled'))::int AS cancelled,
           (count(*) FILTER (WHERE r.status IN ('created', 'searching', 'matched')))::int AS open,
           (avg(r.secs) FILTER (WHERE r.secs >= 0))::float8 AS avg,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY r.secs) FILTER (WHERE r.secs >= 0))::float8 AS median,
           (percentile_cont(0.9) WITHIN GROUP (ORDER BY r.secs) FILTER (WHERE r.secs >= 0))::float8 AS p90,
           (count(*) FILTER (WHERE r.secs >= 0))::int AS valid,
           (count(*) FILTER (WHERE r.secs >= 0 AND r.secs <= ${MATCH_TARGET_SECONDS}))::int AS within
      FROM days LEFT JOIN r ON r.day = days.day
     GROUP BY ROLLUP (days.day)
     ORDER BY days.day NULLS LAST`.execute(db);

  const shape = (x: RawRow) => ({
    total: x.total,
    matched: x.matched,
    completed: x.completed,
    cancelled: x.cancelled,
    open: x.open,
    matchRate: x.total > 0 ? x.matched / x.total : null,
    avgMatchSeconds: x.avg,
    medianMatchSeconds: x.median,
    p90MatchSeconds: x.p90,
    withinTargetRate: x.valid > 0 ? x.within / x.valid : null,
  });
  const totalsRow = rows.find((x) => x.date === null);
  const empty: RawRow = { date: null, total: 0, matched: 0, completed: 0, cancelled: 0, open: 0, avg: null, median: null, p90: null, valid: 0, within: 0 };
  return dailyReportSchema.parse({
    timezone: REPORT_TIMEZONE,
    targetSeconds: MATCH_TARGET_SECONDS,
    from: q.from,
    to: q.to,
    days: rows.filter((x) => x.date !== null).map((x) => ({ date: x.date, ...shape(x) })),
    totals: shape(totalsRow ?? empty),
  });
}

type PgRide = {
  id: string;
  short_code: string;
  status: string;
  driver_id: string | null;
  age_s: number;
};

const OPEN = ['created', 'searching', 'matched'];

/**
 * Tutarlılık raporu: PG'deki açık ride'ları (ve son 1 saatte kapananları) Redis `dn:ride:{id}` hash'iyle karşılaştırır.
 * SALT OKUNUR; onarım worker uzlaştırıcısındadır. Anlık geçişler (kabul/iptal sırasında) kısa süreli yanlış alarm
 * verebilir: sorun kalıcıysa (uzlaştırıcı 2 turda onarmadıysa) gerçektir.
 * `ageSeconds`: açık ride için oluşturulmadan, kapanmış için kapanıştan beri geçen süre.
 */
export async function consistencyReport(db: Db, redis: Redis, staleCreatedAgeS: number): Promise<ConsistencyReport> {
  const { rows } = await sql<PgRide>`
    SELECT id, short_code, status::text AS status, driver_id,
           EXTRACT(EPOCH FROM (now() - COALESCE(completed_at, cancelled_at, created_at)))::int AS age_s
      FROM rides
     WHERE status IN ('created', 'searching', 'matched')
        OR (status IN ('completed', 'cancelled')
            AND COALESCE(completed_at, cancelled_at) >= now() - interval '1 hour')
     ORDER BY created_at`.execute(db);

  const p = redis.pipeline();
  for (const r of rows) p.hmget(redisKeys.ride(r.id), RIDE_HASH.status, RIDE_HASH.driverId);
  const res = (await p.exec()) ?? [];

  const issues: ConsistencyReport['issues'] = [];
  let openRides = 0;
  rows.forEach((r, i) => {
    const [err, v] = res[i] ?? [null, null];
    if (err) throw err;
    const [rStatus, rDriver] = (v as [string | null, string | null]) ?? [null, null];
    const redisStatus = rStatus ?? null;
    const age = Math.max(0, r.age_s);
    const push = (kind: ConsistencyReport['issues'][number]['kind']) =>
      void issues.push({ rideId: r.id, shortCode: r.short_code, kind, pgStatus: r.status, redisStatus, ageSeconds: age });

    if (OPEN.includes(r.status)) {
      openRides++;
      if (r.status === 'created' && age > staleCreatedAgeS) return push('stale_created');
      if (age <= MIRROR_GRACE_S) return;
      if (redisStatus === null) return push('pg_open_redis_missing');
      if (redisStatus !== r.status) return push('status_mismatch');
      if (r.status === 'matched' && (rDriver ?? '') !== (r.driver_id ?? '')) return push('driver_mismatch');
      return;
    }
    // PG terminal: Redis hâlâ açık görünüyorsa tutarsızdır (hash yok/terminal ise sorun yok).
    if (redisStatus !== null && OPEN.includes(redisStatus) && age > MIRROR_GRACE_S) push('redis_open_pg_closed');
  });

  return { checkedAt: new Date().toISOString(), openRides, issues };
}
