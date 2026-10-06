// localStorage sarmalayıcıları (Q11: refresh token localStorage'da; kiosk tek amaçlı). Hata yutulur:
// gizli mod / kota dolu durumunda panel yine çalışır, yalnızca kalıcılık kaybolur.
import { parseRecent, type RecentAddress } from '../lib/recent-addresses';
import type { Me } from './types';

const K = {
  refresh: 'dn.refreshToken',
  me: 'dn.me',
  recent: 'dn.recentAddresses',
  sound: 'dn.soundEnabled',
} as const;

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* kalıcılık yok */
  }
}
function del(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* yok say */
  }
}

export const getRefreshToken = () => get(K.refresh);
export const setRefreshToken = (t: string) => set(K.refresh, t);

export function loadMe(): Me | null {
  const raw = get(K.me);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Me;
    return m && m.role === 'stand' && typeof m.name === 'string' && typeof m.location?.lat === 'number' ? m : null;
  } catch {
    return null;
  }
}
export const saveMe = (m: Me) => set(K.me, JSON.stringify(m));

export function loadRecent(): RecentAddress[] {
  const raw = get(K.recent);
  if (!raw) return [];
  try {
    return parseRecent(JSON.parse(raw));
  } catch {
    return [];
  }
}
export const saveRecent = (l: readonly RecentAddress[]) => set(K.recent, JSON.stringify(l));

export const loadSoundEnabled = (): boolean => get(K.sound) !== '0';
export const saveSoundEnabled = (v: boolean) => set(K.sound, v ? '1' : '0');

/** Çıkışta oturuma bağlı her şeyi siler (ses tercihi kalır; son adresler aynı cihazda kalır). */
export function clearSession(): void {
  del(K.refresh);
  del(K.me);
}
