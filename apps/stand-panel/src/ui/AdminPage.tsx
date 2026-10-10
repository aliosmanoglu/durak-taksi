// Yönetici: Raporlar (günlük özet + tutarlılık denetimi + CSV). Admin oturumunda çağrı soketi açılmaz.
import { useEffect, useMemo, useState } from 'react';
import { MATCH_TARGET_SECONDS, REPORT_MAX_DAYS, type ConsistencyReport, type DailyReport } from '@duraknet/shared';
import type { ApiResult } from '../lib/api-result';
import { formatElapsed } from '../lib/format';
import {
  csvFilename, dailyReportToCsv, defaultRange, formatRate, formatSeconds, meetsTarget, reportPath, validateRange,
} from '../lib/reports';
import { T } from '../lib/texts';
import { TA } from '../lib/texts-admin';
import { downloadText } from '../services/download';
import { apiAuthed, logout } from '../services/session';
import { Banner, Button } from './kit';

type StandOption = { id: string; name: string };

const INPUT = 'min-h-[56px] rounded-xl border-2 border-slate-400 bg-white px-4 text-xl text-slate-900';

function failText(r: Extract<ApiResult<unknown>, { ok: false }>): string {
  if (r.kind === 'network') return TA.reports.errNetwork;
  if (r.code === 'FORBIDDEN') return TA.reports.errForbidden;
  if (r.code === 'RATE_LIMITED') return T.form.err.rateLimited;
  return TA.reports.errServer;
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow dark:bg-slate-800">
      <div className="text-base font-semibold text-slate-600 dark:text-slate-300">{label}</div>
      <div className="text-3xl font-extrabold">{value}</div>
      {hint && <div className="text-sm text-slate-600 dark:text-slate-300">{hint}</div>}
    </div>
  );
}

function ConsistencyBox() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ConsistencyReport | null>(null);

  async function check() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await apiAuthed<ConsistencyReport>('GET', '/admin/reports/consistency');
    setBusy(false);
    if (r.ok) setData(r.data);
    else setError(failText(r));
  }

  return (
    <section aria-labelledby="consistency-h" className="space-y-3 rounded-2xl bg-white p-4 shadow dark:bg-slate-800">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="consistency-h" className="text-xl font-bold">{TA.consistency.title}</h2>
        <Button onClick={() => void check()} disabled={busy} className="ml-auto">
          {busy ? TA.consistency.checking : TA.consistency.check}
        </Button>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300">{TA.consistency.note}</p>
      {error && <Banner tone="error" role="alert">{error}</Banner>}
      {data && (
        <div className="space-y-2">
          <Banner tone={data.issues.length === 0 ? 'info' : 'alert'} role="status">
            {data.issues.length === 0 ? TA.consistency.ok : TA.consistency.found(data.issues.length)}
            {' '}
            {TA.consistency.open(data.openRides)}
            {' · '}
            {TA.consistency.checkedAt}: {new Date(data.checkedAt).toLocaleString('tr-TR')}
          </Banner>
          {data.issues.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-base">
                <thead>
                  <tr className="border-b-2 border-slate-300">
                    <th className="p-2">{TA.consistency.ride}</th>
                    <th className="p-2">{TA.consistency.kind}</th>
                    <th className="p-2">{TA.consistency.pg}</th>
                    <th className="p-2">{TA.consistency.redis}</th>
                    <th className="p-2">{TA.consistency.age}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.issues.map((i) => (
                    <tr key={`${i.rideId}-${i.kind}`} className="border-b border-slate-200">
                      <td className="p-2 font-mono font-bold">{i.shortCode}</td>
                      <td className="p-2">{TA.consistency.kinds[i.kind] ?? i.kind}</td>
                      <td className="p-2">{i.pgStatus}</td>
                      <td className="p-2">{i.redisStatus ?? '—'}</td>
                      <td className="p-2">{formatElapsed(i.ageSeconds * 1000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function AdminPage() {
  const initial = useMemo(() => defaultRange(new Date()), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [standId, setStandId] = useState('');
  const [stands, setStands] = useState<StandOption[]>([]);
  const [standsFailed, setStandsFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ data: DailyReport; standName?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void apiAuthed<StandOption[]>('GET', '/admin/stands').then((r) => {
      if (!alive) return;
      if (r.ok) setStands(r.data.map((s) => ({ id: s.id, name: s.name })));
      else setStandsFailed(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const rangeErr = validateRange(from, to);
  const rangeText = rangeErr === 'invalid' ? TA.reports.rangeInvalid : rangeErr === 'order' ? TA.reports.rangeOrder : rangeErr === 'tooLong' ? TA.reports.rangeTooLong(REPORT_MAX_DAYS) : null;

  async function load() {
    if (busy || rangeErr) return;
    setBusy(true);
    setError(null);
    const r = await apiAuthed<DailyReport>('GET', reportPath(from, to, standId || undefined));
    setBusy(false);
    if (r.ok) setReport({ data: r.data, standName: stands.find((s) => s.id === standId)?.name });
    else setError(failText(r));
  }

  const t = report?.data.totals;
  const c = TA.reports.cards;
  const ok = t ? meetsTarget(t.avgMatchSeconds) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-extrabold">{T.appName} · {TA.admin.title}</h1>
        <Button className="ml-auto" onClick={() => void logout()}>{TA.admin.logout}</Button>
      </header>

      <section aria-labelledby="reports-h" className="space-y-3 rounded-2xl bg-white p-4 shadow dark:bg-slate-800">
        <h2 id="reports-h" className="text-xl font-bold">{TA.reports.title}</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <label className="block">
            <span className="mb-1 block font-semibold">{TA.reports.from}</span>
            <input type="date" className={INPUT} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block font-semibold">{TA.reports.to}</span>
            <input type="date" className={INPUT} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block font-semibold">{TA.reports.stand}</span>
            <select className={INPUT} value={standId} onChange={(e) => setStandId(e.target.value)}>
              <option value="">{TA.reports.allStands}</option>
              {stands.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="primary" disabled={busy || rangeErr !== null}>
            {busy ? TA.reports.loading : TA.reports.run}
          </Button>
          <Button
            disabled={!report}
            onClick={() => report && downloadText(csvFilename(report.data.from, report.data.to, report.standName), dailyReportToCsv(report.data))}
          >
            {TA.reports.csv}
          </Button>
        </form>
        {rangeText && <p className="font-semibold text-red-800 dark:text-red-300" role="alert">{rangeText}</p>}
        {standsFailed && <Banner tone="warn">{TA.reports.errStands}</Banner>}
        {error && <Banner tone="error" role="alert">{error}</Banner>}
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {TA.reports.tz(report?.data.timezone ?? 'Europe/Istanbul')} {TA.reports.note}
        </p>

        {report && t && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              <Card label={c.total} value={String(t.total)} />
              <Card label={c.matchRate} value={formatRate(t.matchRate)} hint={`${t.matched} / ${t.total}`} />
              <Card label={c.avg} value={formatSeconds(t.avgMatchSeconds)} hint={ok === null ? undefined : ok ? c.targetOk : c.targetMiss} />
              <Card label={c.median} value={formatSeconds(t.medianMatchSeconds)} />
              <Card label={c.p90} value={formatSeconds(t.p90MatchSeconds)} />
              <Card label={c.within(MATCH_TARGET_SECONDS)} value={formatRate(t.withinTargetRate)} />
            </div>
            {t.total === 0 && <p className="text-lg">{TA.reports.empty}</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-base">
                <thead>
                  <tr className="border-b-2 border-slate-300">
                    {[TA.reports.table.date, TA.reports.table.total, TA.reports.table.matched, TA.reports.table.completed, TA.reports.table.cancelled,
                      TA.reports.table.open, TA.reports.table.matchRate, TA.reports.table.avg, TA.reports.table.median, TA.reports.table.p90, TA.reports.table.within].map((h) => (
                      <th key={h} className="p-2">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.data.days.map((d) => (
                    <tr key={d.date} className="border-b border-slate-200">
                      <td className="p-2 font-mono">{d.date}</td>
                      <td className="p-2">{d.total}</td>
                      <td className="p-2">{d.matched}</td>
                      <td className="p-2">{d.completed}</td>
                      <td className="p-2">{d.cancelled}</td>
                      <td className="p-2">{d.open}</td>
                      <td className="p-2">{formatRate(d.matchRate)}</td>
                      <td className="p-2">{formatSeconds(d.avgMatchSeconds)}</td>
                      <td className="p-2">{formatSeconds(d.medianMatchSeconds)}</td>
                      <td className="p-2">{formatSeconds(d.p90MatchSeconds)}</td>
                      <td className="p-2">{formatRate(d.withinTargetRate)}</td>
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="p-2">{TA.reports.table.totals}</td>
                    <td className="p-2">{t.total}</td>
                    <td className="p-2">{t.matched}</td>
                    <td className="p-2">{t.completed}</td>
                    <td className="p-2">{t.cancelled}</td>
                    <td className="p-2">{t.open}</td>
                    <td className="p-2">{formatRate(t.matchRate)}</td>
                    <td className="p-2">{formatSeconds(t.avgMatchSeconds)}</td>
                    <td className="p-2">{formatSeconds(t.medianMatchSeconds)}</td>
                    <td className="p-2">{formatSeconds(t.p90MatchSeconds)}</td>
                    <td className="p-2">{formatRate(t.withinTargetRate)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <ConsistencyBox />
    </div>
  );
}
