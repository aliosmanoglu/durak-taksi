// `src/lib/navigation.ts` (Bölüm 7, tek modül) ile React Native `Linking` / `Platform` arasındaki bağ.
// Mantık lib'dedir; burada yalnızca cihaz bağımlılıkları verilir ve varsayılan seçim saklanır.
import { Linking, Platform } from 'react-native';
import type { LatLng } from '@duraknet/shared';
import {
  decideNavigation,
  getInstalledNavApps,
  openNavigation,
  type NavApp,
  type NavDecision,
  type NavOpenResult,
} from '@/lib/navigation';
import { cancelNavigationMark, markNavigationLaunched } from './lifecycle';
import { storage } from './storage';

const platform = () => (Platform.OS === 'ios' ? 'ios' : 'android');

/** Yüklü harita uygulamalarını bulur ve ne yapılacağına karar verir (doğrudan aç / seçtir / web). */
export async function planNavigation(pickup: LatLng): Promise<NavDecision> {
  const [installed, def] = await Promise.all([
    getInstalledNavApps(pickup, platform(), Linking),
    storage.getNavDefault(),
  ]);
  return decideNavigation(installed, def);
}

/** Seçilen uygulamayı (ya da hiçbiri verilmezse web fallback'i) açar. `makeDefault`: seçimi kaydeder. */
export async function launchNavigation(pickup: LatLng, app?: NavApp, makeDefault = false): Promise<NavOpenResult> {
  if (app && makeDefault) await storage.setNavDefault(app.id);
  // Dönüşte ride ekranı session_sync_request ile sunucudaki duruma göre geri yüklenir (lifecycle.ts).
  markNavigationLaunched();
  const res = await openNavigation(pickup, app, Linking);
  if (res === 'failed') cancelNavigationMark();
  return res;
}

export const resetNavDefault = () => storage.setNavDefault(null);
export const readNavDefault = () => storage.getNavDefault();
export const navPlatform = platform;
