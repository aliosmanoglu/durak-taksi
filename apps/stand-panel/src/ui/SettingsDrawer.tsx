import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RADIUS_LIMITS } from '@duraknet/shared';
import { formatRadiusKm } from '../lib/format';
import { isOpenRide } from '../lib/rides';
import { T } from '../lib/texts';
import { saveRadius } from '../services/actions';
import { APP_VERSION } from '../services/config';
import { logout } from '../services/session';
import { saveSoundEnabled } from '../services/storage';
import { useStore } from '../store';
import { Banner, Button, Dialog } from './kit';

const STEP = 500;

/** P3: yarıçap, ses (yalnızca bu cihaz), çıkış. Yarıçap yalnızca sonraki çağrıları etkiler. */
export function SettingsDrawer() {
  const navigate = useNavigate();
  const me = useStore((s) => s.me);
  const soundEnabled = useStore((s) => s.soundEnabled);
  const openCount = useStore((s) => Object.values(s.ridesState.rides).filter(isOpenRide).length);
  const set = useStore((s) => s.set);

  const [initial, setInitial] = useState(me?.initialRadiusM ?? 2000);
  const [max, setMax] = useState(me?.maxRadiusM ?? 8000);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutErr, setLogoutErr] = useState<string | null>(null);
  const close = () => navigate('/', { replace: true });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && navigate('/', { replace: true });
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate]);
  const rangeBad = max < initial;

  async function save() {
    if (rangeBad) return setMsg({ tone: 'error', text: T.settings.err.range });
    setSaving(true);
    setMsg(null);
    const res = await saveRadius(initial, max);
    setSaving(false);
    setMsg(res.ok ? { tone: 'info', text: T.settings.saved } : { tone: 'error', text: res.message });
  }

  async function doLogout() {
    setLogoutBusy(true);
    setLogoutErr(null);
    const out = await logout();
    setLogoutBusy(false);
    if (!out.ok) setLogoutErr(out.kind === 'network' ? T.err.network : T.err.server);
    else navigate('/login', { replace: true });
  }

  const slider = (id: string, label: string, value: number, onChange: (n: number) => void) => (
    <div>
      <label htmlFor={id} className="flex justify-between font-semibold">
        <span>{label}</span>
        <span>{formatRadiusKm(value)}</span>
      </label>
      <input
        id={id}
        type="range"
        min={RADIUS_LIMITS.min}
        max={RADIUS_LIMITS.max}
        step={STEP}
        value={value}
        onChange={(e) => { onChange(Number(e.target.value)); setMsg(null); }}
        className="h-14 w-full"
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-[1500] flex justify-end bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <aside role="dialog" aria-label={T.settings.title} className="h-full w-full max-w-md space-y-5 overflow-y-auto bg-white p-6 text-slate-900 shadow-2xl dark:bg-slate-800 dark:text-slate-100">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-extrabold">{T.settings.title}</h2>
          <Button autoFocus onClick={close}>{T.settings.close}</Button>
        </div>

        <section className="space-y-3">
          <h3 className="text-xl font-bold">{T.settings.radius}</h3>
          {slider('r-initial', T.settings.initial, initial, setInitial)}
          {slider('r-max', T.settings.max, max, setMax)}
          <p className="text-base text-slate-600 dark:text-slate-300">{T.settings.note}</p>
          {rangeBad && <Banner tone="error" role="alert">{T.settings.err.range}</Banner>}
          {msg && <Banner tone={msg.tone === 'info' ? 'info' : 'error'} role="status">{msg.text}</Banner>}
          <Button variant="primary" className="w-full" disabled={saving || rangeBad} onClick={() => void save()}>
            {saving ? T.settings.saving : T.settings.save}
          </Button>
        </section>

        <section className="space-y-2">
          <label className="flex min-h-[56px] items-center gap-3 text-lg font-semibold">
            <input
              type="checkbox"
              className="h-7 w-7"
              checked={soundEnabled}
              onChange={(e) => { saveSoundEnabled(e.target.checked); set({ soundEnabled: e.target.checked }); }}
            />
            {T.settings.sounds}
          </label>
          <p className="text-base text-slate-600 dark:text-slate-300">{T.settings.soundsHint}</p>
        </section>

        <section className="space-y-2">
          <Button variant="danger" className="w-full" onClick={() => { setLogoutErr(null); setConfirmLogout(true); }}>
            {T.settings.logout}
          </Button>
          <p className="text-center text-base text-slate-600 dark:text-slate-300">{T.settings.version} {APP_VERSION}</p>
        </section>
      </aside>

      {confirmLogout && (
        <Dialog title={T.logout.title} onClose={() => !logoutBusy && setConfirmLogout(false)}>
          <p className="text-lg">{T.logout.body}</p>
          {openCount > 0 && <div className="mt-3"><Banner tone="warn">{T.logout.confirmOpen}</Banner></div>}
          {logoutErr && <div className="mt-3"><Banner tone="error" role="alert">{logoutErr}</Banner></div>}
          <div className="mt-6 flex justify-between gap-4">
            <Button variant="primary" size="lg" data-autofocus disabled={logoutBusy} onClick={() => setConfirmLogout(false)}>{T.logout.back}</Button>
            <Button variant="danger" size="lg" disabled={logoutBusy} onClick={() => void doLogout()}>{T.logout.confirm}</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
