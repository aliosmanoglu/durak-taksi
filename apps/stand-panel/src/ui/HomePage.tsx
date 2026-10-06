import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { orderedRides } from '../lib/rides';
import { T } from '../lib/texts';
import { useStore } from '../store';
import { useNow } from './hooks';
import { Banner } from './kit';
import { NewRideForm } from './NewRideForm';
import { CancelDialog, CompleteDialog, type DialogState } from './RideDialogs';
import { RideCard } from './RideCard';
import { SettingsDrawer } from './SettingsDrawer';
import { TopBar } from './TopBar';

function Skeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      <p className="text-lg font-semibold">{T.list.loading}</p>
      {[0, 1].map((i) => (
        <div key={i} className="h-32 animate-pulse rounded-2xl bg-slate-200 motion-reduce:animate-none dark:bg-slate-700" />
      ))}
    </div>
  );
}

function RecentStrip() {
  const archive = useStore((s) => s.ridesState.archive);
  return (
    <section aria-label={T.list.recent} className="mt-4">
      <h3 className="mb-1 text-lg font-bold">{T.list.recent}</h3>
      {archive.length === 0 ? (
        <p className="text-base text-slate-600 dark:text-slate-300">{T.list.recentNone}</p>
      ) : (
        <ul className="space-y-1 text-base">
          {archive.map((a) => (
            <li key={a.rideId} className="flex gap-3">
              <span className="font-mono font-bold">{a.shortCode}</span>
              <span className="min-w-0 flex-1 truncate">{a.pickupAddress}</span>
              <span>{a.result === 'completed' ? T.list.recentCompleted : T.list.recentCancelled}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HomePage() {
  const { pathname } = useLocation();
  const settingsOpen = pathname === '/settings';
  const me = useStore((s) => s.me);
  const conn = useStore((s) => s.conn);
  const ridesState = useStore((s) => s.ridesState);
  const clockOffset = useStore((s) => s.clockOffset);
  const shiftLocked = useStore((s) => s.shiftLocked);
  const formNonce = useStore((s) => s.formNonce);
  const now = useNow();
  const [dialog, setDialog] = useState<DialogState>(null);

  // Kiosk: geri tuşu '/' ekranından uygulamadan çıkarmaz (geçmiş girdisi geri eklenir).
  useEffect(() => {
    history.pushState(null, '', location.href);
    const onPop = () => {
      if (location.pathname === '/') history.pushState(null, '', location.href);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (pathname !== '/' && pathname !== '/settings') return <Navigate to="/" replace />;
  if (!me) return null;
  const rides = orderedRides(ridesState);
  const connected = conn === 'connected';
  const everSynced = ridesState.synced;

  return (
    <div className="flex min-h-full flex-col">
      <TopBar />
      <main className="grid flex-1 gap-4 p-4 lg:grid-cols-[minmax(380px,5fr)_7fr]">
        <div key={formNonce}>
          <NewRideForm me={me} />
        </div>

        <section aria-labelledby="open-rides-title" className="min-w-0">
          <h2 id="open-rides-title" className="mb-3 text-2xl font-extrabold">
            {T.list.title} ({rides.filter((r) => r.status !== 'completed' && r.status !== 'cancelled').length})
          </h2>
          {!connected && everSynced && (
            <div className="mb-3"><Banner tone="warn" role="status">{T.list.stale}</Banner></div>
          )}
          {!connected && !everSynced && rides.length === 0 ? (
            <Banner tone="warn" role="status">{T.list.stale}</Banner>
          ) : !everSynced && rides.length === 0 ? (
            <Skeleton />
          ) : rides.length === 0 ? (
            <p className="rounded-2xl border-2 border-dashed border-slate-400 p-8 text-center text-xl">
              <span aria-hidden className="mb-2 block text-4xl">{'☰'}</span>
              {T.list.empty}
            </p>
          ) : (
            <div className="max-h-[calc(100vh-14rem)] space-y-3 overflow-y-auto pr-1">
              {rides.map((r) => (
                <RideCard
                  key={r.rideId}
                  ride={r}
                  now={now}
                  clockOffset={clockOffset}
                  connected={connected}
                  shiftLocked={shiftLocked}
                  onCancel={(rideId) => setDialog({ kind: 'cancel', rideId })}
                  onComplete={(rideId) => setDialog({ kind: 'complete', rideId })}
                />
              ))}
            </div>
          )}
          <RecentStrip />
        </section>
      </main>

      {dialog?.kind === 'cancel' && <CancelDialog rideId={dialog.rideId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'complete' && <CompleteDialog rideId={dialog.rideId} onClose={() => setDialog(null)} />}
      {settingsOpen && <SettingsDrawer />}
    </div>
  );
}
