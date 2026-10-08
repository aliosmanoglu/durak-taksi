// Harici navigasyon (CLAUDE.md Bölüm 7): uygulama içinde rota çizilmez. Alış koordinatı cihazdaki harita
// uygulamasına deep-link ile verilir. Tüm navigasyon mantığı bu tek modülden geçer.
//
// Bu dosya React Native'e bağımlı değildir: `Linking` ve platform dışarıdan verilir (`src/services/navigation.ts`
// bağlar), böylece saf mantık vitest ile test edilir.
import type { LatLng } from '@duraknet/shared';

export type NavPlatform = 'android' | 'ios';
export type NavAppId = 'google' | 'yandexnavi' | 'yandexmaps' | 'apple';
export type NavApp = { id: NavAppId; label: string; url: (p: LatLng) => string };

/** Koordinatlar her zaman nokta ondalık ayraçla yazılır (cihaz dili Türkçe olsa bile virgül yok). */
const c = (n: number) => n.toFixed(6);

/** Bölüm 7 URI şemaları. iOS'ta `maps` sistem şemasıdır (LSApplicationQueriesSchemes gerekmez). */
export function navApps(platform: NavPlatform): NavApp[] {
  const google: NavApp =
    platform === 'android'
      ? { id: 'google', label: 'Google Maps', url: (p) => `google.navigation:q=${c(p.lat)},${c(p.lng)}&mode=d` }
      : { id: 'google', label: 'Google Maps', url: (p) => `comgooglemaps://?daddr=${c(p.lat)},${c(p.lng)}&directionsmode=driving` };
  const apps: NavApp[] = [
    google,
    {
      id: 'yandexnavi',
      label: 'Yandex Navigasyon',
      url: (p) => `yandexnavi://build_route_on_map?lat_to=${c(p.lat)}&lon_to=${c(p.lng)}`,
    },
    {
      id: 'yandexmaps',
      label: 'Yandex Haritalar',
      url: (p) => `yandexmaps://maps.yandex.ru/?rtext=~${c(p.lat)},${c(p.lng)}&rtt=auto`,
    },
  ];
  if (platform === 'ios') {
    apps.push({ id: 'apple', label: 'Apple Haritalar', url: (p) => `maps://?daddr=${c(p.lat)},${c(p.lng)}&dirflg=d` });
  }
  return apps;
}

/** Evrensel web bağlantısı: hiçbir harita uygulaması yüklü değilse (veya açılamazsa) kullanılır. */
export const fallbackUrl = (p: LatLng) =>
  `https://www.google.com/maps/dir/?api=1&destination=${c(p.lat)},${c(p.lng)}&travelmode=driving`;

export type LinkingLike = {
  canOpenURL(url: string): Promise<boolean>;
  openURL(url: string): Promise<unknown>;
};

/** Yüklü (açılabilir) harita uygulamaları. `canOpenURL` hata verirse o uygulama yok sayılır. */
export async function getInstalledNavApps(p: LatLng, platform: NavPlatform, linking: Pick<LinkingLike, 'canOpenURL'>): Promise<NavApp[]> {
  const apps = navApps(platform);
  const checks = await Promise.all(apps.map((a) => linking.canOpenURL(a.url(p)).catch(() => false)));
  return apps.filter((_, i) => checks[i]);
}

export type NavOpenResult = 'app' | 'fallback' | 'failed';

/** Seçilen uygulamayı açar; açılamazsa web fallback'i dener. Fallback da açılamazsa `failed`. */
export async function openNavigation(p: LatLng, app: NavApp | undefined, linking: Pick<LinkingLike, 'openURL'>): Promise<NavOpenResult> {
  if (app) {
    try {
      await linking.openURL(app.url(p));
      return 'app';
    } catch {
      // uygulama açılamadı → fallback
    }
  }
  try {
    await linking.openURL(fallbackUrl(p));
    return 'fallback';
  } catch {
    return 'failed';
  }
}

/**
 * Seçim akışı: kayıtlı varsayılan yüklüyse doğrudan açılır; 0 yüklü → web fallback; 1 yüklü → doğrudan;
 * birden fazla → kullanıcıya seçtirilir (Action Sheet / seçim penceresi).
 */
export type NavDecision =
  | { kind: 'fallback' }
  | { kind: 'open'; app: NavApp }
  | { kind: 'choose'; apps: NavApp[] };

export function decideNavigation(installed: readonly NavApp[], defaultId: string | null): NavDecision {
  const preferred = defaultId ? installed.find((a) => a.id === defaultId) : undefined;
  if (preferred) return { kind: 'open', app: preferred };
  if (installed.length === 0) return { kind: 'fallback' };
  if (installed.length === 1) return { kind: 'open', app: installed[0]! };
  return { kind: 'choose', apps: [...installed] };
}

/** Kayıtlı varsayılan kimliği geçerli mi (bilinmeyen değer yok sayılır). */
export const isNavAppId = (v: unknown): v is NavAppId =>
  v === 'google' || v === 'yandexnavi' || v === 'yandexmaps' || v === 'apple';

/** Kayıtlı varsayılanın ekranda gösterilecek adı (Hesap > Harita uygulaması); yoksa/bu platformda yoksa `null`. */
export function navAppLabel(id: NavAppId | null, platform: NavPlatform): string | null {
  if (!id) return null;
  return navApps(platform).find((a) => a.id === id)?.label ?? null;
}
