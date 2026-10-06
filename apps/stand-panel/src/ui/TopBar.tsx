import { useNavigate } from 'react-router-dom';
import { T } from '../lib/texts';
import { unlockAudio } from '../services/audio';
import { useStore } from '../store';
import { Button } from './kit';

function ConnChip() {
  const conn = useStore((s) => s.conn);
  const map = {
    connected: { icon: '●', text: T.bar.connected, cls: 'text-emerald-800 dark:text-emerald-300' },
    connecting: { icon: '○', text: T.bar.connecting, cls: 'text-slate-600 dark:text-slate-300' },
    disconnected: { icon: '▲', text: T.bar.disconnected, cls: 'text-red-800 dark:text-red-300' },
  }[conn];
  return (
    <span role="status" className={`inline-flex items-center gap-2 font-bold ${map.cls}`}>
      <span aria-hidden>{map.icon}</span>
      {map.text}
    </span>
  );
}

export function TopBar() {
  const navigate = useNavigate();
  const name = useStore((s) => s.me?.name ?? '');
  const unlocked = useStore((s) => s.audioUnlocked);
  const soundEnabled = useStore((s) => s.soundEnabled);
  const nearby = useStore((s) => s.nearby);

  const nearbyText = nearby === null ? T.bar.nearbyUnknown : nearby.drivers.length === 0 ? T.bar.nearbyNone : T.bar.nearby(nearby.drivers.length);
  const nearbyWarn = nearby !== null && nearby.drivers.length === 0;

  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-white px-4 py-2 shadow dark:bg-slate-800">
      <h1 className="text-2xl font-extrabold">{name || T.appName}</h1>
      <ConnChip />
      {soundEnabled && !unlocked && (
        <Button variant="primary" onClick={() => void unlockAudio()}>{T.bar.soundOn}</Button>
      )}
      <span className={`font-semibold ${nearbyWarn ? 'rounded bg-yellow-200 px-2 py-1 text-yellow-950' : ''}`}>
        {nearbyWarn && <span aria-hidden>{'▲ '}</span>}
        {nearbyText}
      </span>
      <Button className="ml-auto" onClick={() => navigate('/settings')}>{T.bar.settings}</Button>
    </header>
  );
}
