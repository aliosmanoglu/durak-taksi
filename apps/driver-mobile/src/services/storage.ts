// Kalıcı veri. Refresh token ve profil (telefon içerir) yalnızca `expo-secure-store`'da tutulur;
// access token yalnızca bellektedir, şifre hiçbir yerde saklanmaz (tasarım Bölüm 8).
import * as SecureStore from 'expo-secure-store';
import type { Profile } from '@/lib/store';

const KEYS = {
  refreshToken: 'dn.refreshToken',
  profile: 'dn.profile',
  wantsOnline: 'dn.wantsOnline',
  lastRoutineSentAt: 'dn.lastRoutineSentAt',
} as const;

const opts: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

async function get(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key, opts);
  } catch {
    return null;
  }
}

async function put(key: string, value: string | null): Promise<void> {
  try {
    if (value == null) await SecureStore.deleteItemAsync(key, opts);
    else await SecureStore.setItemAsync(key, value, opts);
  } catch {
    // Yazılamadıysa bir sonraki güncellemede tekrar denenir.
  }
}

export const storage = {
  getRefreshToken: () => get(KEYS.refreshToken),
  setRefreshToken: (t: string) => put(KEYS.refreshToken, t),

  async getProfile(): Promise<Profile | null> {
    const raw = await get(KEYS.profile);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Profile;
    } catch {
      return null;
    }
  },
  setProfile: (p: Profile) => put(KEYS.profile, JSON.stringify(p)),

  async getWantsOnline(): Promise<boolean> {
    return (await get(KEYS.wantsOnline)) === '1';
  },
  setWantsOnline: (v: boolean) => put(KEYS.wantsOnline, v ? '1' : '0'),

  async getLastRoutineSentAt(): Promise<number | null> {
    const n = Number(await get(KEYS.lastRoutineSentAt));
    return Number.isFinite(n) && n > 0 ? n : null;
  },
  setLastRoutineSentAt: (v: number | null) => put(KEYS.lastRoutineSentAt, v == null ? null : String(v)),

  async clearSession() {
    await Promise.all([
      put(KEYS.refreshToken, null),
      put(KEYS.profile, null),
      put(KEYS.wantsOnline, null),
      put(KEYS.lastRoutineSentAt, null),
    ]);
  },
};
