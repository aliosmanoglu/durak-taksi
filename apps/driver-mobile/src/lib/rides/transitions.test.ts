import { describe, expect, it } from 'vitest';
import type { RideRequest, RideSnapshot } from '@duraknet/shared';
import { ACTION_LOCK_MS, DECLINE_UNDO_MS, MAX_TRACKED_RIDE_VERSIONS, TAKEN_CARD_MS } from '../constants';
import { initialPresence } from '../presence/state';
import { T } from '../texts';
import { initialRides, type OpenRequest } from './state';
import {
  applyRideSync,
  beginAccept,
  beginComplete,
  beginDecline,
  beginDriverCancel,
  clearRequests,
  expireTaken,
  flushDecline,
  focusRequest,
  isStale,
  markFocusedSeen,
  noteVersion,
  onAcceptAck,
  onCompleteAck,
  onDeclineAck,
  onDriverCancelAck,
  onRideAccepted,
  onRideCancelled,
  onRideCompleted,
  onRideRequested,
  onRideTaken,
  undoDecline,
  type RideCtx,
  type RideEffect,
  type RideStep,
} from './transitions';

const NOW = 1_800_000_000_000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);
const C = uuid(3);

const req = (id: string, distanceM: number, p: Partial<RideRequest> = {}): RideRequest => ({
  rideId: id,
  shortCode: `K${id.slice(-3)}`,
  pickup: { lat: 41, lng: 29 },
  pickupAddress: `Adres ${id.slice(-2)}`,
  standName: 'Kadıköy Durağı',
  distanceM,
  createdAt: new Date(NOW - 60_000).toISOString(),
  version: 1,
  serverNow: new Date(NOW).toISOString(),
  ...p,
});

const snap = (id: string, p: Partial<RideSnapshot> = {}): RideSnapshot => ({
  rideId: id,
  shortCode: 'K7M2QX',
  status: 'matched',
  version: 3,
  stand: { id: uuid(90), name: 'Kadıköy Durağı', phone: '+902161234567', location: { lat: 41, lng: 29 } },
  pickup: { lat: 41.0082, lng: 28.9784 },
  pickupAddress: 'Moda Cd. 12',
  createdAt: new Date(NOW - 120_000).toISOString(),
  matchedAt: new Date(NOW - 1000).toISOString(),
  ...p,
});

const ctx = (p: Partial<RideCtx> = {}): RideCtx => ({
  ...initialRides(),
  ...initialPresence(),
  conn: 'connected',
  server: 'available',
  syncPending: false,
  ...p,
});

/** Yamayı bağlama uygular (servis katmanının store.setState'i). */
const apply = (s: RideCtx, step: RideStep): RideCtx => ({ ...s, ...step.patch }) as RideCtx;
const types = (e: RideEffect[]) => e.map((x) => x.type);
const rid = (list: OpenRequest[]) => list.map((r) => r.rideId);

describe('version kapısı', () => {
  it('noteVersion yalnızca artar; isStale düşük sürümü yakalar, eşiti kabul eder', () => {
    let v = noteVersion({}, A, 5);
    expect(noteVersion(v, A, 3)).toBe(v);
    v = noteVersion(v, A, 7);
    expect(v[A]).toBe(7);
    expect(isStale(v, A, 6)).toBe(true);
    expect(isStale(v, A, 7)).toBe(false);
    expect(isStale(v, B, 0)).toBe(false);
  });

  it('tablo büyürse en eskiler atılır', () => {
    let v: Record<string, number> = {};
    for (let i = 0; i < MAX_TRACKED_RIDE_VERSIONS + 20; i++) v = noteVersion(v, uuid(1000 + i), 1);
    expect(Object.keys(v)).toHaveLength(MAX_TRACKED_RIDE_VERSIONS);
    expect(v[uuid(1000)]).toBeUndefined();
    expect(v[uuid(1000 + MAX_TRACKED_RIDE_VERSIONS + 19)]).toBe(1);
  });
});

describe('ride_requested (4.3, 4.4, 4.9)', () => {
  it('ilk çağrı: listeye girer, odaklanır, YENİ, 3 tekrarlı çağrı sesi, kilit', () => {
    const r = onRideRequested(ctx(), req(A, 1200), NOW);
    expect(rid(r.patch.requests!)).toEqual([A]);
    expect(r.patch.focusedId).toBe(A);
    expect(r.patch.unseen).toEqual([A]);
    expect(r.patch.actionLockedUntil).toBe(NOW + ACTION_LOCK_MS);
    expect(r.effects).toContainEqual({ type: 'ring', kind: 'first' });
  });

  it('ek çağrı: tek bip; odak SIÇRAMAZ (daha yakın olsa bile); mesafeye göre sıralanır', () => {
    let s = apply(ctx(), onRideRequested(ctx(), req(A, 3000), NOW));
    const r = onRideRequested(s, req(B, 500), NOW + 1000);
    s = apply(s, r);
    expect(rid(s.requests)).toEqual([B, A]);
    expect(s.focusedId).toBe(A);
    expect(r.effects).toContainEqual({ type: 'ring', kind: 'extra' });
    expect(s.unseen).toEqual([A, B]);
  });

  it('eşleşmişken veya aynı çağrının reddi beklerken gösterilmez', () => {
    expect(onRideRequested(ctx({ activeRide: snap(A) }), req(B, 100), NOW).patch).toEqual({});
    const s = ctx({ pendingDecline: { request: req(A, 100), sendAt: NOW + 4000 } });
    expect(onRideRequested(s, req(A, 100), NOW).patch).toEqual({});
  });

  it('eski sürümlü yinelenen çağrı yok sayılır; yüksek sürüm günceller, ses/rozet tekrarlanmaz', () => {
    let s = apply(ctx(), onRideRequested(ctx(), req(A, 1000, { version: 5 }), NOW));
    expect(onRideRequested(s, req(A, 1000, { version: 4 }), NOW).patch).toEqual({});
    const r = onRideRequested(s, req(A, 900, { version: 6, pickupAddress: 'Yeni adres' }), NOW);
    s = apply(s, r);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.pickupAddress).toBe('Yeni adres');
    expect(s.rideVersions[A]).toBe(6);
    expect(r.effects).toEqual([]);
    expect(s.unseen).toEqual([A]);
  });

  it('serverNow ile cihaz saati farkı kaydedilir (E-6)', () => {
    const r = onRideRequested(ctx(), req(A, 100, { serverNow: new Date(NOW + 120_000).toISOString() }), NOW);
    expect(r.patch.clockOffsetMs).toBe(120_000);
  });
});

describe('ride_taken', () => {
  const two = () => {
    let s = apply(ctx(), onRideRequested(ctx(), req(A, 500), NOW));
    s = apply(s, onRideRequested(s, req(B, 900), NOW));
    return { ...s, actionLockedUntil: 0 } as RideCtx;
  };

  it('odaklı çağrı kapanırsa odak en yakına geçer, 700 ms kilit, sessizleşir, 3 sn bildirim', () => {
    const s = two();
    const r = onRideTaken(s, A, NOW + 5000);
    const n = apply(s, r);
    expect(rid(n.requests)).toEqual([B]);
    expect(n.focusedId).toBe(B);
    expect(n.actionLockedUntil).toBe(NOW + 5000 + ACTION_LOCK_MS);
    expect(r.effects).toContainEqual({ type: 'stopRing' });
    expect(r.effects).toContainEqual({ type: 'toast', text: T.ride.req.closedToast, ms: 3000 });
  });

  it('odak dışı çağrı kapanırsa odak ve kilit değişmez', () => {
    const s = two();
    const n = apply(s, onRideTaken(s, B, NOW + 5000));
    expect(n.focusedId).toBe(A);
    expect(n.actionLockedUntil).toBe(0);
  });

  it('son çağrı kapanınca liste boşalır, odak null (D1 kendiliğinden kapanır)', () => {
    let s = apply(ctx(), onRideRequested(ctx(), req(A, 500), NOW));
    s = apply(s, onRideTaken(s, A, NOW + 1));
    expect(s.requests).toEqual([]);
    expect(s.focusedId).toBeNull();
  });

  it('kabul bekleyen çağrıda ack belirler: event yok sayılır', () => {
    const s = { ...two(), accepting: { rideId: A, timedOut: false } } as RideCtx;
    expect(onRideTaken(s, A, NOW).patch).toEqual({});
  });

  it('kabulüm sürerken diğer çağrılarım kapanırsa sessizce kalkar (bildirim yok)', () => {
    const s = { ...two(), accepting: { rideId: A, timedOut: false } } as RideCtx;
    const r = onRideTaken(s, B, NOW);
    expect(rid(r.patch.requests!)).toEqual([A]);
    expect(types(r.effects)).toEqual([]);
  });

  it('reddi beklerken kapanırsa ret gönderilmez ve GERİ AL şeridi kalkar', () => {
    let s = two();
    s = apply(s, beginDecline(s, A, NOW + 5000));
    const r = onRideTaken(s, A, NOW + 6000);
    expect(r.patch.pendingDecline).toBeNull();
    expect(types(r.effects)).toEqual(['cancelDeclineFlush']);
  });

  it('bilinmeyen ride için hiçbir şey yapmaz', () => {
    expect(onRideTaken(two(), C, NOW)).toEqual({ patch: {}, effects: [] });
  });
});

describe('odak ve YENİ rozeti', () => {
  it('liste dokunuşu odağı değiştirir, rozet kalkar, 700 ms kilit', () => {
    let s = apply(ctx(), onRideRequested(ctx(), req(A, 500), NOW));
    s = apply(s, onRideRequested(s, req(B, 900), NOW));
    const r = focusRequest(s, B, NOW + 9000);
    expect(r.patch.focusedId).toBe(B);
    expect(r.patch.unseen).toEqual([A]);
    expect(r.patch.actionLockedUntil).toBe(NOW + 9000 + ACTION_LOCK_MS);
  });

  it('kabul sürerken odak değişmez', () => {
    let s = apply(ctx(), onRideRequested(ctx(), req(A, 500), NOW));
    s = apply(s, onRideRequested(s, req(B, 900), NOW));
    expect(focusRequest({ ...s, accepting: { rideId: A, timedOut: false } } as RideCtx, B, NOW).patch).toEqual({});
  });

  it('markFocusedSeen odaklı çağrının rozetini kaldırır', () => {
    const s = apply(ctx(), onRideRequested(ctx(), req(A, 500), NOW));
    expect(markFocusedSeen(s).patch.unseen).toEqual([]);
    expect(markFocusedSeen(apply(s, markFocusedSeen(s))).patch).toEqual({});
  });
});

describe('KABUL (4.3)', () => {
  const withReq = (p: Partial<RideCtx> = {}) => {
    const s = apply(ctx(p), onRideRequested(ctx(p), req(A, 500), NOW));
    return { ...s, actionLockedUntil: 0 } as RideCtx;
  };

  it('kilitliyken, bağlantı yokken veya zaten kabul sürerken gönderilmez', () => {
    const s = withReq();
    expect(beginAccept({ ...s, actionLockedUntil: NOW + 500 } as RideCtx, A, NOW).effects).toEqual([]);
    expect(beginAccept({ ...s, accepting: { rideId: A, timedOut: false } } as RideCtx, A, NOW).effects).toEqual([]);
    const off = beginAccept({ ...s, conn: 'disconnected' } as RideCtx, A, NOW);
    expect(off.patch).toEqual({});
    expect(off.effects).toEqual([{ type: 'toast', text: T.ride.req.offline }]);
  });

  it('başlar: accepting, ses susar, ride_accept gider', () => {
    const r = beginAccept(withReq(), A, NOW);
    expect(r.patch.accepting).toEqual({ rideId: A, timedOut: false });
    expect(r.effects).toEqual([{ type: 'stopRing' }, { type: 'emitAccept', rideId: A }]);
  });

  it('ack ok: yolculuk benimsenir, liste temizlenir, şoför busy, haptik, diske yazılır', () => {
    let s = withReq();
    s = apply(s, onRideRequested(s, req(B, 900), NOW));
    s = apply(s, beginAccept(s, A, NOW));
    const ride = snap(A);
    const r = onAcceptAck(s, A, { kind: 'ok', ride }, NOW);
    expect(r.patch).toMatchObject({
      activeRide: ride,
      requests: [],
      focusedId: null,
      unseen: [],
      accepting: null,
      pendingDecline: null,
      server: 'busy',
      closed: null,
    });
    expect(r.patch.rideVersions![A]).toBe(3);
    expect(r.effects).toContainEqual({ type: 'haptic', kind: 'success' });
    expect(r.effects).toContainEqual({ type: 'persistActiveRide', ride });
  });

  it('RIDE_NOT_AVAILABLE: hata değil; kart "başka şoföre gitti" olur, 3 sn sonra kalkar, haptik warning', () => {
    let s = withReq();
    s = apply(s, beginAccept(s, A, NOW));
    const r = onAcceptAck(s, A, { kind: 'error', code: 'RIDE_NOT_AVAILABLE' }, NOW);
    s = apply(s, r);
    expect(s.accepting).toBeNull();
    expect(s.requests[0]).toMatchObject({ rideId: A, taken: true });
    expect(r.effects).toContainEqual({ type: 'haptic', kind: 'warning' });
    expect(r.effects).toContainEqual({ type: 'scheduleTakenRemoval', rideId: A, delayMs: TAKEN_CARD_MS });
    // taken kart KABUL/REDDET'e kapalıdır
    expect(beginAccept(s, A, NOW + 10_000).effects).toEqual([]);
    expect(beginDecline(s, A, NOW + 10_000).effects).toEqual([]);
    // süre dolunca kalkar
    const gone = apply(s, expireTaken(s, A, NOW + 3000));
    expect(gone.requests).toEqual([]);
    expect(gone.focusedId).toBeNull();
  });

  it('NOT_A_CANDIDATE aynı metne düşer', () => {
    let s = withReq();
    s = apply(s, beginAccept(s, A, NOW));
    expect(apply(s, onAcceptAck(s, A, { kind: 'error', code: 'NOT_A_CANDIDATE' }, NOW)).requests[0]!.taken).toBe(true);
  });

  it('DRIVER_NOT_AVAILABLE: bildirim + session_sync_request', () => {
    const s = apply(withReq(), beginAccept(withReq(), A, NOW));
    const r = onAcceptAck(s, A, { kind: 'error', code: 'DRIVER_NOT_AVAILABLE' }, NOW);
    expect(r.patch.accepting).toBeNull();
    expect(r.effects).toEqual([{ type: 'toast', text: T.ride.req.notAvailable }, { type: 'requestSync' }]);
  });

  it('oturum bitiren kodlar sessionEnd üretir; INTERNAL düğmeleri yeniden açar', () => {
    const s = apply(withReq(), beginAccept(withReq(), A, NOW));
    expect(onAcceptAck(s, A, { kind: 'error', code: 'ACCOUNT_SUSPENDED' }, NOW).effects).toEqual([
      { type: 'sessionEnd', reason: 'suspended' },
    ]);
    const e = onAcceptAck(s, A, { kind: 'error', code: 'INTERNAL' }, NOW);
    expect(e.patch.accepting).toBeNull();
    expect(e.effects).toEqual([{ type: 'toast', text: T.ride.req.errInternal }]);
  });

  it('zaman aşımı: yeniden kabul denenmez, hemen session_sync_request', () => {
    let s = apply(withReq(), beginAccept(withReq(), A, NOW));
    const r = onAcceptAck(s, A, { kind: 'timeout' }, NOW);
    s = apply(s, r);
    expect(s.accepting).toEqual({ rideId: A, timedOut: true });
    expect(r.effects).toEqual([{ type: 'requestSync' }]);
    expect(beginAccept(s, A, NOW + 20_000).effects).toEqual([]);
  });

  it('ride_accepted event\'i ack\'ten önce gelirse ack aynı sürümle tekrar uygulanır (idempotent)', () => {
    let s = apply(withReq(), beginAccept(withReq(), A, NOW));
    s = apply(s, onRideAccepted(s, snap(A, { version: 4 })));
    expect(s.activeRide?.version).toBe(4);
    const r = onAcceptAck(s, A, { kind: 'ok', ride: snap(A, { version: 3 }) }, NOW);
    expect(r.patch).toEqual({ accepting: null });
    expect(r.effects).toEqual([]);
  });
});

describe('ride_accepted', () => {
  it('başka cihaz oturumunda da yolculuğu açar; düşük sürüm ve matched olmayan yok sayılır', () => {
    const s = ctx();
    const r = onRideAccepted(s, snap(A));
    expect(r.patch.activeRide?.rideId).toBe(A);
    expect(r.patch.server).toBe('busy');
    expect(onRideAccepted(ctx({ rideVersions: { [A]: 9 } }), snap(A, { version: 3 })).patch).toEqual({});
    expect(onRideAccepted(s, snap(A, { status: 'searching' })).patch).toEqual({});
  });
});

describe('REDDET + GERİ AL (Q3)', () => {
  const setup = () => {
    let s = apply(ctx(), onRideRequested(ctx(), req(A, 500), NOW));
    s = apply(s, onRideRequested(s, req(B, 900), NOW));
    return { ...s, actionLockedUntil: 0 } as RideCtx;
  };

  it('REDDET çağrıyı hemen listeden çıkarır, ret 4 sn sonra gönderilmek üzere planlanır', () => {
    const s = setup();
    const r = beginDecline(s, A, NOW + 5000);
    const n = apply(s, r);
    expect(rid(n.requests)).toEqual([B]);
    expect(n.focusedId).toBe(B);
    expect(n.pendingDecline).toEqual({ request: expect.objectContaining({ rideId: A }), sendAt: NOW + 5000 + DECLINE_UNDO_MS });
    expect(r.effects).toContainEqual({ type: 'scheduleDeclineFlush', rideId: A, delayMs: DECLINE_UNDO_MS });
    expect(types(r.effects)).not.toContain('emitDecline');
  });

  it('süre dolunca ride_decline gönderilir; yanlış kimlik yok sayılır', () => {
    const s = apply(setup(), beginDecline(setup(), A, NOW));
    expect(flushDecline(s, B)).toEqual({ patch: {}, effects: [] });
    const r = flushDecline(s, A);
    expect(r.patch.pendingDecline).toBeNull();
    expect(r.effects).toEqual([{ type: 'emitDecline', rideId: A, request: expect.objectContaining({ rideId: A }) }]);
  });

  it('GERİ AL: çağrı listeye döner, odağa alınır, ret iptal edilir', () => {
    let s = apply(setup(), beginDecline(setup(), A, NOW));
    const r = undoDecline(s, NOW + 1000);
    s = apply(s, r);
    expect(rid(s.requests)).toEqual([A, B]);
    expect(s.focusedId).toBe(A);
    expect(s.pendingDecline).toBeNull();
    expect(r.effects).toEqual([{ type: 'cancelDeclineFlush' }]);
  });

  it('art arda iki ret: öncekinin reti hemen gönderilir', () => {
    let s = apply(setup(), beginDecline(setup(), A, NOW));
    s = { ...s, actionLockedUntil: 0 } as RideCtx;
    const r = beginDecline(s, B, NOW + 1000);
    expect(r.effects.find((e) => e.type === 'emitDecline')).toMatchObject({ rideId: A });
    expect(apply(s, r).pendingDecline?.request.rideId).toBe(B);
  });

  it('kilitliyken ret yapılmaz (kayan içerik koruması)', () => {
    const s = { ...setup(), actionLockedUntil: NOW + 500 } as RideCtx;
    expect(beginDecline(s, A, NOW)).toEqual({ patch: {}, effects: [] });
  });

  it('ret ack INTERNAL → çağrı yeniden görünür + bildirim; diğer hatalar ve zaman aşımı sessiz', () => {
    const s = ctx();
    const request = req(A, 500);
    const r = onDeclineAck(s, request, { ok: false, code: 'INTERNAL' }, NOW);
    expect(rid(r.patch.requests!)).toEqual([A]);
    expect(r.effects).toEqual([{ type: 'toast', text: T.ride.req.declineFailed }]);
    expect(onDeclineAck(s, request, { ok: false, code: 'NOT_A_CANDIDATE' }, NOW)).toEqual({ patch: {}, effects: [] });
    expect(onDeclineAck(s, request, { ok: false, timeout: true }, NOW)).toEqual({ patch: {}, effects: [] });
    expect(onDeclineAck(s, request, { ok: true }, NOW)).toEqual({ patch: {}, effects: [] });
  });
});

describe('durak iptali / tamamlaması (D3)', () => {
  const active = (p: Partial<RideCtx> = {}) => ctx({ activeRide: snap(A), server: 'busy', rideVersions: { [A]: 3 }, ...p });

  it('ride_cancelled: D3 (iptal), sebep taşınır, haptik warning, yerel bildirim, şoför available', () => {
    const r = onRideCancelled(active(), { rideId: A, reason: 'Müşteri vazgeçti', version: 4 }, NOW);
    expect(r.patch).toMatchObject({
      activeRide: null,
      closed: { kind: 'cancelled', shortCode: 'K7M2QX', reason: 'Müşteri vazgeçti' },
      server: 'available',
      wantsOnline: true,
    });
    expect(r.effects).toContainEqual({ type: 'haptic', kind: 'warning' });
    expect(r.effects).toContainEqual({ type: 'localNotify', text: T.ride.notif.cancelled });
    expect(r.effects).toContainEqual({ type: 'persistActiveRide', ride: null });
    expect(r.effects).toContainEqual({ type: 'requestSync' });
  });

  it('düşük sürümlü ride_cancelled yok sayılır; eşit sürüm uygulanır', () => {
    const s = active({ rideVersions: { [A]: 5 } });
    expect(onRideCancelled(s, { rideId: A, version: 4 }, NOW).patch).toEqual({});
    expect(onRideCancelled(s, { rideId: A, version: 5 }, NOW).patch.closed).toBeDefined();
  });

  it('başka ride\'ın ride_cancelled\'ı yolculuğu kapatmaz', () => {
    const r = onRideCancelled(active(), { rideId: B, version: 9 }, NOW);
    expect(r.patch.activeRide).toBeUndefined();
    expect(r.patch.closed).toBeUndefined();
  });

  it('ride_cancelled açık çağrı olarak görünen ride için kapanma sayılır', () => {
    let s = apply(ctx(), onRideRequested(ctx(), req(A, 500), NOW));
    s = apply(s, { patch: { actionLockedUntil: 0 }, effects: [] });
    const r = onRideCancelled(s, { rideId: A, version: 2 }, NOW);
    expect(apply(s, r).requests).toEqual([]);
  });

  it('ride_completed (durak): D3 tamamlandı, haptik success', () => {
    const r = onRideCompleted(active(), { rideId: A, version: 4 });
    expect(r.patch).toMatchObject({ activeRide: null, closed: { kind: 'completedByStand', shortCode: 'K7M2QX' } });
    expect(r.effects).toContainEqual({ type: 'haptic', kind: 'success' });
    expect(types(r.effects)).not.toContain('localNotify');
  });

  it('düşük sürümlü ride_completed yok sayılır', () => {
    expect(onRideCompleted(active({ rideVersions: { [A]: 8 } }), { rideId: A, version: 7 }).patch).toEqual({});
  });

  it('server busy değilse (offline) yerel durum değişmez', () => {
    const r = onRideCancelled(active({ server: 'offline' }), { rideId: A, version: 4 }, NOW);
    expect(r.patch.server).toBeUndefined();
  });
});

describe('TAMAMLA (4.5)', () => {
  const active = (p: Partial<RideCtx> = {}) => ctx({ activeRide: snap(A), server: 'busy', ...p });

  it('ride_complete {rideId, version} gönderilir; bağlantı yok / sync bekleniyor / eylem sürüyorsa gönderilmez', () => {
    const r = beginComplete(active());
    expect(r.patch.rideAction).toBe('completing');
    expect(r.effects).toEqual([{ type: 'emitComplete', rideId: A, version: 3 }]);
    expect(beginComplete(active({ conn: 'disconnected' })).effects).toEqual([]);
    expect(beginComplete(active({ syncPending: true })).effects).toEqual([]);
    expect(beginComplete(active({ rideAction: 'completing' })).effects).toEqual([]);
    expect(beginComplete(ctx()).effects).toEqual([]);
  });

  it('ack ok: D3 kendi tamamlaması, şoför available', () => {
    const s = active({ rideAction: 'completing' });
    const r = onCompleteAck(s, { kind: 'ok', version: 4 });
    expect(r.patch).toMatchObject({ activeRide: null, rideAction: null, closed: { kind: 'completed' }, server: 'available' });
    expect(r.patch.rideVersions![A]).toBe(4);
  });

  it('VERSION_CONFLICT / INVALID_TRANSITION: session_sync istenir, mesaj gösterilir', () => {
    for (const code of ['VERSION_CONFLICT', 'INVALID_TRANSITION'] as const) {
      const r = onCompleteAck(active({ rideAction: 'completing' }), { kind: 'error', code });
      expect(r.patch).toEqual({ rideAction: null, rideMessage: T.ride.detail.changed });
      expect(r.effects).toEqual([{ type: 'requestSync' }]);
    }
  });

  it('zaman aşımı: sonuç bekleniyor + sync; diğer hata: tekrar dene mesajı; oturum hatası: sessionEnd', () => {
    expect(onCompleteAck(active(), { kind: 'timeout' }).patch.rideMessage).toBe(T.ride.req.waiting);
    expect(onCompleteAck(active(), { kind: 'error', code: 'INTERNAL' }).patch.rideMessage).toBe(T.ride.detail.completeErr);
    expect(onCompleteAck(active(), { kind: 'error', code: 'UNAUTHORIZED' }).effects).toEqual([
      { type: 'sessionEnd', reason: 'loggedOutElsewhere' },
    ]);
  });

  it('araya giren sync yolculuğu zaten kapattıysa yalnızca eylem bayrağı temizlenir', () => {
    expect(onCompleteAck(ctx({ rideAction: 'completing' }), { kind: 'ok' })).toEqual({
      patch: { rideAction: null },
      effects: [],
    });
  });
});

describe('Çağrıyı iptal et (şoför)', () => {
  const active = (p: Partial<RideCtx> = {}) => ctx({ activeRide: snap(A), server: 'busy', ...p });

  it('ride_driver_cancel {rideId, version, reason?} gönderilir', () => {
    expect(beginDriverCancel(active(), 'Araç arızası').effects).toEqual([
      { type: 'emitDriverCancel', rideId: A, version: 3, reason: 'Araç arızası' },
    ]);
    expect(beginDriverCancel(active()).effects).toEqual([{ type: 'emitDriverCancel', rideId: A, version: 3 }]);
    expect(beginDriverCancel(active({ conn: 'disconnected' })).effects).toEqual([]);
  });

  it('ack ok: ana ekran, "yeniden aktifsiniz", yolculuk silinir, D3 yok', () => {
    const r = onDriverCancelAck(active({ rideAction: 'cancelling' }), { kind: 'ok', version: 4 });
    expect(r.patch).toMatchObject({ activeRide: null, rideAction: null, server: 'available' });
    expect(r.patch.closed).toBeUndefined();
    expect(r.effects).toContainEqual({ type: 'toast', text: T.ride.detail.cancelledByYou });
    expect(r.effects).toContainEqual({ type: 'requestSync' });
    expect(r.effects).toContainEqual({ type: 'persistActiveRide', ride: null });
  });

  it('çakışma: sync istenir (durak iptal ettiyse D3 event/sync ile gelir)', () => {
    const r = onDriverCancelAck(active({ rideAction: 'cancelling' }), { kind: 'error', code: 'INVALID_TRANSITION' });
    expect(r.effects).toEqual([{ type: 'requestSync' }]);
    expect(onDriverCancelAck(active(), { kind: 'timeout' }).patch.rideMessage).toBe(T.ride.req.waiting);
  });
});

describe('session_sync (ride kısmı)', () => {
  const sync = (p: Partial<Parameters<typeof applyRideSync>[1]> = {}) => ({ openRequests: [], ...p });

  it('openRequests listeyi DEĞİŞTİRİR; sunucu saati farkı alınır; yeni çağrı çalar', () => {
    const r = applyRideSync(
      ctx(),
      sync({ openRequests: [req(B, 900), req(A, 400)], serverTime: new Date(NOW + 5000).toISOString() }),
      NOW,
    );
    expect(rid(r.patch.requests!)).toEqual([A, B]);
    expect(r.patch.focusedId).toBe(A);
    expect(r.patch.clockOffsetMs).toBe(5000);
    expect(r.patch.unseen).toEqual([A, B]);
    expect(r.effects).toContainEqual({ type: 'ring', kind: 'first' });
  });

  it('bağlı kalan çağrı için ses çalmaz, odak ve rozet durumu korunur', () => {
    let s = apply(ctx(), onRideRequested(ctx(), req(A, 400), NOW));
    s = apply(s, markFocusedSeen(s));
    const r = applyRideSync(s, sync({ openRequests: [req(A, 400)] }), NOW + 1000);
    expect(types(r.effects)).not.toContain('ring');
    expect(r.patch.focusedId).toBe(A);
    expect(r.patch.unseen).toEqual([]);
  });

  it('kopukken kapananlar sessizce kalkar; toast sayıyı söyler', () => {
    let s = apply(ctx(), onRideRequested(ctx(), req(A, 400), NOW));
    s = apply(s, onRideRequested(s, req(B, 900), NOW));
    const r = applyRideSync(s, sync({ openRequests: [req(B, 900)] }), NOW + 1000);
    expect(rid(r.patch.requests!)).toEqual([B]);
    expect(r.patch.focusedId).toBe(B);
    expect(r.effects).toContainEqual({ type: 'toast', text: T.ride.req.closedCount(1), ms: 3000 });
  });

  it('reddi bekleyen çağrı sync ile geri gelmez', () => {
    let s = apply(ctx(), onRideRequested(ctx(), req(A, 400), NOW));
    s = apply(s, { patch: { actionLockedUntil: 0 }, effects: [] });
    s = apply(s, beginDecline(s, A, NOW));
    const r = applyRideSync(s, sync({ openRequests: [req(A, 400)] }), NOW + 1000);
    expect(r.patch.requests).toEqual([]);
  });

  it('düşük sürümlü açık çağrı yok sayılır', () => {
    const s = ctx({ rideVersions: { [A]: 7 } });
    expect(applyRideSync(s, sync({ openRequests: [req(A, 400, { version: 6 })] }), NOW).patch.requests).toEqual([]);
  });

  it('activeRide (driverStatus offline olsa da) geri yüklenir; liste boşalır; diske yazılır', () => {
    const s = ctx({ server: 'offline', requests: [{ ...req(B, 500) }] });
    const r = applyRideSync(s, sync({ activeRide: snap(A) }), NOW);
    expect(r.patch.activeRide?.rideId).toBe(A);
    expect(r.patch.requests).toEqual([]);
    expect(r.effects).toContainEqual({ type: 'persistActiveRide', ride: snap(A) });
    expect(r.patch.rideVersions![A]).toBe(3);
  });

  it('aynı sürümlü yolculuk tekrar gelince diske yeniden yazılmaz', () => {
    const s = ctx({ activeRide: snap(A) });
    expect(types(applyRideSync(s, sync({ activeRide: snap(A) }), NOW).effects)).not.toContain('persistActiveRide');
  });

  it('sync yolculuğun bittiğini söylerse yolculuk silinir ve "durum değişti" bildirilir', () => {
    const s = ctx({ activeRide: snap(A), server: 'busy' });
    const r = applyRideSync(s, sync(), NOW);
    expect(r.patch.activeRide).toBeNull();
    expect(r.effects).toContainEqual({ type: 'toast', text: T.ride.detail.changed });
    expect(r.effects).toContainEqual({ type: 'persistActiveRide', ride: null });
  });

  it('D3 zaten gösteriliyorsa ayrıca "durum değişti" bildirilmez', () => {
    const s = ctx({ activeRide: null, closed: { kind: 'cancelled', shortCode: 'X' } });
    expect(types(applyRideSync(s, sync(), NOW).effects)).not.toContain('toast');
  });

  it('bozuk activeRide gövdesi yerel yolculuğu silmez', () => {
    const s = ctx({ activeRide: snap(A), server: 'busy' });
    const r = applyRideSync(s, sync({ activeRideInvalid: true }), NOW);
    expect(r.patch.activeRide).toEqual(snap(A));
  });

  it('kapanışı işlenmiş ride\'ın eski sürümlü sync kaydı yolculuğu diriltmez', () => {
    // ride_completed v5 işlendi (rideVersions=5, activeRide=null); gecikmiş sync v4 matched taşıyor.
    const s = ctx({ rideVersions: { [A]: 5 } });
    const r = applyRideSync(s, sync({ activeRide: snap(A, { version: 4 }) }), NOW);
    expect(r.patch.activeRide).toBeNull();
  });

  it('kabul zaman aşımı sonrası sync yolculuğu getirirse kabul çözülür', () => {
    const s = ctx({ requests: [req(A, 500)], accepting: { rideId: A, timedOut: true } });
    const r = applyRideSync(s, sync({ activeRide: snap(A) }), NOW);
    expect(r.patch.accepting).toBeNull();
    expect(r.patch.activeRide?.rideId).toBe(A);
    expect(types(r.effects)).not.toContain('toast');
  });

  it('kabul zaman aşımı sonrası çağrı yoksa "sonuç alınamadı" bildirilir', () => {
    const s = ctx({ requests: [req(A, 500)], accepting: { rideId: A, timedOut: true } });
    const r = applyRideSync(s, sync(), NOW);
    expect(r.patch.accepting).toBeNull();
    expect(r.patch.requests).toEqual([]);
    expect(r.effects).toContainEqual({ type: 'toast', text: T.ride.req.unknown });
  });

  it('ack henüz gelmediyse (zaman aşımı yok) sync kabul durumunu bozmaz', () => {
    const s = ctx({ requests: [req(A, 500)], accepting: { rideId: A, timedOut: false } });
    expect(applyRideSync(s, sync({ openRequests: [req(A, 500)] }), NOW).patch.accepting).toEqual({
      rideId: A,
      timedOut: false,
    });
  });

  it('yolculuk yokken süren eylem (tamamlama) biter', () => {
    const s = ctx({ rideAction: 'completing', rideMessage: 'x' });
    const r = applyRideSync(s, sync(), NOW);
    expect(r.patch).toMatchObject({ rideAction: null, rideMessage: null });
  });
});

describe('clearRequests', () => {
  it('pasif olunca çağrılar, bekleyen ret ve kabul temizlenir', () => {
    const s = ctx({ requests: [req(A, 1)], focusedId: A, pendingDecline: { request: req(B, 2), sendAt: NOW } });
    const r = clearRequests(s);
    expect(r.patch).toMatchObject({ requests: [], focusedId: null, pendingDecline: null, accepting: null });
    expect(types(r.effects)).toEqual(['cancelDeclineFlush', 'stopRing']);
    expect(clearRequests(ctx())).toEqual({ patch: {}, effects: [] });
  });
});
