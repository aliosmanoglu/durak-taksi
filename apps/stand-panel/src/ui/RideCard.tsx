import { STAND_SUSPENDED_REASON } from '@duraknet/shared';
import { elapsedSince } from '../lib/clock';
import { formatDistance, formatElapsed, formatElapsedA11y, formatPhone, formatRadiusKm, telHref } from '../lib/format';
import { isTerminal, type RideView } from '../lib/rides';
import { T } from '../lib/texts';
import { dismissCardBanner } from '../services/card-actions';
import { Banner, Button } from './kit';

const stripe: Record<string, string> = {
  created: 'border-slate-500',
  searching: 'border-blue-600',
  matched: 'border-emerald-600',
  completed: 'border-emerald-600',
  cancelled: 'border-slate-500',
};

function Badge({ ride }: { ride: RideView }) {
  const base = 'inline-flex items-center gap-2 rounded-full px-3 py-1 text-base font-extrabold';
  if (ride.unknown) return <span className={`${base} bg-yellow-200 text-yellow-950`}>{'? '}{T.card.unknownBadge}</span>;
  switch (ride.status) {
    case 'created':
      return <span className={`${base} bg-slate-200 text-slate-900`}>{T.card.created}</span>;
    case 'searching':
      return (
        <span className={`${base} bg-blue-100 text-blue-950`}>
          <span aria-hidden className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-blue-700 border-t-transparent motion-reduce:animate-none" />
          {T.card.searching}
        </span>
      );
    case 'matched':
      return (
        <span className={`${base} bg-emerald-100 text-emerald-950`}>
          <span aria-hidden>{'● '}</span>{T.card.matched}
        </span>
      );
    case 'completed':
      return <span className={`${base} bg-emerald-100 text-emerald-950`}><span aria-hidden>{'✓ '}</span>{T.card.completed}</span>;
    default:
      return <span className={`${base} bg-slate-200 text-slate-900`}><span aria-hidden>{'✕ '}</span>{T.card.cancelled}</span>;
  }
}

export function RideCard({
  ride,
  now,
  clockOffset,
  connected,
  shiftLocked,
  onCancel,
  onComplete,
}: {
  ride: RideView;
  now: number;
  clockOffset: number;
  connected: boolean;
  shiftLocked: boolean;
  onCancel: (rideId: string) => void;
  onComplete: (rideId: string) => void;
}) {
  const terminal = isTerminal(ride.status);
  const actionsOff = !connected || shiftLocked;
  const searchingElapsed = elapsedSince(ride.searchingSince ?? ride.createdAt, now, clockOffset);
  const matchedElapsed = elapsedSince(ride.matchedAt, now, clockOffset);
  const flashing = ride.flash !== undefined && now + clockOffset < ride.flash.untilMs;
  const flashCls = flashing
    ? ride.flash?.kind === 'matched'
      ? 'ring-4 ring-emerald-500 motion-safe:animate-pulse'
      : 'ring-4 ring-yellow-400 motion-safe:animate-pulse'
    : '';
  const stateWord = ride.unknown ? T.card.unknownBadge : T.card[ride.status];
  const elapsedForName = ride.status === 'matched' ? matchedElapsed : searchingElapsed;
  const unseenDelay = ride.status === 'created' && now - ride.seenAtMs > 10_000;

  return (
    <article
      aria-label={T.a11y.cardName(ride.shortCode || '…', stateWord, formatElapsedA11y(elapsedForName))}
      className={`rounded-2xl border-l-[10px] bg-white p-4 shadow-md dark:bg-slate-800 ${stripe[ride.status] ?? ''} ${flashCls} ${connected ? '' : 'opacity-60'}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-3xl font-extrabold tracking-wider">{ride.shortCode || '······'}</div>
          <p className="text-xl font-semibold [overflow-wrap:anywhere]">
            {ride.detailsMissing ? T.card.details : <span className="line-clamp-2">{ride.pickupAddress}</span>}
          </p>
          {ride.dropoffAddress && <p className="text-lg [overflow-wrap:anywhere]">{'→ '}{ride.dropoffAddress}</p>}
          {ride.notes && <p className="text-lg italic [overflow-wrap:anywhere]"><span aria-hidden>{'✎ '}</span>{ride.notes}</p>}
        </div>
        <Badge ride={ride} />
      </header>

      {ride.driverCancelled && (
        <div className="mt-3 space-y-2">
          <Banner tone="alert" role="alert">
            {ride.driverCancelled.suspended
              ? T.card.driverSuspended(ride.driverCancelled.name, ride.driverCancelled.plate)
              : T.card.driverCancelled(ride.driverCancelled.name, ride.driverCancelled.plate)}
            {ride.driverCancelled.reason && !ride.driverCancelled.suspended && (
              <span className="block font-normal">{T.card.reasonPrefix}{ride.driverCancelled.reason}</span>
            )}
          </Banner>
          <Button onClick={() => dismissCardBanner(ride.rideId, 'driverCancelled')}>{T.card.ok}</Button>
        </div>
      )}

      {ride.status === 'created' && (
        <p className="mt-2 text-lg">{unseenDelay ? T.card.startDelayed : T.card.starting}</p>
      )}

      {ride.status === 'searching' && (
        <div className="mt-2 space-y-2">
          <p className="text-lg font-semibold">
            {ride.wave !== undefined && ride.radiusM !== undefined && ride.notifiedCount !== undefined
              ? T.card.detail(formatElapsed(searchingElapsed), ride.wave, formatRadiusKm(ride.radiusM), ride.notifiedCount)
              : formatElapsed(searchingElapsed)}
          </p>
          {ride.notifiedCount === 0 && <Banner tone="warn">{T.card.noDrivers}</Banner>}
          {ride.stillOpenMinutes !== undefined && (
            <Banner tone="warn" role="alert">
              <p>{T.card.stillOpen(ride.stillOpenMinutes)}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button onClick={() => dismissCardBanner(ride.rideId, 'stillOpen')}>{T.card.keepWaiting}</Button>
                <Button variant="danger" disabled={actionsOff} onClick={() => onCancel(ride.rideId)}>{T.card.cancel}</Button>
              </div>
            </Banner>
          )}
        </div>
      )}

      {ride.status === 'matched' && ride.driver && (
        <div className="mt-3 space-y-1">
          <div className="text-2xl font-extrabold">{ride.driver.name}</div>
          <div className="font-mono text-2xl font-extrabold tracking-wider">{ride.driver.plate}</div>
          {ride.driver.vehicle && <div className="text-lg">{ride.driver.vehicle}</div>}
          <a className="inline-block min-h-[44px] text-xl font-semibold text-blue-800 underline dark:text-blue-300" href={telHref(ride.driver.phone)}>
            {formatPhone(ride.driver.phone)}
          </a>
          <div className="text-base text-slate-600 dark:text-slate-300">
            {ride.distanceM !== undefined && <span>{T.card.matchedDistance(formatDistance(ride.distanceM))}{' · '}</span>}
            {ride.matchedAt && T.card.matchedSince(formatElapsed(matchedElapsed))}
          </div>
        </div>
      )}

      {ride.unknown && <p className="mt-2 text-lg font-semibold">{T.card.unknown}</p>}
      {ride.status === 'cancelled' && ride.cancelReason && (
        <p className="mt-2 text-lg">
          {ride.cancelReason === STAND_SUSPENDED_REASON ? T.card.standSuspended : `${T.card.reasonPrefix}${ride.cancelReason}`}
        </p>
      )}

      {!terminal && !(ride.status === 'searching' && ride.stillOpenMinutes !== undefined) && (
        <footer className="mt-4 flex flex-wrap items-center gap-6">
          {ride.status === 'matched' && (
            <Button variant="success" disabled={actionsOff} onClick={() => onComplete(ride.rideId)}>{T.card.complete}</Button>
          )}
          <Button variant="danger" disabled={actionsOff} onClick={() => onCancel(ride.rideId)}>{T.card.cancel}</Button>
        </footer>
      )}
    </article>
  );
}
