import { describe, expect, it } from 'vitest';
import { T } from '../texts';
import { deriveChips, deriveHome, noticeView, pickBanner } from './home-view';
import { initialPresence, type PresenceState } from './state';

const NOW = 1_800_000_000_000;
const goodFix = { at: NOW - 2000, lat: 41, lng: 29, accuracy: 10 };
/** Her şeyi iyi, bağlı, aktif bir şoför. */
const active = (p: Partial<PresenceState> = {}): PresenceState => ({
  ...initialPresence(),
  conn: 'connected',
  server: 'available',
  perm: 'background',
  gps: 'on',
  fix: goodFix,
  lastSentAt: NOW - 3000,
  wantsOnline: true,
  ...p,
});
const passive = (p: Partial<PresenceState> = {}) => active({ server: 'offline', lastSentAt: null, wantsOnline: false, ...p });
const code = (s: PresenceState) => deriveHome(s, NOW).code;

describe('ana durum (3.2)', () => {
  it('A2: sunucu durumu bilinmiyor → Bağlanıyor, düğme devre dışı', () => {
    const v = deriveHome(active({ server: 'unknown', conn: 'connecting' }), NOW);
    expect(v.code).toBe('A2');
    expect(v.title).toBe(T.home.connecting);
    expect(v.button).toMatchObject({ enabled: false, style: 'disabled' });
  });

  it('A3: aktif olunuyor; fix adımında "Konum alınıyor…"', () => {
    expect(deriveHome(passive({ intent: 'goingOnline', goOnlineStep: 'fix' }), NOW).button?.label).toBe(T.home.gettingFix);
    const v = deriveHome(passive({ intent: 'goingOnline', goOnlineStep: 'ack' }), NOW);
    expect(v.code).toBe('A3');
    expect(v.button).toMatchObject({ label: T.home.goingOnline, style: 'wait', enabled: false });
  });

  it('R: otomatik yeniden aktif olunuyor', () => {
    const v = deriveHome(passive({ intent: 'reactivating' }), NOW);
    expect(v.code).toBe('R');
    expect(v.title).toBe(T.home.reactivating);
  });

  it('A4 / A5', () => {
    expect(code(active({ intent: 'goingOffline' }))).toBe('A4');
    const a5 = deriveHome(active({ intent: 'offlinePending', conn: 'disconnected', disconnectedAt: NOW - 1000 }), NOW);
    expect(a5.code).toBe('A5');
    expect(a5.button?.enabled).toBe(false);
  });

  it('B1: aktif iş → düğme yok', () => {
    const v = deriveHome(active({ server: 'busy' }), NOW);
    expect(v.code).toBe('B1');
    expect(v.button).toBeNull();
  });

  it('B1: YOLCULUKTASINIZ başlığı; yolculuk varken sunucu offline ise de AKTİF OL gösterilmez', () => {
    expect(deriveHome(active({ server: 'busy' }), NOW).title).toBe(T.home.busy);
    expect(T.home.busy).toBe('YOLCULUKTASINIZ');
    const v = deriveHome(passive(), NOW, { hasActiveRide: true });
    expect(v.code).toBe('B1');
    expect(v.button).toBeNull();
    // Yolculuk yoksa pasif ana ekran aynen kalır.
    expect(deriveHome(passive(), NOW, { hasActiveRide: false }).code).toBe('D3');
  });

  it('C1: ≥ 60 sn son konumdan beri kopuk → Durum bilinmiyor + yerel PASİF OL', () => {
    const v = deriveHome(active({ conn: 'disconnected', disconnectedAt: NOW - 50_000, lastSentAt: NOW - 61_000 }), NOW);
    expect(v.code).toBe('C1');
    expect(v.accent).toBe('red');
    expect(v.button).toMatchObject({ action: 'goOffline', enabled: true });
  });

  it('C2: 15–60 sn kopukluk → AKTİF + sarı uyarı; ilk 15 sn sessiz (C6)', () => {
    expect(code(active({ conn: 'disconnected', disconnectedAt: NOW - 20_000, lastSentAt: NOW - 24_000 }))).toBe('C2');
    expect(code(active({ conn: 'disconnected', disconnectedAt: NOW - 10_000, lastSentAt: NOW - 12_000 }))).toBe('C6');
  });

  it('C3: izin yok veya GPS kapalı', () => {
    expect(code(active({ gps: 'off' }))).toBe('C3');
    expect(code(active({ perm: 'denied' }))).toBe('C3');
  });

  it('C4: fix bayat veya son gönderim > 20 sn', () => {
    expect(code(active({ fix: { ...goodFix, at: NOW - 31_000 } }))).toBe('C4');
    expect(code(active({ lastSentAt: NOW - 21_000 }))).toBe('C4');
  });

  it('C5: zayıf fix veya yalnız ön plan izni', () => {
    expect(code(active({ fix: { ...goodFix, accuracy: 80 } }))).toBe('C5');
    expect(code(active({ perm: 'foreground' }))).toBe('C5');
  });

  it('C6: her şey iyi', () => {
    const v = deriveHome(active(), NOW);
    expect(v.code).toBe('C6');
    expect(v.title).toBe(T.home.active);
    expect(v.button).toMatchObject({ action: 'goOffline', label: T.home.goOffline, style: 'off' });
    expect(v.banner).toBeNull();
  });

  it('D1: kalıcı izin reddi → AYARLARI AÇ', () => {
    const v = deriveHome(passive({ perm: 'deniedForever' }), NOW);
    expect(v.code).toBe('D1');
    expect(v.button).toMatchObject({ action: 'openSettings', label: T.common.openSettings });
  });

  it('D2: bağlantı yok → AKTİF OL soluk ama dokunulabilir', () => {
    const v = deriveHome(passive({ conn: 'disconnected', disconnectedAt: NOW - 1000 }), NOW);
    expect(v.code).toBe('D2');
    expect(v.button).toMatchObject({ action: 'goOnline', style: 'disabled', enabled: true });
  });

  it('D3: pasif → AKTİF OL', () => {
    const v = deriveHome(passive(), NOW);
    expect(v.code).toBe('D3');
    expect(v.title).toBe(T.home.passive);
    expect(v.button).toMatchObject({ action: 'goOnline', style: 'on', enabled: true });
  });

  it('geçişten sonra düğme 1,5 sn kilitli', () => {
    expect(deriveHome(passive({ toggleLockedUntil: NOW + 500 }), NOW).button?.enabled).toBe(false);
    expect(deriveHome(active({ toggleLockedUntil: NOW - 1 }), NOW).button?.enabled).toBe(true);
  });
});

describe('uyarı şeridi önceliği (4.4)', () => {
  const p = (s: PresenceState) => pickBanner(s, NOW)?.priority ?? null;

  it('izin > GPS > uzun kopukluk > kopukluk > bayat konum > ön plan izni > zayıf konum', () => {
    const all = active({
      perm: 'denied',
      gps: 'off',
      conn: 'disconnected',
      disconnectedAt: NOW - 70_000,
      lastSentAt: NOW - 70_000,
      fix: { ...goodFix, accuracy: 80 },
    });
    expect(p(all)).toBe(1);
    expect(p({ ...all, perm: 'foreground' })).toBe(2);
    expect(p({ ...all, perm: 'foreground', gps: 'on' })).toBe(3);
    expect(p({ ...all, perm: 'foreground', gps: 'on', lastSentAt: NOW - 30_000, disconnectedAt: NOW - 20_000 })).toBe(4);
    expect(p(active({ perm: 'foreground', lastSentAt: NOW - 25_000 }))).toBe(5);
    expect(p(active({ perm: 'foreground', fix: { ...goodFix, accuracy: 80 } }))).toBe(6);
    expect(p(active({ fix: { ...goodFix, accuracy: 80 } }))).toBe(7);
    expect(p(active())).toBeNull();
  });

  it('kopukluk geri sayımı son gönderime göre; otomatik aktif olma alt satırı', () => {
    const b = pickBanner(active({ conn: 'disconnected', disconnectedAt: NOW - 20_000, lastSentAt: NOW - 24_000 }), NOW);
    expect(b).toMatchObject({ tone: 'yellow', text: T.warn.disconnected(36), sub: T.warn.autoReactivateHint });
    const red = pickBanner(active({ conn: 'disconnected', disconnectedAt: NOW - 60_000, lastSentAt: NOW - 65_000 }), NOW);
    expect(red).toMatchObject({ tone: 'red', text: T.warn.probablyOffline, sub: T.warn.autoReactivateHint });
  });

  it('GPS kapalı → KONUMU AÇ; yalnız ön plan → İZNİ DÜZELT', () => {
    expect(pickBanner(active({ gps: 'off' }), NOW)?.action).toEqual({ kind: 'enableGps', label: T.warn.gpsOn });
    expect(pickBanner(active({ perm: 'foreground' }), NOW)?.action?.kind).toBe('fixPermission');
  });

  it('pasifken yalnızca izin şeridi (1) gösterilir', () => {
    expect(pickBanner(passive({ gps: 'off' }), NOW)).toBeNull();
    expect(pickBanner(passive({ conn: 'disconnected', disconnectedAt: NOW - 90_000 }), NOW)).toBeNull();
    expect(pickBanner(passive({ perm: 'deniedForever' }), NOW)?.priority).toBe(1);
  });
});

describe('durum çipleri', () => {
  it('aktif ve iyi: Bağlı / Konum iyi / Gönderim', () => {
    expect(deriveChips(active(), NOW)).toEqual([
      { label: T.chip.connected, color: 'green' },
      { label: T.chip.locGood, color: 'green' },
      { label: T.chip.lastSentSec(3), color: 'muted' },
    ]);
  });
  it('kopuk ve uzun süredir gönderim yok → kırmızı', () => {
    const chips = deriveChips(active({ conn: 'disconnected', disconnectedAt: NOW - 70_000, lastSentAt: NOW - 70_000 }), NOW);
    expect(chips[0]).toEqual({ label: T.chip.disconnected, color: 'red' });
    expect(chips[2]).toEqual({ label: T.chip.lastSentMin(1), color: 'red' });
  });
  it('ilk 15 sn "Bağlanıyor…"; GPS kapalı; zayıf konum doğrulukla', () => {
    expect(deriveChips(active({ conn: 'disconnected', disconnectedAt: NOW - 5000 }), NOW)[0]?.label).toBe(T.chip.connecting);
    expect(deriveChips(active({ gps: 'off' }), NOW)[1]).toEqual({ label: T.chip.gpsOff, color: 'red' });
    expect(deriveChips(active({ fix: { ...goodFix, accuracy: 120.4 } }), NOW)[1]).toEqual({ label: T.chip.locPoor(120), color: 'yellow' });
  });
  it('pasifken gönderim çipi yok, eski konum "Konum yok" sayılmaz', () => {
    const chips = deriveChips(passive({ fix: { ...goodFix, at: NOW - 600_000 } }), NOW);
    expect(chips).toHaveLength(2);
    expect(chips[1]?.label).toBe(T.chip.locGood);
  });
});

describe('bildirim kartları', () => {
  it('tasarımdaki metinler', () => {
    expect(noticeView({ kind: 'reactivated' })).toEqual({ tone: 'green', title: 'Yeniden aktif oldunuz', text: T.sync.reactivated });
    expect(noticeView({ kind: 'reactivateFailed', reason: 'gps' }).text).toBe(
      'Bağlantı koptuğu için pasife düştünüz. GPS kapalı olduğu için otomatik aktif olunamadı. GPS’i açıp AKTİF OL’a basın.',
    );
    expect(noticeView({ kind: 'reactivateFailed', reason: 'server' }).text).toBe(
      'Bağlantı koptuğu için pasife düştünüz. Sunucu yanıt vermediği için otomatik aktif olunamadı. AKTİF OL’a basın.',
    );
    expect(noticeView({ kind: 'droppedLong' })).toMatchObject({ tone: 'blue', text: T.sync.droppedLong });
  });
});

describe('tekrar tekrar kopma kartı', () => {
  it('mavi, AKTİF OL çağrısıyla', () => {
    expect(noticeView({ kind: 'droppedRepeated' })).toEqual({
      tone: 'blue',
      title: 'Pasife alındınız',
      text: 'Bağlantı tekrar tekrar koptu. Çağrı almak için AKTİF OL’a basın.',
    });
  });
});
