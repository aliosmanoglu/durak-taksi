// Kalıcı veri. Refresh token ve profil (telefon içerir) yalnızca `expo-secure-store`'da tutulur;
// access token yalnızca bellektedir, şifre hiçbir yerde saklanmaz (tasarım Bölüm 8).
import * as SecureStore from 'expo-secure-store';
import { rideSnapshotSchema, type RideSnapshot } from '@duraknet/shared';
import { serializeActiveRide } from '@/lib/rides/persist';
import { isNavAppId, type NavAppId } from '@/lib/navigation';
import type { Profile } from '@/lib/store';

const KEYS = {
  refreshToken: 'dn.refreshToken',
  profile: 'dn.profile',
  wantsOnline: 'dn.wantsOnline',
  lastRoutineSentAt: 'dn.lastRoutineSentAt',
  activeRide: 'dn.activeRide',
  soundEnabled: 'dn.soundEnabled',
  navDefault: 'dn.navDefault',
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
    // Yazılamadıysa eski değer diskte kalmasın (bayat yolculuk soğuk açılışta dirilmesin): anahtar silinir.
    if (value != null) await SecureStore.deleteItemAsync(key, opts).catch(() => undefined);
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

  /**
   * Eşleşmiş yolculuğun son bilinen hâli (soğuk açılışta ağ yokken D2'yi soluk göstermek için). Hesaba bağlıdır:
   * çıkışta silinir. Gizlilik: ham konum değil, yalnızca alış noktası ve durak/şoför bilgisi içerir; loglanmaz.
   */
  async getActiveRide(): Promise<RideSnapshot | null> {
    const raw = await get(KEYS.activeRide);
    if (!raw) return null;
    try {
      const r = rideSnapshotSchema.safeParse(JSON.parse(raw));
      return r.success && r.data.status === 'matched' ? r.data : null;
    } catch {
      return null;
    }
  },
  setActiveRide: (r: RideSnapshot | null) => put(KEYS.activeRide, r ? serializeActiveRide(r) : null),

  /** Çağrı sesi tercihi (Q6): cihaz tercihi; çıkışta silinmez. Varsayılan açık. */
  async getSoundEnabled(): Promise<boolean> {
    return (await get(KEYS.soundEnabled)) !== '0';
  },
  setSoundEnabled: (v: boolean) => put(KEYS.soundEnabled, v ? '1' : '0'),

  /** "Varsayılan yap" ile seçilen harita uygulaması (Bölüm 7): cihaz tercihi; çıkışta silinmez. */
  async getNavDefault(): Promise<NavAppId | null> {
    const v = await get(KEYS.navDefault);
    return isNavAppId(v) ? v : null;
  },
  setNavDefault: (v: NavAppId | null) => put(KEYS.navDefault, v),

  async clearSession() {
    await Promise.all([
      put(KEYS.activeRide, null),
      put(KEYS.refreshToken, null),
      put(KEYS.profile, null),
      put(KEYS.wantsOnline, null),
      put(KEYS.lastRoutineSentAt, null),
    ]);
  },
};
