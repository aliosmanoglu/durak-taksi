import { describe, expect, it } from 'vitest';
import { AUTO_REACTIVATE_MAX_GAP_MS } from '../constants';
import { T } from '../texts';
import { initialPresence, onLocationSent, type PresenceState } from './state';
import {
  acceptPresenceVersion,
  beginGoOffline,
  checkGoOnlineReadiness,
  decideAfterDrop,
  needsSyncRequest,
  onAutoReactivateCheckFailed,
  onConnected,
  onDisconnected,
  onGoOfflineAck,
  onGoOnlineAck,
  onTrackingStartFailed,
  parseSessionSync,
  reconcileSync,
  syncWatchDelayMs,
  type Effect,
} from './transitions';

const NOW = 1_800_000_000_000;
const st = (p: Partial<PresenceState> = {}): PresenceState => ({
  ...initialPresence(),
  conn: 'connected',
  perm: 'background',
  gps: 'on',
  ...p,
});
const types = (effects: Effect[]) => effects.map((e) => e.type);

describe('presenceVersion (S2)', () => {
  it('küçük sürüm reddedilir, eşit ve büyük kabul edilir, sürümsüz kabul edilir', () => {
    expect(acceptPresenceVersion(10, 9)).toEqual({ accept: false, next: 10 });
    expect(acceptPresenceVersion(10, 10)).toEqual({ accept: true, next: 10 });
    expect(acceptPresenceVersion(10, 11)).toEqual({ accept: true, next: 11 });
    expect(acceptPresenceVersion(null, 5)).toEqual({ accept: true, next: 5 });
    expect(acceptPresenceVersion(10, undefined)).toEqual({ accept: true, next: 10 });
  });

  it('her yeni bağlantıda sıfırlanır', () => {
    const s = st({ presenceVersion: 50, conn: 'disconnected', disconnectedAt: NOW - 1000 });
    expect(onConnected(s, NOW).patch.presenceVersion).toBeNull();
  });

  it('4.5: elimdekinden küçük sürümlü session_sync yok sayılır', () => {
    const s = st({ server: 'available', presenceVersion: 100, wantsOnline: true, lastSentAt: NOW - 5000 });
    const r = reconcileSync(s, { driverStatus: 'offline', offlineReason: 'stale_heartbeat', presenceVersion: 99 }, NOW);
    expect(r.ignored).toBe(true);
    expect(r.patch).toEqual({});
    expect(r.effects).toEqual([]);
  });

  it('go_online ack\'inden sonra gelen eski offline sync istemciyi pasife çekmez', () => {
    let s = st({ server: 'offline', intent: 'goingOnline', goOnlineStep: 'ack', presenceVersion: 10 });
    s = { ...s, ...onGoOnlineAck(s, { ok: true, data: { status: 'available', presenceVersion: 12 } }, NOW, false).patch };
    expect(s.server).toBe('available');
    const late = reconcileSync(s, { driverStatus: 'offline', offlineReason: 'user', presenceVersion: 11 }, NOW);
    expect(late.ignored).toBe(true);
  });

  it('daha yeni sync geldiyse eski ack durumu değiştirmez', () => {
    const s = st({ server: 'offline', intent: 'goingOnline', presenceVersion: 20 });
    const r = onGoOnlineAck(s, { ok: true, data: { status: 'available', presenceVersion: 19 } }, NOW, false);
    expect(r.patch).toEqual({ intent: 'none', goOnlineStep: null });
    // Sunucu pasif diyor: (otomatik akışta hâlâ çalışan) konum görevi durdurulur.
    expect(r.effects).toEqual([{ type: 'stopTracking' }]);
    const avail = onGoOnlineAck({ ...s, server: 'available' }, { ok: true, data: { status: 'available', presenceVersion: 19 } }, NOW, false);
    expect(avail.effects).toEqual([]);
  });
});

describe('Faz 3: eşleşmiş yolculukla session_sync', () => {
  it('parseSessionSync activeRide varlığını işaretler', () => {
    expect(
      parseSessionSync({ driverStatus: 'offline', presenceVersion: 1, activeRide: { rideId: 'x' } })?.hasActiveRide,
    ).toBe(true);
    expect(parseSessionSync({ driverStatus: 'busy', presenceVersion: 1 })?.hasActiveRide).toBeUndefined();
  });

  it('offline + activeRide (çıkış/yeniden giriş): bildirim ve otomatik aktif olma yok, sessizce pasif', () => {
    // Soğuk açılış ve wantsOnline=true olsa bile, ya da yerelde aktifken bile.
    for (const server of ['unknown', 'available', 'busy'] as const) {
      const s = st({ server, wantsOnline: true, lastRoutineSentAt: NOW - 5000, lastSentAt: NOW - 5000 });
      const r = reconcileSync(
        s,
        { driverStatus: 'offline', offlineReason: 'stale_heartbeat', presenceVersion: 7, hasActiveRide: true },
        NOW,
      );
      expect(r.patch).toMatchObject({ server: 'offline', presenceVersion: 7 });
      expect(r.patch.notice).toBeUndefined();
      expect(r.patch.intent).toBeUndefined();
      expect(types(r.effects)).not.toContain('autoReactivate');
      expect(types(r.effects)).not.toContain('localNotify');
    }
  });

  it('offline + activeRide yokken eski kurallar sürer (otomatik aktif olma)', () => {
    const s = st({ server: 'available', wantsOnline: true, lastRoutineSentAt: NOW - 5000 });
    const r = reconcileSync(s, { driverStatus: 'offline', offlineReason: 'stale_heartbeat', presenceVersion: 7 }, NOW);
    expect(types(r.effects)).toContain('autoReactivate');
  });
});

describe('Faz 3: busy şoför ve konum görevi', () => {
  it('busy sync: izin/GPS varsa görev başlar; yoksa başlamaz (KONUM PAYLAŞ izin akışını yürütür)', () => {
    const ok = reconcileSync(st({ server: 'unknown' }), { driverStatus: 'busy', presenceVersion: 1 }, NOW);
    expect(types(ok.effects)).toEqual(['startTracking']);
    for (const p of [{ perm: 'undetermined' as const }, { perm: 'denied' as const }, { gps: 'off' as const }]) {
      const r = reconcileSync(st({ server: 'unknown', ...p }), { driverStatus: 'busy', presenceVersion: 1 }, NOW);
      expect(r.patch).toMatchObject({ server: 'busy', intent: 'none' });
      expect(r.effects).toEqual([]);
    }
  });

  it('busy iken konum görevi başlatılamazsa go_offline gönderilmez (INVALID_TRANSITION döngüsü olmasın)', () => {
    const r = onTrackingStartFailed(st({ server: 'busy' }));
    expect(r.patch).toEqual({});
    expect(types(r.effects)).toEqual(['toast']);
    expect(types(onTrackingStartFailed(st({ server: 'available' })).effects)).toContain('emitGoOffline');
  });
});

describe('bağlantı', () => {
  it('kopma anı ilk kopmada kaydedilir, tekrar kopmada korunur', () => {
    expect(onDisconnected(st(), NOW).patch.disconnectedAt).toBe(NOW);
    expect(onDisconnected(st({ disconnectedAt: NOW - 5000 }), NOW).patch.disconnectedAt).toBe(NOW - 5000);
  });
  it('≥ 15 sn kopukluktan sonra "Bağlantı geri geldi" bildirimi; daha kısada sessiz', () => {
    const long = onConnected(st({ conn: 'disconnected', disconnectedAt: NOW - 20_000 }), NOW);
    expect(long.effects).toContainEqual({ type: 'toast', text: T.conn.restored });
    const short = onConnected(st({ conn: 'disconnected', disconnectedAt: NOW - 3_000 }), NOW);
    expect(short.effects).toEqual([]);
    expect(short.patch).toMatchObject({ conn: 'connected', disconnectedAt: null, syncPending: true });
  });
});

describe('session_sync karşılaştırma tablosu (4.5)', () => {
  it('offline + yerelde offline/none → hiçbir şey', () => {
    const r = reconcileSync(st({ server: 'offline' }), { driverStatus: 'offline', offlineReason: 'user', presenceVersion: 1 }, NOW);
    expect(r.patch).toMatchObject({ server: 'offline' });
    expect(r.patch.notice).toBeUndefined();
    expect(r.effects).toEqual([]);
  });

  it.each(['offlinePending', 'goingOffline'] as const)('offline + intent=%s → intent none, bildirim yok', (intent) => {
    const r = reconcileSync(
      st({ server: 'available', intent, wantsOnline: false }),
      { driverStatus: 'offline', offlineReason: 'user', presenceVersion: 1 },
      NOW,
    );
    expect(r.patch).toMatchObject({ server: 'offline', intent: 'none' });
    expect(r.patch.notice).toBeUndefined();
    expect(types(r.effects)).not.toContain('autoReactivate');
  });

  it('offline + available + stale_heartbeat + wantsOnline + ≤ 10 dk → otomatik yeniden aktif olma', () => {
    const s = st({ server: 'available', wantsOnline: true, lastRoutineSentAt: NOW - 90_000, tracking: true });
    const r = reconcileSync(s, { driverStatus: 'offline', offlineReason: 'stale_heartbeat', presenceVersion: 1 }, NOW);
    expect(r.patch).toMatchObject({ server: 'offline', intent: 'reactivating', notice: null });
    expect(r.effects).toEqual([{ type: 'autoReactivate' }]);
    // Konum görevi durdurulmaz (arka planda yeniden başlatılamayabilir).
    expect(types(r.effects)).not.toContain('stopTracking');
  });

  it('offline + available + not_online → aynı otomatik akış', () => {
    const s = st({ server: 'available', wantsOnline: true, lastRoutineSentAt: NOW - 30_000 });
    const r = reconcileSync(s, { driverStatus: 'offline', offlineReason: 'not_online', presenceVersion: 1 }, NOW);
    expect(r.patch.intent).toBe('reactivating');
  });

  it('offline + available + stale_heartbeat + > 10 dk → otomatik yok, mavi "10 dakikadan uzun" kartı', () => {
    const s = st({ server: 'available', wantsOnline: true, lastRoutineSentAt: NOW - AUTO_REACTIVATE_MAX_GAP_MS - 1, tracking: true });
    const r = reconcileSync(s, { driverStatus: 'offline', offlineReason: 'stale_heartbeat', presenceVersion: 1 }, NOW);
    expect(r.patch).toMatchObject({ server: 'offline', notice: { kind: 'droppedLong' } });
    expect(r.patch.intent).toBeUndefined();
    expect(types(r.effects)).toEqual(['stopTracking', 'haptic', 'localNotify']);
  });

  it('tam 10 dk sınırı dahildir', () => {
    expect(
      decideAfterDrop({ reason: 'stale_heartbeat', wantsOnline: true, lastRoutineSentAt: NOW - AUTO_REACTIVATE_MAX_GAP_MS, autoReactivations: [], now: NOW }),
    ).toEqual({ kind: 'reactivate' });
  });

  it('offline + available + forced → otomatik yok, kart yok (oturum zaten sonlanır)', () => {
    const s = st({ server: 'available', wantsOnline: true, lastRoutineSentAt: NOW - 1000, tracking: true });
    const r = reconcileSync(s, { driverStatus: 'offline', offlineReason: 'forced', presenceVersion: 1 }, NOW);
    expect(r.patch.intent).toBeUndefined();
    expect(r.patch.notice).toBeUndefined();
    expect(r.effects).toEqual([{ type: 'stopTracking' }]);
  });

  it('offline + available + user (başka cihaz) → otomatik yok, "Pasife alındınız"', () => {
    const s = st({ server: 'available', wantsOnline: true, lastRoutineSentAt: NOW - 1000 });
    const r = reconcileSync(s, { driverStatus: 'offline', offlineReason: 'user', presenceVersion: 1 }, NOW);
    expect(r.patch.notice).toEqual({ kind: 'dropped' });
    expect(types(r.effects)).not.toContain('autoReactivate');
  });

  it('wantsOnline = false iken otomatik aktif olunmaz', () => {
    expect(decideAfterDrop({ reason: 'stale_heartbeat', wantsOnline: false, lastRoutineSentAt: NOW - 1000, autoReactivations: [], now: NOW })).toEqual({
      kind: 'notice',
      notice: { kind: 'dropped' },
    });
  });

  it('kopukken PASİF OL (offlinePending) → otomatik yok', () => {
    let s = st({ server: 'available', wantsOnline: true, conn: 'disconnected', disconnectedAt: NOW - 120_000, lastRoutineSentAt: NOW - 120_000 });
    s = { ...s, ...beginGoOffline(s, NOW).patch };
    expect(s).toMatchObject({ intent: 'offlinePending', wantsOnline: false });
    const r = reconcileSync(s, { driverStatus: 'offline', offlineReason: 'stale_heartbeat', presenceVersion: 1 }, NOW);
    expect(r.patch).toMatchObject({ intent: 'none', server: 'offline' });
    expect(types(r.effects)).not.toContain('autoReactivate');
  });

  it('hiç gönderim yoksa (lastRoutineSentAt null) otomatik yok', () => {
    expect(decideAfterDrop({ reason: 'not_online', wantsOnline: true, lastRoutineSentAt: null, autoReactivations: [], now: NOW }).kind).toBe('notice');
  });

  it('sebepsiz offline (eski sunucu) → otomatik yok', () => {
    expect(decideAfterDrop({ reason: undefined, wantsOnline: true, lastRoutineSentAt: NOW, autoReactivations: [], now: NOW })).toEqual({
      kind: 'notice',
      notice: { kind: 'dropped' },
    });
  });

  it('soğuk açılış (server unknown) + wantsOnline + ≤ 10 dk → otomatik; wantsOnline yoksa sessiz', () => {
    const cold = st({ server: 'unknown', wantsOnline: true, lastRoutineSentAt: NOW - 120_000 });
    expect(
      reconcileSync(cold, { driverStatus: 'offline', offlineReason: 'stale_heartbeat', presenceVersion: 1 }, NOW).patch.intent,
    ).toBe('reactivating');
    const coldPassive = st({ server: 'unknown', wantsOnline: false });
    const r = reconcileSync(coldPassive, { driverStatus: 'offline', offlineReason: 'not_online', presenceVersion: 1 }, NOW);
    expect(r.patch.notice).toBeUndefined();
    expect(r.effects).toEqual([]);
  });

  it('soğuk açılışta kalan konum görevi offline gelince durdurulur', () => {
    const r = reconcileSync(st({ server: 'unknown', tracking: true }), { driverStatus: 'offline', offlineReason: 'user', presenceVersion: 1 }, NOW);
    expect(r.effects).toEqual([{ type: 'stopTracking' }]);
  });

  it('available + intent offlinePending → driver_go_offline gönderilir', () => {
    const r = reconcileSync(st({ server: 'available', intent: 'offlinePending' }), { driverStatus: 'available', presenceVersion: 1 }, NOW);
    expect(r.patch).toMatchObject({ intent: 'goingOffline', server: 'available' });
    expect(r.effects).toEqual([{ type: 'emitGoOffline' }]);
  });

  it('available + yerelde available → konum görevi başlatılır/sürer ve hemen konum gönderilir', () => {
    const r = reconcileSync(st({ server: 'available', wantsOnline: true }), { driverStatus: 'available', presenceVersion: 1 }, NOW);
    expect(r.effects).toEqual([{ type: 'startTracking' }]);
    expect(r.patch.notice).toBeUndefined();
  });

  it.each(['offline', 'unknown'] as const)('available + yerelde %s + izin/GPS uygun → aktif göster, "Aktif durumdasınız"', (server) => {
    const r = reconcileSync(st({ server, perm: 'foreground' }), { driverStatus: 'available', presenceVersion: 1 }, NOW);
    expect(r.patch).toMatchObject({ server: 'available', wantsOnline: true, notice: { kind: 'stillActive' } });
    expect(r.effects).toEqual([{ type: 'startTracking' }]);
  });

  it.each([
    ['izin yok', { perm: 'denied' as const }],
    ['GPS kapalı', { gps: 'off' as const }],
  ])('available + yerelde offline + %s → driver_go_offline + "izin yok" bildirimi', (_n, p) => {
    const r = reconcileSync(st({ server: 'offline', ...p }), { driverStatus: 'available', presenceVersion: 1 }, NOW);
    expect(r.patch).toMatchObject({ intent: 'goingOffline', notice: { kind: 'forcedOfflineNoPerm' }, wantsOnline: false });
    expect(types(r.effects)).toContain('emitGoOffline');
  });

  it('busy + herhangi → B1, konum görevi çalışır', () => {
    for (const server of ['offline', 'available', 'unknown'] as const) {
      const r = reconcileSync(st({ server }), { driverStatus: 'busy', presenceVersion: 1 }, NOW);
      expect(r.patch).toMatchObject({ server: 'busy', intent: 'none' });
      expect(r.effects).toEqual([{ type: 'startTracking' }]);
    }
  });

  it('ack beklerken gelen sync durumu günceller ama akışı bozmaz', () => {
    const r = reconcileSync(st({ server: 'offline', intent: 'goingOnline' }), { driverStatus: 'offline', offlineReason: 'user', presenceVersion: 1 }, NOW);
    expect(r.patch).toMatchObject({ server: 'offline' });
    expect(r.patch.intent).toBeUndefined();
    expect(r.effects).toEqual([]);
  });
});

describe('otomatik yeniden aktif olma sonuçları (S4)', () => {
  const reactivating = st({ server: 'offline', intent: 'reactivating', wantsOnline: true, tracking: true });

  it('başarı → AKTİF + yeşil "Yeniden aktif oldunuz" kartı', () => {
    const r = onGoOnlineAck(reactivating, { ok: true, data: { status: 'available', presenceVersion: 5 } }, NOW, true);
    expect(r.patch).toMatchObject({ server: 'available', intent: 'none', notice: { kind: 'reactivated' }, wantsOnline: true });
    expect(types(r.effects)).toContain('startTracking');
  });

  it.each(['gps', 'perm', 'fix'] as const)('kontrol başarısız (%s) → PASİF + kırmızı kart, görev durur, arka planda yerel bildirim', (reason) => {
    const r = onAutoReactivateCheckFailed(reason);
    expect(r.patch).toMatchObject({ intent: 'none', notice: { kind: 'reactivateFailed', reason } });
    expect(types(r.effects)).toEqual(['stopTracking', 'haptic', 'localNotify']);
    expect(r.effects).toContainEqual({ type: 'localNotify', text: T.notif.dropped });
  });

  it('bağlantı yine koptuysa kart yok; sonraki bağlantıda kural tekrar uygulanır', () => {
    const r = onAutoReactivateCheckFailed('conn');
    expect(r.patch).toMatchObject({ intent: 'none', server: 'available' });
    expect(r.patch.notice).toBeUndefined();
    const s = { ...reactivating, ...r.patch, lastRoutineSentAt: NOW - 60_000 };
    const again = reconcileSync(s, { driverStatus: 'offline', offlineReason: 'stale_heartbeat', presenceVersion: 1 }, NOW);
    expect(again.patch.intent).toBe('reactivating');
  });

  it('sunucu hatası / zaman aşımı → kırmızı kart (sunucu)', () => {
    expect(onGoOnlineAck(reactivating, { ok: false, code: 'INTERNAL' }, NOW, true).patch.notice).toEqual({
      kind: 'reactivateFailed',
      reason: 'server',
    });
    const t = onGoOnlineAck(reactivating, { ok: false, timeout: true }, NOW, true);
    expect(t.patch.notice).toEqual({ kind: 'reactivateFailed', reason: 'server' });
    expect(types(t.effects)).toContain('requestSync');
  });
});

describe('aktif / pasif olma', () => {
  it('izin → GPS → bağlantı sırasıyla kontrol', () => {
    expect(checkGoOnlineReadiness({ perm: 'denied', gps: 'off', conn: 'disconnected' })).toEqual({ ok: false, reason: 'perm' });
    expect(checkGoOnlineReadiness({ perm: 'foreground', gps: 'off', conn: 'disconnected' })).toEqual({ ok: false, reason: 'gps' });
    expect(checkGoOnlineReadiness({ perm: 'foreground', gps: 'on', conn: 'disconnected' })).toEqual({ ok: false, reason: 'conn' });
    expect(checkGoOnlineReadiness({ perm: 'background', gps: 'unknown', conn: 'connected' })).toEqual({ ok: true });
  });

  it('go_online ack ok → konum görevi başlar, haptik, ekran okuyucu duyurusu', () => {
    const r = onGoOnlineAck(st({ server: 'offline', intent: 'goingOnline' }), { ok: true, data: { status: 'available', presenceVersion: 1 } }, NOW, false);
    expect(r.patch).toMatchObject({ server: 'available', intent: 'none', wantsOnline: true, notice: null });
    expect(r.effects).toEqual([
      { type: 'startTracking' },
      { type: 'haptic', kind: 'success' },
      { type: 'announce', text: T.home.a11yNowActive },
    ]);
  });

  it('go_online ack busy → B1', () => {
    const r = onGoOnlineAck(st({ intent: 'goingOnline' }), { ok: true, data: { status: 'busy', presenceVersion: 1 } }, NOW, false);
    expect(r.patch.server).toBe('busy');
  });

  it('go_online hataları (5. tablo)', () => {
    const s = st({ server: 'offline', intent: 'goingOnline' });
    expect(onGoOnlineAck(s, { ok: false, code: 'VALIDATION_ERROR' }, NOW, false).effects).toContainEqual({ type: 'toast', text: T.home.errNoFix });
    expect(onGoOnlineAck(s, { ok: false, code: 'INTERNAL' }, NOW, false).effects).toContainEqual({ type: 'toast', text: T.home.errGoOnlineFailed });
    const timeout = onGoOnlineAck(s, { ok: false, timeout: true }, NOW, false);
    expect(timeout.patch).toEqual({ intent: 'none', goOnlineStep: null });
    expect(timeout.effects).toContainEqual({ type: 'toast', text: T.home.errGoOnlineTimeout });
    expect(onGoOnlineAck(s, { ok: false, code: 'ACCOUNT_SUSPENDED' }, NOW, false).effects).toContainEqual({
      type: 'sessionEnd',
      reason: 'suspended',
    });
  });

  it('görev başlatılamazsa driver_go_offline gönderilir', () => {
    const r = onTrackingStartFailed(st({ server: 'available' }));
    expect(r.patch.intent).toBe('goingOffline');
    expect(types(r.effects)).toContain('emitGoOffline');
  });

  it('PASİF OL bağlıyken: önce görev durur, sonra go_offline', () => {
    const r = beginGoOffline(st({ server: 'available', wantsOnline: true }), NOW);
    expect(r.patch).toMatchObject({ intent: 'goingOffline', wantsOnline: false });
    expect(r.effects).toEqual([{ type: 'stopTracking' }, { type: 'emitGoOffline' }]);
  });

  it('go_offline ack: ok → D3; zaman aşımı/INTERNAL → offlinePending; INVALID_TRANSITION → görev geri açılır', () => {
    const s = st({ server: 'available', intent: 'goingOffline' });
    expect(onGoOfflineAck(s, { ok: true, data: { status: 'offline', presenceVersion: 3 } }, NOW).patch).toMatchObject({
      server: 'offline',
      intent: 'none',
      offlineReason: 'user',
    });
    expect(onGoOfflineAck(s, { ok: false, timeout: true }, NOW).patch).toEqual({ intent: 'offlinePending' });
    expect(onGoOfflineAck(s, { ok: false, code: 'INTERNAL' }, NOW).patch).toEqual({ intent: 'offlinePending' });
    const busy = onGoOfflineAck(s, { ok: false, code: 'INVALID_TRANSITION' }, NOW);
    expect(busy.effects).toContainEqual({ type: 'startTracking' });
    expect(busy.effects).toContainEqual({ type: 'toast', text: T.home.errOfflineBusy });
  });
});

describe('session_sync gövdesi', () => {
  it('sözleşmeye uyanı alır, bilinmeyen alanları atar', () => {
    expect(parseSessionSync({ driverStatus: 'offline', offlineReason: 'stale_heartbeat', presenceVersion: 7, openRequests: [] })).toEqual({
      driverStatus: 'offline',
      offlineReason: 'stale_heartbeat',
      presenceVersion: 7,
    });
    expect(parseSessionSync({ driverStatus: 'available', offlineReason: 'x' })).toEqual({ driverStatus: 'available' });
    expect(parseSessionSync({ driverStatus: 'flying' })).toBeNull();
    expect(parseSessionSync(null)).toBeNull();
  });
});

describe('kalite denetimi düzeltmeleri', () => {
  const drop = { driverStatus: 'offline', offlineReason: 'stale_heartbeat', presenceVersion: 1 } as const;

  it('otomatik aktif olma üst sınırı: 10 dk içinde 3 kez; 4. düşmede otomatik yok, "tekrar tekrar koptu" kartı', () => {
    const base = { reason: 'stale_heartbeat' as const, wantsOnline: true, lastRoutineSentAt: NOW - 5000, now: NOW };
    expect(decideAfterDrop({ ...base, autoReactivations: [NOW - 60_000, NOW - 30_000] })).toEqual({ kind: 'reactivate' });
    expect(decideAfterDrop({ ...base, autoReactivations: [NOW - 90_000, NOW - 60_000, NOW - 30_000] })).toEqual({
      kind: 'notice',
      notice: { kind: 'droppedRepeated' },
    });
    // Pencere dışındakiler sayılmaz.
    expect(
      decideAfterDrop({ ...base, autoReactivations: [NOW - AUTO_REACTIVATE_MAX_GAP_MS - 1, NOW - 60_000, NOW - 30_000] }),
    ).toEqual({ kind: 'reactivate' });
  });

  it('döngü senaryosu: sweeper her 10 sn düşürüyor → 3 otomatik aktif olmadan sonra durur', () => {
    let s = st({ server: 'available', wantsOnline: true, lastRoutineSentAt: NOW - 4000 });
    const kinds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const now = NOW + i * 10_000;
      const r = reconcileSync({ ...s, presenceVersion: null }, drop, now);
      kinds.push(r.patch.intent === 'reactivating' ? 'reactivate' : (r.patch.notice?.kind ?? 'none'));
      s = { ...s, ...r.patch };
      if (r.patch.intent === 'reactivating') {
        // Başarılı otomatik aktif olma + görevden normal gönderim.
        s = { ...s, ...onGoOnlineAck(s, { ok: true, data: { status: 'available', presenceVersion: i + 2 } }, now, true).patch };
        s = { ...s, ...onLocationSent(now + 4000, true) };
      } else break;
    }
    expect(kinds).toEqual(['reactivate', 'reactivate', 'reactivate', 'droppedRepeated']);
  });

  it('zorunlu ilk gönderim S4 ölçütünü yenilemez; normal gönderim yeniler', () => {
    expect(onLocationSent(NOW, false)).toEqual({ lastSentAt: NOW });
    expect(onLocationSent(NOW, true)).toEqual({ lastSentAt: NOW, lastRoutineSentAt: NOW });
    // Otomatik aktif olup yalnız zorunlu gönderim yapılmış, sonra 10 dk'dan uzun süre normal gönderim yok → otomatik yok.
    const s = st({ server: 'available', wantsOnline: true, lastRoutineSentAt: NOW - AUTO_REACTIVATE_MAX_GAP_MS - 1, lastSentAt: NOW - 1000 });
    expect(reconcileSync(s, drop, NOW).patch.notice).toEqual({ kind: 'droppedLong' });
  });

  it('otomatik aktif olma zamanı kaydedilir; elle AKTİF OL sayacı sıfırlar', () => {
    const r = reconcileSync(st({ server: 'available', wantsOnline: true, lastRoutineSentAt: NOW - 1000 }), drop, NOW);
    expect(r.patch.autoReactivations).toEqual([NOW]);
    const manual = onGoOnlineAck(
      st({ intent: 'goingOnline', autoReactivations: [NOW - 1000, NOW - 500, NOW - 100] }),
      { ok: true, data: { status: 'available', presenceVersion: 9 } },
      NOW,
      false,
    );
    expect(manual.patch.autoReactivations).toEqual([]);
    const auto = onGoOnlineAck(st({ intent: 'reactivating' }), { ok: true, data: { status: 'available', presenceVersion: 9 } }, NOW, true);
    expect(auto.patch.autoReactivations).toBeUndefined();
  });

  it('bağlıyken go_offline zaman aşımı / INTERNAL → offlinePending + hemen session_sync_request; kopukken istek yok', () => {
    const s = st({ server: 'available', intent: 'goingOffline' });
    expect(onGoOfflineAck(s, { ok: false, timeout: true }, NOW).effects).toEqual([{ type: 'requestSync' }]);
    expect(onGoOfflineAck(s, { ok: false, code: 'INTERNAL' }, NOW).effects).toEqual([{ type: 'requestSync' }]);
    expect(onGoOfflineAck({ ...s, conn: 'disconnected' }, { ok: false, timeout: true }, NOW).effects).toEqual([]);
    // Gelen sync 'available' → go_offline tekrar gönderilir; 'offline' → kilit kalkar.
    const pending = { ...s, intent: 'offlinePending' as const };
    expect(reconcileSync(pending, { driverStatus: 'available', presenceVersion: 2 }, NOW).effects).toEqual([{ type: 'emitGoOffline' }]);
    expect(reconcileSync(pending, { driverStatus: 'offline', offlineReason: 'user', presenceVersion: 2 }, NOW).patch.intent).toBe('none');
  });

  it('session_sync bekçisi: bağlıyken sync gelmediyse veya pasif isteği askıdaysa istenir; 5 sn, sonra 2→30 sn', () => {
    expect(needsSyncRequest({ conn: 'connected', syncPending: true, intent: 'none' })).toBe(true);
    expect(needsSyncRequest({ conn: 'connected', syncPending: false, intent: 'offlinePending' })).toBe(true);
    expect(needsSyncRequest({ conn: 'connected', syncPending: false, intent: 'none' })).toBe(false);
    expect(needsSyncRequest({ conn: 'disconnected', syncPending: true, intent: 'offlinePending' })).toBe(false);
    expect([0, 1, 2, 3, 10].map(syncWatchDelayMs)).toEqual([5000, 2000, 4000, 8000, 30000]);
  });

  it('görev başlatılamazsa arka planda yerel bildirim', () => {
    expect(onTrackingStartFailed(st({ server: 'available' })).effects).toContainEqual({ type: 'localNotify', text: T.notif.dropped });
    expect(onTrackingStartFailed(st({ server: 'available', conn: 'disconnected' })).effects).toContainEqual({
      type: 'localNotify',
      text: T.notif.dropped,
    });
  });
});
