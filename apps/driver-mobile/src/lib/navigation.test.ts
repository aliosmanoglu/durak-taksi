import { describe, expect, it, vi } from 'vitest';
import {
  decideNavigation,
  fallbackUrl,
  getInstalledNavApps,
  isNavAppId,
  navApps,
  openNavigation,
} from './navigation';

const P = { lat: 41.0082, lng: 28.9784 };

describe('Bölüm 7 URI şemaları', () => {
  it('Android: Google navigasyon modu, Yandex, fallback; Apple yok', () => {
    const apps = navApps('android');
    expect(apps.map((a) => a.id)).toEqual(['google', 'yandexnavi', 'yandexmaps']);
    expect(apps[0]!.url(P)).toBe('google.navigation:q=41.008200,28.978400&mode=d');
    expect(apps[1]!.url(P)).toBe('yandexnavi://build_route_on_map?lat_to=41.008200&lon_to=28.978400');
    expect(apps[2]!.url(P)).toBe('yandexmaps://maps.yandex.ru/?rtext=~41.008200,28.978400&rtt=auto');
  });

  it('iOS: comgooglemaps, Yandex, Apple Haritalar', () => {
    const apps = navApps('ios');
    expect(apps.map((a) => a.id)).toEqual(['google', 'yandexnavi', 'yandexmaps', 'apple']);
    expect(apps[0]!.url(P)).toBe('comgooglemaps://?daddr=41.008200,28.978400&directionsmode=driving');
    expect(apps[3]!.url(P)).toBe('maps://?daddr=41.008200,28.978400&dirflg=d');
  });

  it('fallback evrensel web bağlantısı', () => {
    expect(fallbackUrl(P)).toBe('https://www.google.com/maps/dir/?api=1&destination=41.008200,28.978400&travelmode=driving');
  });

  it('koordinatlar her zaman 6 haneli ve nokta ondalıklı (virgül yok)', () => {
    for (const platform of ['android', 'ios'] as const) {
      for (const a of navApps(platform)) {
        const u = a.url({ lat: 41, lng: -0.5 });
        expect(u).toContain('41.000000');
        expect(u).toContain('-0.500000');
      }
    }
    expect(fallbackUrl({ lat: 1.5, lng: 2.25 })).toContain('destination=1.500000,2.250000');
  });
});

describe('yüklü uygulamalar', () => {
  it('canOpenURL true dönenler listelenir; hata verenler yok sayılır', async () => {
    const canOpenURL = vi.fn(async (url: string) => {
      if (url.startsWith('yandexmaps')) throw new Error('x');
      return url.startsWith('google') || url.startsWith('yandexnavi');
    });
    const r = await getInstalledNavApps(P, 'android', { canOpenURL });
    expect(r.map((a) => a.id)).toEqual(['google', 'yandexnavi']);
  });
});

describe('seçim akışı', () => {
  const android = navApps('android');
  const [google, navi] = [android[0]!, android[1]!];

  it('0 yüklü → web fallback; 1 yüklü → doğrudan; birden fazla → seçtir', () => {
    expect(decideNavigation([], null)).toEqual({ kind: 'fallback' });
    expect(decideNavigation([google], null)).toEqual({ kind: 'open', app: google });
    const d = decideNavigation([google, navi], null);
    expect(d.kind).toBe('choose');
  });

  it('kayıtlı varsayılan yüklüyse seçtirmeden açılır; yüklü değilse yok sayılır', () => {
    expect(decideNavigation([google, navi], 'yandexnavi')).toEqual({ kind: 'open', app: navi });
    expect(decideNavigation([google, navi], 'apple').kind).toBe('choose');
    expect(decideNavigation([], 'google')).toEqual({ kind: 'fallback' });
  });

  it('isNavAppId yalnızca bilinen kimlikleri kabul eder', () => {
    expect(isNavAppId('google')).toBe(true);
    expect(isNavAppId('waze')).toBe(false);
    expect(isNavAppId(null)).toBe(false);
  });
});

describe('açma', () => {
  const app = navApps('android')[0]!;

  it('uygulama açılırsa fallback denenmez', async () => {
    const openURL = vi.fn(async () => {});
    expect(await openNavigation(P, app, { openURL })).toBe('app');
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith(app.url(P));
  });

  it('uygulama açılamazsa web fallback', async () => {
    const openURL = vi.fn(async (u: string) => {
      if (!u.startsWith('https')) throw new Error('açılamadı');
    });
    expect(await openNavigation(P, app, { openURL })).toBe('fallback');
    expect(openURL).toHaveBeenLastCalledWith(fallbackUrl(P));
  });

  it('uygulama verilmezse doğrudan fallback; o da açılmazsa failed', async () => {
    expect(await openNavigation(P, undefined, { openURL: async () => {} })).toBe('fallback');
    expect(await openNavigation(P, undefined, { openURL: async () => { throw new Error('x'); } })).toBe('failed');
  });
});
