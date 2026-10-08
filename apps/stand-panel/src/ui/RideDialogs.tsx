import { useState } from 'react';
import { isTerminal } from '../lib/rides';
import { T } from '../lib/texts';
import { cancelRide, completeRide, type CloseOutcome } from '../services/actions';
import { pushToast, useStore } from '../store';
import { Banner, Button, Chip, Dialog } from './kit';

export type DialogState = { kind: 'cancel' | 'complete'; rideId: string } | null;

function useOpenRide(rideId: string) {
  const ride = useStore((s) => s.ridesState.rides[rideId]);
  return ride && !isTerminal(ride.status) ? ride : null;
}

/** Sonuca göre diyalog kapanır ya da satır içi hata gösterilir. */
function report(out: CloseOutcome, close: () => void, setError: (m: string) => void) {
  if (out.kind === 'error') return setError(out.message);
  close();
  if (out.kind === 'changed') pushToast(T.card.changed, 'warn');
  // 'unknown' için kartta rozet + metin var; 'ok' için kart zaten kapandı.
}

export function CancelDialog({ rideId, onClose }: { rideId: string; onClose: () => void }) {
  const ride = useOpenRide(rideId);
  const [reason, setReason] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ride) return null;

  const isOther = reason === 'Diğer';
  const finalReason = isOther ? other.trim() || undefined : (reason ?? undefined);

  async function confirm() {
    setBusy(true);
    setError(null);
    const out = await cancelRide(rideId, finalReason);
    setBusy(false);
    report(out, onClose, setError);
  }

  return (
    <Dialog title={T.cancel.title} onClose={busy ? () => {} : onClose}>
      <p className="text-xl font-semibold">
        <span className="font-mono">{ride.shortCode}</span>{' · '}{ride.pickupAddress}
      </p>
      {ride.status === 'matched' && ride.driver && (
        <p className="mt-2 text-lg">{T.cancel.matchedNote(`${ride.driver.name} (${ride.driver.plate})`)}</p>
      )}
      <p className="mb-2 mt-4 font-semibold">{T.cancel.reasonLabel}</p>
      <div className="flex flex-wrap gap-2">
        {T.cancel.reasons.map((r) => (
          <Chip key={r} active={reason === r} disabled={busy} onClick={() => setReason(reason === r ? null : r)}>{r}</Chip>
        ))}
      </div>
      {isOther && (
        <input
          className="mt-3 min-h-[56px] w-full rounded-xl border-2 border-slate-400 bg-white px-4 text-xl text-slate-900"
          value={other}
          maxLength={120}
          placeholder={T.cancel.otherPlaceholder}
          aria-label={T.cancel.otherPlaceholder}
          onChange={(e) => setOther(e.target.value)}
          disabled={busy}
        />
      )}
      {error && <div className="mt-3"><Banner tone="error" role="alert">{error}</Banner></div>}
      <div className="mt-6 flex justify-between gap-4">
        <Button variant="primary" size="lg" data-autofocus onClick={onClose} disabled={busy}>{T.cancel.back}</Button>
        <Button variant="danger" size="lg" onClick={() => void confirm()} disabled={busy}>{busy ? T.cancel.working : T.cancel.confirm}</Button>
      </div>
    </Dialog>
  );
}

export function CompleteDialog({ rideId, onClose }: { rideId: string; onClose: () => void }) {
  const ride = useOpenRide(rideId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ride) return null;

  async function confirm() {
    setBusy(true);
    setError(null);
    const out = await completeRide(rideId);
    setBusy(false);
    report(out, onClose, setError);
  }

  return (
    <Dialog title={T.complete.title} onClose={busy ? () => {} : onClose}>
      <p className="text-xl font-semibold">
        <span className="font-mono">{ride.shortCode}</span>
        {ride.driver && <>{' · '}{ride.driver.name} ({ride.driver.plate})</>}
      </p>
      <p className="mt-2 text-lg">{T.complete.note}</p>
      {error && <div className="mt-3"><Banner tone="error" role="alert">{error}</Banner></div>}
      <div className="mt-6 flex justify-between gap-4">
        <Button variant="secondary" size="lg" data-autofocus onClick={onClose} disabled={busy}>{T.complete.back}</Button>
        <Button variant="success" size="lg" onClick={() => void confirm()} disabled={busy}>{busy ? T.complete.working : T.complete.confirm}</Button>
      </div>
    </Dialog>
  );
}
