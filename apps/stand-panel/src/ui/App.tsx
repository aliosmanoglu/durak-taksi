import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { tickArchive, isTerminal } from '../lib/rides';
import { T } from '../lib/texts';
import { retryBoot } from '../services/session';
import { keepScreenAwake } from '../services/wakelock';
import { serverNow } from '../services/realtime';
import { updateRides, useStore } from '../store';
import { AdminPage } from './AdminPage';
import { HomePage } from './HomePage';
import { LoginPage } from './LoginPage';
import { PendingPage } from './PendingPage';
import { RegisterPage } from './RegisterPage';
import { useNow } from './hooks';
import { Button, Toasts } from './kit';

/** Sekme başlığı, ekran uyanık tutma ve terminal kartların arşive taşınması gibi görünmeyen işler. */
function Housekeeping() {
  const authed = useStore((s) => s.auth === 'authed');
  const alerts = useStore((s) => s.alerts);
  const now = useNow();

  useEffect(() => {
    keepScreenAwake(authed);
  }, [authed]);

  useEffect(() => {
    document.title = alerts > 0 ? `(${alerts}) ${T.appName}` : T.appName;
  }, [alerts]);

  useEffect(() => {
    // Dokunma/klavye görülmemiş uyarıları temizler.
    const clear = () => useStore.getState().alerts > 0 && useStore.getState().set({ alerts: 0 });
    window.addEventListener('pointerdown', clear);
    window.addEventListener('keydown', clear);
    return () => {
      window.removeEventListener('pointerdown', clear);
      window.removeEventListener('keydown', clear);
    };
  }, []);

  useEffect(() => {
    const rs = useStore.getState().ridesState;
    if (Object.values(rs.rides).some((r) => isTerminal(r.status))) updateRides((s) => tickArchive(s, serverNow()));
  }, [now]);

  return null;
}

function Splash({ failed }: { failed?: boolean }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-4xl font-extrabold">{T.appName}</h1>
      {failed ? (
        <>
          <p className="text-xl" role="alert">{T.err.network}</p>
          <Button variant="primary" size="lg" onClick={() => void retryBoot()}>{T.err.retry}</Button>
        </>
      ) : (
        <p className="text-xl">{T.list.loading}</p>
      )}
    </main>
  );
}

export function App() {
  const auth = useStore((s) => s.auth);
  const authed = auth === 'authed';
  const role = useStore((s) => s.role);

  let body;
  if (auth === 'booting') body = <Splash />;
  else if (auth === 'bootFailed') body = <Splash failed />;
  else {
    body = (
      <Routes>
        <Route path="/login" element={auth === 'authed' ? <Navigate to="/" replace /> : auth === 'blocked' ? <Navigate to="/pending" replace /> : <LoginPage />} />
        <Route path="/register" element={auth === 'anon' ? <RegisterPage /> : <Navigate to={auth === 'authed' ? '/' : auth === 'blocked' ? '/pending' : '/login'} replace />} />
        <Route path="/pending" element={auth === 'blocked' ? <PendingPage /> : <Navigate to={auth === 'authed' ? '/' : '/login'} replace />} />
        <Route path="*" element={authed ? (role === 'admin' ? <AdminPage /> : <HomePage />) : <Navigate to={auth === 'blocked' ? '/pending' : '/login'} replace />} />
      </Routes>
    );
  }

  return (
    <>
      <Housekeeping />
      {body}
      <Toasts />
    </>
  );
}
