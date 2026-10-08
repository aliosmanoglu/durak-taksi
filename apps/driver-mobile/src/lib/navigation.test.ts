import { describe, expect, it, vi } from 'vitest';
import {
  decideNavigation,
  fallbackUrl,
  getInstalledNavApps,
  isNavAppId,
  navAppLabel,
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

describe('web fallback koruması (uçtan uca akış)', () => {
  async function run(canOpenURL: (u: string) => Promise<boolean>, platform: 'android' | 'ios', savedDefault: string | null = null) {
    const opened: string[] = [];
    const installed = await getInstalledNavApps(P, platform, { canOpenURL });
    const decision = decideNavigation(installed, savedDefault);
    const app = decision.kind === 'open' ? decision.app : undefined;
    const result = await openNavigation(P, app, { openURL: async (u) => void opened.push(u) });
    return { decision, result, opened };
  }

  it('canOpenURL hepsi false → web fallback açılır (Android ve iOS)', async () => {
    for (const platform of ['android', 'ios'] as const) {
      const r = await run(async () => false, platform);
      expect(r.decision).toEqual({ kind: 'fallback' });
      expect(r.result).toBe('fallback');
      expect(r.opened).toEqual([fallbackUrl(P)]);
    }
  });

  it('canOpenURL hepsi hata verirse de web fallback açılır', async () => {
    const r = await run(async () => { throw new Error('izin yok'); }, 'ios');
    expect(r.decision).toEqual({ kind: 'fallback' });
    expect(r.opened).toEqual([fallbackUrl(P)]);
  });

  it('kayıtlı varsayılan artık yüklü değilse (silinmiş) fallback; yüklüyse doğrudan app', async () => {
    const none = await run(async () => false, 'android', 'yandexnavi');
    expect(none.opened).toEqual([fallbackUrl(P)]);
    const has = await run(async (u) => u.startsWith('yandexnavi') || u.startsWith('google'), 'android', 'yandexnavi');
    expect(has.result).toBe('app');
    expect(has.opened[0]).toMatch(/^yandexnavi:/);
  });
});

describe('varsayılan tercih etiketi', () => {
  it('kayıtlı kimliğin etiketini verir; bilinmeyen/yüklü olmayan platformda null', () => {
    expect(navAppLabel('yandexnavi', 'android')).toBe('Yandex Navigasyon');
    expect(navAppLabel('apple', 'ios')).toBe('Apple Haritalar');
    expect(navAppLabel('apple', 'android')).toBeNull();
    expect(navAppLabel(null, 'ios')).toBeNull();
  });
});
