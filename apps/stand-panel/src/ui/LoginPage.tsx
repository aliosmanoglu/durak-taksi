import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatElapsed } from '../lib/format';
import { T } from '../lib/texts';
import { login } from '../services/session';
import { useStore } from '../store';
import { useNow } from './hooks';
import { Banner, Button } from './kit';

export function LoginPage() {
  const navigate = useNavigate();
  const notice = useStore((s) => s.loginNotice);
  const now = useNow();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedUntil, setBlockedUntil] = useState(0);

  const waitMs = Math.max(0, blockedUntil - now);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) return setError(T.login.missing);
    setBusy(true);
    setError(null);
    const out = await login(username, password);
    setBusy(false);
    switch (out.kind) {
      case 'ok':
        navigate('/', { replace: true });
        break;
      case 'pending':
      case 'suspended':
        navigate('/pending', { replace: true });
        break;
      case 'credentials':
        setPassword('');
        setError(T.login.err.credentials);
        break;
      case 'rateLimited':
        setBlockedUntil(Date.now() + out.retryAfterMs);
        setError(T.login.err.rateLimited(formatElapsed(out.retryAfterMs)));
        break;
      case 'network':
        setError(T.err.network);
        break;
      default:
        setError(T.err.server);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-2xl bg-white p-8 shadow-xl dark:bg-slate-800" noValidate>
        <div className="text-center">
          <h1 className="text-4xl font-extrabold tracking-tight">{T.appName}</h1>
          <p className="mt-1 text-xl text-slate-600 dark:text-slate-300">{T.login.title}</p>
        </div>
        {notice && <Banner tone="warn" role="alert">{notice}</Banner>}
        {error && <Banner tone="error" role="alert">{error}</Banner>}
        <label className="block">
          <span className="mb-1 block font-semibold">{T.login.username}</span>
          <input
            className="min-h-[56px] w-full rounded-xl border-2 border-slate-400 bg-white px-4 text-xl text-slate-900"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>
        <label className="block">
          <span className="mb-1 block font-semibold">{T.login.password}</span>
          <div className="flex gap-2">
            <input
              className="min-h-[56px] w-full rounded-xl border-2 border-slate-400 bg-white px-4 text-xl text-slate-900"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
            />
            <Button onClick={() => setShow((v) => !v)} aria-pressed={show}>
              {show ? T.login.hide : T.login.show}
            </Button>
          </div>
        </label>
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy || waitMs > 0}>
          {busy ? T.login.submitting : T.login.submit}
        </Button>
        <p className="text-center text-base text-slate-600 dark:text-slate-300">{T.login.forgot}</p>
      </form>
    </main>
  );
}
