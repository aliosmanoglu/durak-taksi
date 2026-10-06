import { useEffect, useRef, useState } from 'react';
import type { LatLng } from '@duraknet/shared';
import { distanceMeters } from '../lib/geo';
import { NOTE_MAX, QUICK_NOTES, composeNote, noteForRequest } from '../lib/notes';
import { findDuplicate } from '../lib/rides';
import { T } from '../lib/texts';
import { createRide } from '../services/actions';
import { geocoder, timeoutSignal, type GeoHit } from '../services/geocode';
import { saveRecent } from '../services/storage';
import type { Me } from '../services/types';
import { useStore } from '../store';
import { useNow } from './hooks';
import { Banner, Button, Chip } from './kit';
import { PickMap, type MapTarget } from './PickMap';

const REVERSE_TIMEOUT_MS = 4_000;
const REVERSE_DEBOUNCE_MS = 500;

const inputCls =
  'min-h-[56px] w-full rounded-xl border-2 border-slate-400 bg-white px-4 text-xl text-slate-900 disabled:opacity-60';

type GeoStatus = 'idle' | 'loading' | 'failed';

/**
 * Çağrı oluşturma bölgesi (docs/design 3.4.2). İlke: tek zorunlu bilgi alış noktası; harita + otomatik adres.
 * Başarılı oluşturmadan sonra üst bileşen `key={formNonce}` ile formu sıfırdan kurar.
 */
export function NewRideForm({ me }: { me: Me }) {
  const conn = useStore((s) => s.conn);
  const ridesState = useStore((s) => s.ridesState);
  const nearby = useStore((s) => s.nearby);
  const lockUntil = useStore((s) => s.createLockUntil);
  const recent = useStore((s) => s.recent);
  const now = useNow();

  const [pin, setPin] = useState<LatLng>(me.location);
  const [center, setCenter] = useState<LatLng>(me.location);
  const [target, setTarget] = useState<MapTarget | null>(null);
  const [mode, setMode] = useState<'pickup' | 'dropoff'>('pickup');

  const [address, setAddress] = useState(me.address ?? '');
  const [geoStatus, setGeoStatus] = useState<GeoStatus>(me.address ? 'idle' : 'loading');
  const [hits, setHits] = useState<GeoHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);

  const [dropoffOn, setDropoffOn] = useState(false);
  const [dropoff, setDropoff] = useState<LatLng | null>(null);
  const [dropoffAddress, setDropoffAddress] = useState('');

  const [noteOpen, setNoteOpen] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [noteText, setNoteText] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canLocate, setCanLocate] = useState(typeof navigator !== 'undefined' && 'geolocation' in navigator);

  // Elle yazılmış adres, sonraki pin hareketiyle ezilmez (yalnızca boşsa veya hiç düzenlenmediyse otomatik dolar).
  const addressEdited = useRef(false);
  const dropoffEdited = useRef(false);
  const nonce = useRef(0);
  const reverseCtl = useRef<{ pickup?: AbortController; dropoff?: AbortController }>({});
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  async function reverseInto(kind: 'pickup' | 'dropoff', p: LatLng) {
    reverseCtl.current[kind]?.abort();
    const ctl = new AbortController();
    reverseCtl.current[kind] = ctl;
    const text = await geocoder.reverse(p, timeoutSignal(REVERSE_TIMEOUT_MS, ctl.signal)).catch(() => null);
    if (reverseCtl.current[kind] !== ctl) return; // yeni arama devraldı
    if (kind === 'pickup') {
      if (!addressEdited.current) {
        if (text) setAddress(text);
        setGeoStatus(text ? 'idle' : 'failed');
      } else setGeoStatus('idle');
    } else if (text && !dropoffEdited.current) {
      setDropoffAddress(text);
    }
  }

  // Durak adresi yoksa açılışta konumdan adres bul (dış sistemle eşitleme; ilk durum zaten 'loading').
  useEffect(() => {
    if (me.address) return;
    const t = setTimeout(() => void reverseInto('pickup', me.location), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      clearTimeout(debounce.current);
      reverseCtl.current.pickup?.abort();
      reverseCtl.current.dropoff?.abort();
    },
    [],
  );

  function onUserMove(c: LatLng) {
    setCenter(c);
    if (mode !== 'pickup') return;
    setPin(c);
    setHits(null);
    if (!addressEdited.current) setGeoStatus('loading');
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void reverseInto('pickup', c), REVERSE_DEBOUNCE_MS);
  }

  function goTo(p: LatLng, label?: string) {
    setPin(p);
    setCenter(p);
    setHits(null);
    setTarget({ point: p, nonce: ++nonce.current });
    if (label) {
      setAddress(label);
      addressEdited.current = false;
      setGeoStatus('idle');
    } else {
      if (!addressEdited.current) setGeoStatus('loading');
      void reverseInto('pickup', p);
    }
  }

  function onAddressChange(v: string) {
    setAddress(v);
    addressEdited.current = v.trim().length > 0;
    if (geoStatus !== 'idle') setGeoStatus('idle');
    setSearchError(false);
  }

  async function doSearch() {
    const q = address.trim();
    if (q.length < 3 || searching) return;
    setSearching(true);
    setSearchError(false);
    try {
      setHits(await geocoder.search(q, pin, timeoutSignal(6_000)));
    } catch {
      setHits(null);
      setSearchError(true);
    }
    setSearching(false);
  }

  function locate() {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMode('pickup');
        goTo({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) setCanLocate(false); // izin reddedilirse düğme gizlenir
      },
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 30_000 },
    );
  }

  function confirmDropoff() {
    setDropoff(center);
    if (!dropoffEdited.current) void reverseInto('dropoff', center);
    setMode('pickup');
    setTarget({ point: pin, nonce: ++nonce.current });
    setCenter(pin);
  }

  function toggleTag(t: string) {
    setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }

  function removeDropoff() {
    setDropoffOn(false);
    setDropoff(null);
    setDropoffAddress('');
    dropoffEdited.current = false;
    if (mode === 'dropoff') {
      setMode('pickup');
      setTarget({ point: pin, nonce: ++nonce.current });
    }
  }

  const connected = conn === 'connected';
  const lockLeftSec = Math.max(0, Math.ceil((lockUntil - now) / 1000));
  const addressOk = address.trim().length > 0;
  const duplicate = findDuplicate(ridesState, pin, distanceMeters);
  const noteLen = composeNote(tags, noteText).length;

  const hint = !connected
    ? T.form.offline
    : lockLeftSec > 0
      ? T.form.locked(lockLeftSec)
      : !addressOk
        ? geoStatus === 'failed'
          ? T.form.addressManual
          : T.form.needAddress
        : null;
  const canSubmit = connected && lockLeftSec === 0 && addressOk && !submitting && mode === 'pickup';

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const res = await createRide({
      pickup: pin,
      pickupAddress: address,
      ...(dropoffOn && dropoff ? { dropoff } : {}),
      ...(dropoffOn && dropoffAddress.trim() ? { dropoffAddress } : {}),
      notes: noteForRequest(tags, noteText),
    });
    if (!res.ok) {
      setError(res.message);
      setSubmitting(false);
    }
    // Başarıda üst bileşen formu `key` ile yeniden kurar.
  }

  function clearRecent() {
    saveRecent([]);
    useStore.getState().set({ recent: [] });
  }

  const busy = submitting;

  return (
    <section aria-labelledby="new-ride-title" className="space-y-3">
      <h2 id="new-ride-title" className="text-2xl font-extrabold">{T.form.title}</h2>

      <PickMap
        initialCenter={me.location}
        standLocation={me.location}
        maxRadiusM={me.maxRadiusM}
        drivers={nearby?.drivers ?? []}
        target={target}
        mode={mode}
        pickup={pin}
        dropoff={dropoff}
        onCenter={onUserMove}
      >
        <div className="absolute bottom-2 left-2 z-[1000] flex gap-2">
          {canLocate && mode === 'pickup' && (
            <Button onClick={locate} disabled={busy} className="shadow-lg">{T.form.myLocation}</Button>
          )}
        </div>
        {mode === 'dropoff' && (
          <div className="absolute inset-x-2 bottom-2 z-[1000] flex gap-2">
            <Button variant="primary" className="flex-1 shadow-lg" onClick={confirmDropoff}>{T.form.dropoffPick}</Button>
            <Button className="shadow-lg" onClick={() => { setMode('pickup'); setTarget({ point: pin, nonce: ++nonce.current }); setCenter(pin); }}>{T.form.dropoffCancel}</Button>
          </div>
        )}
      </PickMap>

      <div>
        <label htmlFor="pickup-address" className="mb-1 block font-semibold">{T.form.pickupLabel}</label>
        <div className="flex gap-2">
          <input
            id="pickup-address"
            className={inputCls}
            value={address}
            placeholder={geoStatus === 'loading' ? T.form.addressSearching : T.form.pickupPlaceholder}
            onChange={(e) => onAddressChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void doSearch())}
            maxLength={300}
            disabled={busy}
            autoComplete="off"
            aria-describedby="pickup-hint"
          />
          <Button onClick={() => void doSearch()} disabled={busy || searching || address.trim().length < 3}>{T.form.search}</Button>
        </div>
        <p id="pickup-hint" className="mt-1 min-h-[1.5rem] text-base text-slate-600 dark:text-slate-300">
          {geoStatus === 'loading' ? T.form.addressSearching : geoStatus === 'failed' && !addressOk ? T.form.addressManual : ''}
          {searchError ? T.form.searchFailed : ''}
        </p>
        {hits && (
          <ul className="mt-1 space-y-2" aria-label="Adres önerileri">
            {hits.length === 0 && <li className="text-base">{T.form.searchNone}</li>}
            {hits.map((h, i) => (
              <li key={`${h.label}-${i}`}>
                <button
                  type="button"
                  className="min-h-[56px] w-full rounded-xl border-2 border-slate-400 bg-white px-4 text-left text-lg text-slate-900 hover:bg-slate-100"
                  onClick={() => goTo(h.location, h.label)}
                >
                  {h.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {recent.length > 0 && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold">{T.form.recent}</span>
            <button type="button" className="min-h-[44px] px-2 text-base underline" onClick={clearRecent}>{T.form.recentClear}</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recent.map((r) => (
              <Chip key={r.address} disabled={busy} onClick={() => { setMode('pickup'); goTo(r.location, r.address); }}>
                {r.address.length > 28 ? `${r.address.slice(0, 27)}…` : r.address}
              </Chip>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!dropoffOn && <Button onClick={() => setDropoffOn(true)} disabled={busy}>{T.form.addDropoff}</Button>}
        {!noteOpen && <Button onClick={() => setNoteOpen(true)} disabled={busy}>{T.form.addNote}</Button>}
      </div>

      {dropoffOn && (
        <div>
          <label htmlFor="dropoff-address" className="mb-1 block font-semibold">{T.form.dropoffLabel}</label>
          <input
            id="dropoff-address"
            className={inputCls}
            value={dropoffAddress}
            onChange={(e) => { setDropoffAddress(e.target.value); dropoffEdited.current = e.target.value.trim().length > 0; }}
            maxLength={300}
            disabled={busy}
            autoComplete="off"
          />
          <div className="mt-2 flex gap-2">
            <Button onClick={() => { setMode('dropoff'); setCenter(dropoff ?? pin); if (dropoff) setTarget({ point: dropoff, nonce: ++nonce.current }); }} disabled={busy || mode === 'dropoff'}>
              {T.form.dropoffFromMap}
            </Button>
            <Button variant="ghost" onClick={removeDropoff} disabled={busy}>{T.form.removeDropoff}</Button>
          </div>
        </div>
      )}

      {noteOpen && (
        <div>
          <span className="mb-1 block font-semibold">{T.form.noteLabel}</span>
          <div className="mb-2 flex flex-wrap gap-2">
            {QUICK_NOTES.map((t) => (
              <Chip key={t} active={tags.includes(t)} onClick={() => toggleTag(t)} disabled={busy}>{t}</Chip>
            ))}
          </div>
          <textarea
            className={`${inputCls} py-2`}
            rows={2}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            maxLength={Math.max(0, NOTE_MAX - composeNote(tags, '').length - (tags.length ? 2 : 0))}
            disabled={busy}
            aria-label={T.form.noteLabel}
          />
          <p className="text-right text-base text-slate-600 dark:text-slate-300">{noteLen}/{NOTE_MAX}</p>
        </div>
      )}

      {duplicate && <Banner tone="warn">{T.form.duplicate(duplicate.shortCode || '—')}</Banner>}
      {error && <Banner tone="error" role="alert">{error}</Banner>}
      {hint && <p className="text-base font-semibold text-slate-700 dark:text-slate-200" role="status">{hint}</p>}

      <div className="sticky bottom-0 -mx-1 bg-slate-100/95 px-1 pb-2 pt-2 dark:bg-slate-900/95">
        <Button variant="primary" size="lg" className="w-full" disabled={!canSubmit} onClick={() => void submit()}>
          {submitting ? T.form.submitting : T.form.submit}
        </Button>
      </div>
    </section>
  );
}
