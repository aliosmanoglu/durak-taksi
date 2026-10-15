import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatElapsed } from '../lib/format';
import { validateStandRegister, type StandRegisterErrors, type StandRegisterForm } from '../lib/stand-register';
import { T } from '../lib/texts';
import { TA } from '../lib/texts-admin';
import { registerStand } from '../services/register';
import { useStore } from '../store';
import { KvkkDialog } from './KvkkDialog';
import { Banner, Button } from './kit';

const EMPTY: StandRegisterForm = { name: '', phone: '', address: '', username: '', password: '', lat: '', lng: '', kvkk: false };
const INPUT = 'min-h-[56px] w-full rounded-xl border-2 border-slate-400 bg-white px-4 text-xl text-slate-900';

function FieldError({ text }: { text?: string }) {
  return text ? <span className="mt-1 block font-semibold text-red-800 dark:text-red-300" role="alert">{text}</span> : null;
}

/** Durak kaydı: başarıda "onay bekleniyor" ekranı. Konum: bu cihazdan ya da elle enlem/boylam. */
export function RegisterPage() {
  const navigate = useNavigate();
  const set = useStore((s) => s.set);
  const [form, setForm] = useState<StandRegisterForm>(EMPTY);
  const [errors, setErrors] = useState<StandRegisterErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [kvkkOpen, setKvkkOpen] = useState(false);

  const upd = <K extends keyof StandRegisterForm>(k: K, v: StandRegisterForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  function useDeviceLocation() {
    if (!('geolocation' in navigator)) return setBanner(TA.register.locationFailed);
    setLocating(true);
    setBanner(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setForm((f) => ({ ...f, lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) }));
      },
      () => {
        setLocating(false);
        setBanner(TA.register.locationFailed);
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const v = validateStandRegister(form);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setBanner(null);
    setBusy(true);
    const r = await registerStand(v.input);
    setBusy(false);
    if (r.ok) {
      set({ auth: 'blocked', blockedKind: 'pending' });
      navigate('/pending', { replace: true });
      return;
    }
    if (r.kind === 'network') return setBanner(T.err.network);
    if (r.code === 'CONFLICT') return setBanner(TA.register.errConflict);
    if (r.code === 'RATE_LIMITED') return setBanner(T.login.err.rateLimited(formatElapsed(r.retryAfterMs ?? 60_000)));
    if (r.code === 'VALIDATION_ERROR') return setBanner(T.form.err.validation);
    setBanner(T.err.server);
  }

  const text = (k: 'name' | 'phone' | 'address' | 'username' | 'password', label: string, extra: { type?: string; autoComplete?: string; err?: string } = {}) => (
    <label className="block">
      <span className="mb-1 block font-semibold">{label}</span>
      <input
        className={INPUT}
        type={extra.type ?? 'text'}
        value={form[k]}
        onChange={(e) => upd(k, e.target.value)}
        autoComplete={extra.autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={busy}
        aria-invalid={extra.err ? true : undefined}
      />
      <FieldError text={extra.err} />
    </label>
  );

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-8 shadow-xl dark:bg-slate-800" noValidate>
        <div className="text-center">
          <h1 className="text-4xl font-extrabold tracking-tight">{T.appName}</h1>
          <p className="mt-1 text-xl text-slate-600 dark:text-slate-300">{TA.register.title}</p>
          <p className="mt-1 text-base text-slate-600 dark:text-slate-300">{TA.register.intro}</p>
        </div>
        {banner && <Banner tone="error" role="alert">{banner}</Banner>}
        {text('name', TA.register.name, { err: errors.name })}
        {text('phone', TA.register.phone, { autoComplete: 'tel', err: errors.phone })}
        {text('address', TA.register.address)}
        {text('username', TA.register.username, { autoComplete: 'username', err: errors.username })}
        {text('password', TA.register.password, { type: 'password', autoComplete: 'new-password', err: errors.password })}
        <fieldset className="space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block font-semibold">{TA.register.lat}</span>
              <input className={INPUT} inputMode="decimal" value={form.lat} onChange={(e) => upd('lat', e.target.value)} disabled={busy} />
            </label>
            <label className="block">
              <span className="mb-1 block font-semibold">{TA.register.lng}</span>
              <input className={INPUT} inputMode="decimal" value={form.lng} onChange={(e) => upd('lng', e.target.value)} disabled={busy} />
            </label>
          </div>
          <FieldError text={errors.location} />
          <Button onClick={useDeviceLocation} disabled={busy || locating} className="w-full">
            {locating ? TA.register.locating : TA.register.useLocation}
          </Button>
        </fieldset>
        <div>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-7 w-7 shrink-0"
              checked={form.kvkk}
              onChange={(e) => upd('kvkk', e.target.checked)}
              disabled={busy}
              aria-invalid={errors.kvkk ? true : undefined}
            />
            <span className="text-lg">{TA.register.kvkkLabel}</span>
          </label>
          <button type="button" className="mt-1 min-h-[44px] font-semibold text-blue-800 underline dark:text-blue-300" onClick={() => setKvkkOpen(true)}>
            {TA.register.kvkkRead}
          </button>
          <FieldError text={errors.kvkk} />
        </div>
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>
          {busy ? TA.register.submitting : TA.register.submit}
        </Button>
        <p className="text-center">
          <Link to="/login" className="inline-flex min-h-[44px] items-center font-semibold text-blue-800 underline dark:text-blue-300">{TA.register.back}</Link>
        </p>
      </form>
      {kvkkOpen && <KvkkDialog onClose={() => setKvkkOpen(false)} />}
    </main>
  );
}
