// Yönetici: Raporlar (günlük özet + tutarlılık denetimi + CSV). Admin oturumunda çağrı soketi açılmaz.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MATCH_TARGET_SECONDS, REPORT_MAX_DAYS, type ConsistencyReport, type DailyReport } from '@duraknet/shared';
import type { ApiResult } from '../lib/api-result';
import { formatElapsed } from '../lib/format';
import {
  csvFilename, dailyReportToCsv, defaultRange, formatRate, formatSeconds, meetsTarget, reportPath, validateRange,
} from '../lib/reports';
import {
  approvePath, formatCreatedAt, pendingListPath, removeById, vehicleLabel,
  type PendingDriver, type PendingKind, type PendingStand,
} from '../lib/pending';
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

function pendingFailText(r: Extract<ApiResult<unknown>, { ok: false }>, fallback: string): string {
  if (r.kind === 'network') return TA.pending.errNetwork;
  if (r.code === 'FORBIDDEN') return TA.pending.errForbidden;
  if (r.code === 'RATE_LIMITED') return T.form.err.rateLimited;
  return fallback;
}

function PendingAccounts() {
  const [drivers, setDrivers] = useState<PendingDriver[]>([]);
  const [stands, setStands] = useState<PendingStand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const fetchLists = useCallback(
    () => Promise.all([
      apiAuthed<PendingDriver[]>('GET', pendingListPath('drivers')),
      apiAuthed<PendingStand[]>('GET', pendingListPath('stands')),
    ]),
    [],
  );

  function apply([d, s]: Awaited<ReturnType<typeof fetchLists>>) {
    setLoading(false);
    if (d.ok) setDrivers(d.data);
    if (s.ok) setStands(s.data);
    if (d.ok && s.ok) setLoaded(true);
    const bad = !d.ok ? d : !s.ok ? s : null;
    setError(bad ? pendingFailText(bad, TA.pending.errList) : null);
  }

  async function load() {
    setLoading(true);
    setError(null);
    apply(await fetchLists());
  }

  useEffect(() => {
    let alive = true;
    void fetchLists().then((res) => {
      if (alive) apply(res);
    });
    return () => {
      alive = false;
    };
    // apply yalnızca state setter'lar kullanır
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchLists]);

  async function approve(kind: PendingKind, id: string) {
    if (approvingId) return;
    setApprovingId(id);
    setError(null);
    const r = await apiAuthed<{ id: string }>('POST', approvePath(kind, id));
    setApprovingId(null);
    if (r.ok) {
      if (kind === 'drivers') setDrivers((l) => removeById(l, id));
      else setStands((l) => removeById(l, id));
      return;
    }
    if (r.kind === 'http' && r.code === 'NOT_FOUND') {
      setError(TA.pending.errNotFound);
      void load();
      return;
    }
    setError(pendingFailText(r, TA.pending.errApprove));
  }

  const P = TA.pending;
  const approveBtn = (kind: PendingKind, id: string) => (
    <Button variant="primary" disabled={approvingId !== null} onClick={() => void approve(kind, id)}>
      {approvingId === id ? P.approving : P.approve}
    </Button>
  );
  const th = 'p-2';
  const empty = loaded && drivers.length === 0 && stands.length === 0;

  return (
    <section aria-labelledby="pending-h" className="space-y-3 rounded-2xl bg-white p-4 shadow dark:bg-slate-800">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="pending-h" className="text-xl font-bold">{P.title}</h2>
        <Button onClick={() => void load()} disabled={loading} className="ml-auto">
          {loading ? P.loading : P.refresh}
        </Button>
      </div>
      {error && <Banner tone="error" role="alert">{error}</Banner>}
      {empty && !loading && <p className="text-lg">{P.empty}</p>}

      {drivers.length > 0 && (
        <div className="overflow-x-auto">
          <h3 className="mb-1 text-lg font-bold">{P.drivers}</h3>
          <table className="w-full text-left text-base">
            <thead>
              <tr className="border-b-2 border-slate-300">
                {[P.name, P.phone, P.plate, P.license, P.vehicle, P.createdAt].map((h) => <th key={h} className={th}>{h}</th>)}
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.id} className="border-b border-slate-200">
                  <td className="p-2 font-semibold">{d.fullName}</td>
                  <td className="p-2">{d.phone}</td>
                  <td className="p-2 font-mono">{d.plate}</td>
                  <td className="p-2">{d.licenseNo}</td>
                  <td className="p-2">{vehicleLabel(d.vehicleModel, d.vehicleColor)}</td>
                  <td className="p-2">{formatCreatedAt(d.createdAt)}</td>
                  <td className="p-2">{approveBtn('drivers', d.id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stands.length > 0 && (
        <div className="overflow-x-auto">
          <h3 className="mb-1 text-lg font-bold">{P.stands}</h3>
          <table className="w-full text-left text-base">
            <thead>
              <tr className="border-b-2 border-slate-300">
                {[P.name, P.phone, P.address, P.username, P.createdAt].map((h) => <th key={h} className={th}>{h}</th>)}
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {stands.map((s) => (
                <tr key={s.id} className="border-b border-slate-200">
                  <td className="p-2 font-semibold">{s.name}</td>
                  <td className="p-2">{s.phone}</td>
                  <td className="p-2">{s.address || '—'}</td>
                  <td className="p-2 font-mono">{s.username}</td>
                  <td className="p-2">{formatCreatedAt(s.createdAt)}</td>
                  <td className="p-2">{approveBtn('stands', s.id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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

      <PendingAccounts />

      <section aria-labelledby="reports-h"className="space-y-3 rounded-2xl bg-white p-4 shadow dark:bg-slate-800">
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
