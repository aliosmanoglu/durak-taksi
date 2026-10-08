import { useNavigate } from 'react-router-dom';
import { T } from '../lib/texts';
import { useStore } from '../store';
import { Button } from './kit';

/** P1b: onay bekleniyor / askıya alındı. Otomatik yoklama yoktur. */
export function PendingPage() {
  const navigate = useNavigate();
  const kind = useStore((s) => s.blockedKind);
  const set = useStore((s) => s.set);
  const suspended = kind === 'suspended';
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <section className="w-full max-w-md space-y-4 rounded-2xl bg-white p-8 text-center shadow-xl dark:bg-slate-800">
        <h1 className="text-3xl font-extrabold">{suspended ? T.pending.suspendedTitle : T.pending.title}</h1>
        <p className="text-xl" role="status">{suspended ? T.pending.suspendedBody : T.pending.body}</p>
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={() => {
            set({ auth: 'anon', blockedKind: null });
            navigate('/login', { replace: true });
          }}
        >
          {T.pending.back}
        </Button>
      </section>
    </main>
  );
}
