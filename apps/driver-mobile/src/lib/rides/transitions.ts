// Çağrı / yolculuk geçişleri (docs/design/faz3-dispatch.md 4.3–4.9). Her fonksiyon saftır: mevcut durumu ve olayı
// alır, durum yamasını ve yan etkileri döndürür; yan etkileri servis katmanı (src/services/rides.ts) uygular.
// Kurallar: ride içeren her olayda `version` kapısı (elindekinden düşük olan yok sayılır); `session_sync` ride
// durumunu değiştirir (birleştirmez); kabul yalnızca sunucu ack'iyle kesinleşir (iyimser güncelleme yok).
import { STAND_SUSPENDED_REASON, type ErrorCode, type RideRequest, type RideSnapshot } from '@duraknet/shared';
import {
  ACTION_LOCK_MS,
  CLOSED_TOAST_MS,
  DECLINE_UNDO_MS,
  MAX_TRACKED_RIDE_VERSIONS,
  TAKEN_CARD_MS,
} from '../constants';
import { formatDistance } from '../format';
import type { Conn, PresenceState, ServerStatus } from '../presence/state';
import { acceptPresenceVersion } from '../presence/transitions';
import { isSessionEndingCode, sessionEndReasonOf, type SessionEndReason } from '../session-policy';
import { T } from '../texts';
import { clockOffset } from './clock';
import type { RideSyncParts } from './parse';
import { sortRequests, type OpenRequest, type RideClosed, type RidesState } from './state';

/** Geçişlerin okuduğu bağlam: ride durumu + yalnızca okunan varlık alanları. */
export type RideCtx = RidesState & Pick<PresenceState, 'server' | 'conn' | 'syncPending' | 'tracking' | 'presenceVersion'>;

/** Ride geçişlerinin yazabildiği alanlar (ride durumu + şoförün yerel `server` tahmini). */
export type RidePatch = Partial<RidesState> & {
  server?: ServerStatus;
  wantsOnline?: boolean;
  presenceVersion?: number | null;
};

export type RideEffect =
  | { type: 'emitAccept'; rideId: string }
  | { type: 'emitDecline'; rideId: string; request: OpenRequest }
  | { type: 'emitComplete'; rideId: string; version: number }
  | { type: 'emitDriverCancel'; rideId: string; version: number; reason?: string }
  | { type: 'scheduleDeclineFlush'; rideId: string; delayMs: number }
  | { type: 'cancelDeclineFlush' }
  | { type: 'scheduleTakenRemoval'; rideId: string; delayMs: number }
  /** İlk çağrı: ses + titreşim 3 kez; ek çağrı: tek bip + tek titreşim. */
  | { type: 'ring'; kind: 'first' | 'extra' }
  | { type: 'stopRing' }
  | { type: 'haptic'; kind: 'success' | 'warning' }
  | { type: 'toast'; text: string; ms?: number }
  | { type: 'announce'; text: string }
  | { type: 'localNotify'; text: string }
  | { type: 'requestSync' }
  /** Eşleşmiş yolculuğu soğuk açılış için diske yaz / sil. */
  | { type: 'persistActiveRide'; ride: RideSnapshot | null }
  | { type: 'sessionEnd'; reason: SessionEndReason };

export type RideStep = { patch: RidePatch; effects: RideEffect[] };

const step = (patch: RidePatch = {}, effects: RideEffect[] = []): RideStep => ({ patch, effects });
const NOOP: RideStep = { patch: {}, effects: [] };

// ---------------------------------------------------------------------------------------------
// version kapısı

/** Görülen sürümü kaydeder (yalnızca artar); tablo büyürse en eskiler atılır. */
export function noteVersion(
  versions: Record<string, number>,
  rideId: string,
  version: number,
): Record<string, number> {
  if ((versions[rideId] ?? -1) >= version) return versions;
  const next = { ...versions };
  delete next[rideId]; // en sona taşı (ekleme sırası = yenilik sırası)
  next[rideId] = version;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TRACKED_RIDE_VERSIONS))) delete next[k];
  return next;
}

/** Elindekinden düşük sürümlü event yok sayılır; eşit veya büyük uygulanır. */
export const isStale = (versions: Record<string, number>, rideId: string, version: number): boolean => {
  const known = versions[rideId];
  return known != null && version < known;
};

// ---------------------------------------------------------------------------------------------
// Liste yardımcıları

const nearestId = (list: readonly OpenRequest[]): string | null =>
  (list.find((r) => !r.taken) ?? list[0])?.rideId ?? null;

/**
 * Listeden bir çağrı çıkınca/eklenince odak ve kilit: odak hâlâ listedeyse değişmez; kapandıysa en yakına geçer
 * ve (yeni odak varsa) KABUL/REDDET 700 ms kilitlenir (kayan içeriğe yanlış dokunma). Boş listede kilit gerekmez.
 */
function refocus(
  prevFocused: string | null,
  list: readonly OpenRequest[],
  now: number,
  lockedUntil: number,
): Pick<RidesState, 'focusedId' | 'actionLockedUntil'> {
  if (prevFocused && list.some((r) => r.rideId === prevFocused)) {
    return { focusedId: prevFocused, actionLockedUntil: lockedUntil };
  }
  const next = nearestId(list);
  return { focusedId: next, actionLockedUntil: next ? Math.max(lockedUntil, now + ACTION_LOCK_MS) : lockedUntil };
}

/** Bir çağrıyı listeden çıkarır (odak/kilit/YENİ rozeti dahil). */
function withoutRequest(s: RideCtx, rideId: string, now: number): RidePatch {
  const requests = s.requests.filter((r) => r.rideId !== rideId);
  return {
    requests,
    unseen: s.unseen.filter((id) => id !== rideId),
    ...refocus(s.focusedId, requests, now, s.actionLockedUntil),
  };
}

const ringKindFor = (hadRequests: boolean): 'first' | 'extra' => (hadRequests ? 'extra' : 'first');
const live = (list: readonly OpenRequest[]) => list.filter((r) => !r.taken);

// ---------------------------------------------------------------------------------------------
// Gelen çağrılar (ride_requested / ride_taken)

export function onRideRequested(s: RideCtx, req: RideRequest, now: number): RideStep {
  // Eşleşmişken veya reddi bekleyen çağrı için gösterilmez.
  if (s.activeRide || s.pendingDecline?.request.rideId === req.rideId) return NOOP;
  if (isStale(s.rideVersions, req.rideId, req.version)) return NOOP;
  const offset = clockOffset(req.serverNow, now) ?? s.clockOffsetMs;
  const rideVersions = noteVersion(s.rideVersions, req.rideId, req.version);
  const existing = s.requests.find((r) => r.rideId === req.rideId);

  if (existing) {
    // Yinelenen çağrı: yüksek sürümle güncellenir; ses/rozet tekrarlanmaz. Kabul denendiyse `taken` korunur.
    const requests = sortRequests(s.requests.map((r) => (r.rideId === req.rideId ? { ...req, ...(r.taken ? { taken: true as const } : {}) } : r)));
    return step({ requests, rideVersions, clockOffsetMs: offset });
  }

  const hadRequests = live(s.requests).length > 0;
  const requests = sortRequests([...s.requests, req]);
  // Odak sıçramaz: odak doluysa (ve hâlâ listedeyse) olduğu gibi kalır; boşsa en yakına gider.
  const keepFocus = s.focusedId != null && requests.some((r) => r.rideId === s.focusedId);
  const focus: Pick<RidesState, 'focusedId' | 'actionLockedUntil'> = keepFocus
    ? { focusedId: s.focusedId, actionLockedUntil: s.actionLockedUntil }
    : { focusedId: nearestId(requests), actionLockedUntil: Math.max(s.actionLockedUntil, now + ACTION_LOCK_MS) };
  const total = live(requests).length;
  return step(
    { requests, rideVersions, clockOffsetMs: offset, unseen: [...s.unseen, req.rideId], ...focus },
    [
      { type: 'ring', kind: ringKindFor(hadRequests) },
      {
        type: 'announce',
        text: hadRequests
          ? T.ride.a11y.newRequestMore(total)
          : T.ride.a11y.newRequest(formatDistance(req.distanceM), req.pickupAddress),
      },
    ],
  );
}

/**
 * `ride_taken`: başkası aldı veya çağrı kapandı (durak iptali / askıya alma dahil). Kabul bekleyen çağrıda ack belirler.
 * `version` kapanış sürümüdür: düşük sürümlü olay yok sayılır; kapanış sürümü `rideVersions`'a işlenir (mezar taşı:
 * sıra dışı gelen eski `ride_requested` / eski `session_sync` kapanmış çağrıyı yeniden eklemez).
 */
export function onRideTaken(s: RideCtx, rideId: string, version: number, now: number): RideStep {
  if (isStale(s.rideVersions, rideId, version)) return NOOP;
  const noted = noteVersion(s.rideVersions, rideId, version);
  const vp: RidePatch = noted !== s.rideVersions ? { rideVersions: noted } : {};
  if (s.accepting?.rideId === rideId) return step(vp);
  const pending = s.pendingDecline?.request.rideId === rideId;
  const inList = s.requests.find((r) => r.rideId === rideId);
  if (!inList) {
    // Reddi beklerken kapandı: ret gönderilmez, GERİ AL şeridi kalkar.
    return pending ? step({ ...vp, pendingDecline: null }, [{ type: 'cancelDeclineFlush' }]) : step(vp);
  }
  if (inList.taken) return step(vp); // zaten "başka şoföre gitti" kartı gösteriliyor
  // Kabulüm sürerken kazandığımda sunucu diğer açık çağrılarımı da kapatır: bildirim gösterilmez.
  if (s.accepting) return step({ ...vp, ...withoutRequest(s, rideId, now) });
  return step({ ...vp, ...withoutRequest(s, rideId, now) }, [
    { type: 'stopRing' },
    { type: 'toast', text: T.ride.req.closedToast, ms: CLOSED_TOAST_MS },
  ]);
}

/** Odak değiştirme (liste dokunuşu): YENİ rozeti kalkar, 700 ms kilit. */
export function focusRequest(s: RideCtx, rideId: string, now: number): RideStep {
  if (s.accepting || s.focusedId === rideId || !s.requests.some((r) => r.rideId === rideId)) return NOOP;
  return step({
    focusedId: rideId,
    unseen: s.unseen.filter((id) => id !== rideId),
    actionLockedUntil: now + ACTION_LOCK_MS,
  });
}

/** D1 açılınca/odaklı kart görününce YENİ rozeti kalkar (kilit uygulanmaz). */
export function markFocusedSeen(s: RideCtx): RideStep {
  if (!s.focusedId || !s.unseen.includes(s.focusedId)) return NOOP;
  return step({ unseen: s.unseen.filter((id) => id !== s.focusedId) });
}

// ---------------------------------------------------------------------------------------------
// KABUL

export function beginAccept(s: RideCtx, rideId: string, now: number): RideStep {
  const r = s.requests.find((x) => x.rideId === rideId);
  if (!r || r.taken || s.accepting || now < s.actionLockedUntil || s.activeRide) return NOOP;
  if (s.conn !== 'connected') return step({}, [{ type: 'toast', text: T.ride.req.offline }]);
  return step({ accepting: { rideId, timedOut: false } }, [{ type: 'stopRing' }, { type: 'emitAccept', rideId }]);
}

export type AcceptOutcome =
  /** `presenceVersion`: ack'in taşıdığı varlık sürümü (kabul öncesi eski session_sync'i eler). */
  | { kind: 'ok'; ride: RideSnapshot; presenceVersion?: number }
  | { kind: 'error'; code: ErrorCode }
  | { kind: 'timeout' };

/** Eşleşmiş yolculuğu benimser: çağrı listesi ve bekleyen ret temizlenir, şoför `busy` olur. */
function adoptActiveRide(s: RideCtx, ride: RideSnapshot): RidePatch {
  return {
    activeRide: ride,
    rideVersions: noteVersion(s.rideVersions, ride.rideId, ride.version),
    requests: [],
    focusedId: null,
    unseen: [],
    accepting: null,
    pendingDecline: null,
    closed: null,
    rideAction: null,
    rideMessage: null,
    server: 'busy',
  };
}

export function onAcceptAck(s: RideCtx, rideId: string, r: AcceptOutcome, now: number): RideStep {
  if (r.kind === 'ok') {
    // Kabul varlık sürümünü artırır: ack'ten daha yeni bir sync/ack zaten işlendiyse bu ack eskidir; sync belirler.
    const pv = acceptPresenceVersion(s.presenceVersion, r.presenceVersion);
    if (!pv.accept) return step({ accepting: null }, [{ type: 'requestSync' }]);
    const pvPatch: RidePatch = pv.next !== s.presenceVersion ? { presenceVersion: pv.next } : {};
    const cur = s.activeRide;
    if (cur && cur.rideId === r.ride.rideId && cur.version > r.ride.version) {
      return step({ ...pvPatch, accepting: null }); // ride_accepted event'i daha yeni sürümle zaten geldi
    }
    // Ack'ten önce daha yeni bir olay (ör. durak iptali) işlendiyse eski ack yolculuğu diriltmez; sync belirler.
    if (isStale(s.rideVersions, r.ride.rideId, r.ride.version)) {
      return step({ ...pvPatch, accepting: null }, [{ type: 'requestSync' }]);
    }
    return step({ ...adoptActiveRide(s, r.ride), ...pvPatch }, [
      { type: 'cancelDeclineFlush' },
      { type: 'stopRing' },
      { type: 'haptic', kind: 'success' },
      { type: 'persistActiveRide', ride: r.ride },
    ]);
  }
  if (r.kind === 'timeout') {
    // Sonuç bilinmiyor: yeniden kabul denenmez; son söz session_sync'tir.
    return step({ accepting: { rideId, timedOut: true } }, [{ type: 'requestSync' }]);
  }
  switch (r.code) {
    case 'RIDE_NOT_AVAILABLE':
    case 'NOT_A_CANDIDATE':
      return markTaken(s, rideId, now);
    case 'DRIVER_NOT_AVAILABLE':
      return step({ accepting: null }, [{ type: 'toast', text: T.ride.req.notAvailable }, { type: 'requestSync' }]);
    case 'UNAUTHORIZED':
    case 'ACCOUNT_PENDING':
    case 'ACCOUNT_SUSPENDED':
      return step({ accepting: null }, [{ type: 'sessionEnd', reason: sessionEndReasonOf(r.code) }]);
    default:
      return step({ accepting: null }, [{ type: 'toast', text: T.ride.req.errInternal }]);
  }
}

/** Kaybedilen yarış: hata değil, olağan sonuç. Kart "Çağrı başka şoföre gitti" olur, 3 sn sonra kalkar. */
function markTaken(s: RideCtx, rideId: string, _now: number): RideStep {
  const inList = s.requests.some((r) => r.rideId === rideId);
  return step(
    {
      accepting: null,
      requests: s.requests.map((r) => (r.rideId === rideId ? { ...r, taken: true as const } : r)),
      unseen: s.unseen.filter((id) => id !== rideId),
    },
    [
      { type: 'haptic', kind: 'warning' },
      ...(inList ? [{ type: 'scheduleTakenRemoval', rideId, delayMs: TAKEN_CARD_MS } as const] : []),
    ],
  );
}

/** "Başka şoföre gitti" kartının süresi doldu: kart kalkar. */
export function expireTaken(s: RideCtx, rideId: string, now: number): RideStep {
  const r = s.requests.find((x) => x.rideId === rideId);
  if (!r?.taken) return NOOP;
  return step(withoutRequest(s, rideId, now));
}

/** `ride_accepted` (kabul onayı; başka cihaz oturumları için de gelir): yolculuk ekranını açar/yeniler. */
export function onRideAccepted(s: RideCtx, ride: RideSnapshot): RideStep {
  if (ride.status !== 'matched' || isStale(s.rideVersions, ride.rideId, ride.version)) return NOOP;
  const fresh = s.activeRide?.rideId !== ride.rideId;
  return step(adoptActiveRide(s, ride), [
    { type: 'cancelDeclineFlush' },
    { type: 'stopRing' },
    ...(fresh ? [{ type: 'haptic', kind: 'success' } as const] : []),
    { type: 'persistActiveRide', ride },
  ]);
}

// ---------------------------------------------------------------------------------------------
// REDDET (4 sn GERİ AL; Q3)

export function beginDecline(s: RideCtx, rideId: string, now: number): RideStep {
  const r = s.requests.find((x) => x.rideId === rideId);
  if (!r || r.taken || s.accepting || now < s.actionLockedUntil || s.activeRide) return NOOP;
  const effects: RideEffect[] = [];
  // Önceki ret hâlâ bekliyorsa hemen gönderilir (şerit yalnızca en yenisini gösterir).
  if (s.pendingDecline) {
    effects.push({ type: 'cancelDeclineFlush' }, { type: 'emitDecline', rideId: s.pendingDecline.request.rideId, request: s.pendingDecline.request });
  }
  effects.push({ type: 'stopRing' }, { type: 'scheduleDeclineFlush', rideId, delayMs: DECLINE_UNDO_MS });
  return step({ ...withoutRequest(s, rideId, now), pendingDecline: { request: r, sendAt: now + DECLINE_UNDO_MS } }, effects);
}

/** 4 sn doldu: ret gönderilir. */
export function flushDecline(s: RideCtx, rideId: string): RideStep {
  const p = s.pendingDecline;
  if (!p || p.request.rideId !== rideId) return NOOP;
  return step({ pendingDecline: null }, [{ type: 'emitDecline', rideId, request: p.request }]);
}

/** GERİ AL: çağrı listeye döner (kapanmadıysa), odağa alınır. */
export function undoDecline(s: RideCtx, now: number): RideStep {
  const p = s.pendingDecline;
  if (!p) return NOOP;
  const base: RidePatch = { pendingDecline: null };
  const effects: RideEffect[] = [{ type: 'cancelDeclineFlush' }];
  if (s.activeRide || s.requests.some((r) => r.rideId === p.request.rideId)) return step(base, effects);
  const requests = sortRequests([...s.requests, p.request]);
  return step(
    { ...base, requests, focusedId: p.request.rideId, actionLockedUntil: now + ACTION_LOCK_MS },
    effects,
  );
}

/**
 * `ride_decline` ack'i: `INTERNAL` ve zaman aşımı/ağ hatasında (sonuç bilinmiyor) çağrı yeniden görünür ki
 * şoför tekrar deneyebilsin; diğer hatalar sessizdir. Şoför artık `available` değilse (pasif/eşleşmiş) geri konmaz.
 */
export function onDeclineAck(
  s: RideCtx,
  request: OpenRequest,
  r: { ok: true } | { ok: false; code: ErrorCode } | { ok: false; timeout: true },
  now: number,
): RideStep {
  if (r.ok) return NOOP;
  if (!('timeout' in r)) {
    if (isSessionEndingCode(r.code)) return step({}, [{ type: 'sessionEnd', reason: sessionEndReasonOf(r.code) }]);
    if (r.code !== 'INTERNAL') return NOOP;
  }
  if (s.server === 'offline' || s.server === 'busy') return NOOP;
  if (s.activeRide || s.requests.some((x) => x.rideId === request.rideId)) return NOOP;
  const requests = sortRequests([...s.requests, request]);
  return step(
    { requests, ...refocus(s.focusedId, requests, now, s.actionLockedUntil) },
    [{ type: 'toast', text: T.ride.req.declineFailed }],
  );
}

// ---------------------------------------------------------------------------------------------
// Yolculuğun kapanışı (D3) ve şoför eylemleri (D2)

/** `server: 'busy'` iken yerelde `available`'a dönülür (sunucu çağrı kapanınca şoförü bırakır; sync doğrular). */
const releaseServer = (s: RideCtx): Pick<RidePatch, 'server' | 'wantsOnline'> =>
  s.server === 'busy' ? { server: 'available', wantsOnline: true } : {};

function closeActive(s: RideCtx, ride: RideSnapshot, version: number, closed: RideClosed): RideStep {
  const cancelled = closed.kind === 'cancelled';
  return step(
    {
      activeRide: null,
      rideAction: null,
      rideMessage: null,
      closed,
      rideVersions: noteVersion(s.rideVersions, ride.rideId, version),
      ...releaseServer(s),
    },
    [
      { type: 'haptic', kind: cancelled ? 'warning' : 'success' },
      ...(cancelled
        ? [
            {
              type: 'localNotify',
              text: closed.kind === 'cancelled' && closed.standSuspended ? T.ride.notif.standSuspended : T.ride.notif.cancelled,
            } as const,
          ]
        : []),
      { type: 'persistActiveRide', ride: null },
      { type: 'requestSync' },
    ],
  );
}

/** `ride_cancelled`: durak iptal etti. Yalnızca kendi eşleşmiş yolculuğum için D3; sürüm kapısı uygulanır. */
export function onRideCancelled(s: RideCtx, ev: { rideId: string; reason?: string; version: number }, now: number): RideStep {
  if (isStale(s.rideVersions, ev.rideId, ev.version)) return NOOP;
  const ride = s.activeRide;
  if (!ride || ride.rideId !== ev.rideId) {
    // Açık çağrı olarak görünüyorsa kapanmış sayılır; başka bir ride ise yalnızca sürüm not edilir.
    const t = onRideTaken(s, ev.rideId, ev.version, now);
    return step({ ...t.patch, rideVersions: noteVersion(s.rideVersions, ev.rideId, ev.version) }, t.effects);
  }
  // Durak askıya alındı: serbest metin sebep değil, sabit sebep; D3 ayrı metin gösterir.
  const standSuspended = ev.reason === STAND_SUSPENDED_REASON;
  return closeActive(s, ride, ev.version, {
    kind: 'cancelled',
    shortCode: ride.shortCode,
    ...(standSuspended ? { standSuspended: true as const } : ev.reason ? { reason: ev.reason } : {}),
  });
}

/** `ride_completed`: durak tamamladı (şoför kendi tamamlamasında ack alır, bu event gelmez). */
export function onRideCompleted(s: RideCtx, ev: { rideId: string; version: number }): RideStep {
  if (isStale(s.rideVersions, ev.rideId, ev.version)) return NOOP;
  const ride = s.activeRide;
  if (!ride || ride.rideId !== ev.rideId) {
    return step({ rideVersions: noteVersion(s.rideVersions, ev.rideId, ev.version) });
  }
  return closeActive(s, ride, ev.version, { kind: 'completedByStand', shortCode: ride.shortCode });
}

/** MÜŞTERİ ALINDI / TAMAMLA (onay diyaloğundan sonra). */
export function beginComplete(s: RideCtx): RideStep {
  const ride = s.activeRide;
  if (!ride || s.rideAction || s.conn !== 'connected' || s.syncPending || s.server === 'unknown') return NOOP;
  return step({ rideAction: 'completing', rideMessage: null }, [
    { type: 'emitComplete', rideId: ride.rideId, version: ride.version },
  ]);
}

export type ActionOutcome =
  | { kind: 'ok'; version?: number }
  | { kind: 'error'; code: ErrorCode }
  | { kind: 'timeout' };

const conflictLike = (code: ErrorCode) => code === 'VERSION_CONFLICT' || code === 'INVALID_TRANSITION';

/** Ortak hata yorumu: tamamlama ve şoför iptali ack'lerinde aynıdır. */
function actionFailure(r: Exclude<ActionOutcome, { kind: 'ok' }>, genericText: string): RideStep {
  if (r.kind === 'timeout') {
    return step({ rideAction: null, rideMessage: T.ride.req.waiting }, [{ type: 'requestSync' }]);
  }
  if (isSessionEndingCode(r.code)) {
    return step({ rideAction: null }, [{ type: 'sessionEnd', reason: sessionEndReasonOf(r.code) }]);
  }
  if (conflictLike(r.code)) {
    // Durum başka yerden değişti (ör. durak aynı anda iptal etti/tamamladı): güncel durum istenir; ilgili
    // ride_cancelled / ride_completed event'i ya da session_sync D3'ü / ana ekranı belirler.
    return step({ rideAction: null, rideMessage: T.ride.detail.changed }, [{ type: 'requestSync' }]);
  }
  return step({ rideAction: null, rideMessage: genericText });
}

export function onCompleteAck(s: RideCtx, r: ActionOutcome): RideStep {
  if (r.kind !== 'ok') return actionFailure(r, T.ride.detail.completeErr);
  const ride = s.activeRide;
  // Araya giren sync yolculuğu zaten kapattıysa yalnızca eylem bayrağı temizlenir.
  if (!ride) return step({ rideAction: null });
  return closeActive(s, ride, r.version ?? ride.version, { kind: 'completed', shortCode: ride.shortCode });
}

/** "Çağrıyı iptal et" (onay diyaloğundan sonra). `reason` sabit etiketlerden biridir (≤ 120). */
export function beginDriverCancel(s: RideCtx, reason?: string): RideStep {
  const ride = s.activeRide;
  if (!ride || s.rideAction || s.conn !== 'connected' || s.syncPending || s.server === 'unknown') return NOOP;
  return step({ rideAction: 'cancelling', rideMessage: null }, [
    { type: 'emitDriverCancel', rideId: ride.rideId, version: ride.version, ...(reason ? { reason } : {}) },
  ]);
}

export function onDriverCancelAck(s: RideCtx, r: ActionOutcome): RideStep {
  if (r.kind !== 'ok') return actionFailure(r, T.ride.detail.cancelErr);
  const ride = s.activeRide;
  return step(
    {
      activeRide: null,
      rideAction: null,
      rideMessage: null,
      ...(ride ? { rideVersions: noteVersion(s.rideVersions, ride.rideId, r.version ?? ride.version) } : {}),
      ...releaseServer(s),
    },
    [
      { type: 'toast', text: T.ride.detail.cancelledByYou },
      { type: 'persistActiveRide', ride: null },
      { type: 'requestSync' },
    ],
  );
}

/** D3 TAMAM / otomatik kapanış. */
export function dismissClosed(): RideStep {
  return step({ closed: null });
}

/** D2'de satır içi mesajı temizler. */
export function clearRideMessage(): RideStep {
  return step({ rideMessage: null });
}

// ---------------------------------------------------------------------------------------------
// session_sync (Bölüm 4.9): ride durumunu DEĞİŞTİRİR, birleştirmez. Çağıran, varlık adımı `ignored` ise çağırmaz.

export function applyRideSync(s: RideCtx, sync: RideSyncParts, now: number): RideStep {
  const effects: RideEffect[] = [];
  let rideVersions = s.rideVersions;
  const offset = clockOffset(sync.serverTime, now) ?? s.clockOffsetMs;

  // --- Eşleşmiş yolculuk
  let activeRide: RideSnapshot | null = s.activeRide;
  if (!sync.activeRideInvalid) {
    const inc = sync.activeRide ?? null;
    if (inc) {
      const stale = isStale(rideVersions, inc.rideId, inc.version);
      // Daha yeni bir olay (ör. kapanış) işlendiyse eski sync yolculuğu diriltmez; yerel yeni kayıt korunur.
      activeRide = stale ? (s.activeRide?.rideId === inc.rideId ? s.activeRide : null) : inc;
      if (!stale) rideVersions = noteVersion(rideVersions, inc.rideId, inc.version);
    } else {
      activeRide = null;
    }
  }
  const rideChanged =
    (activeRide?.rideId ?? null) !== (s.activeRide?.rideId ?? null) ||
    (activeRide?.version ?? -1) !== (s.activeRide?.version ?? -1);
  if (rideChanged) effects.push({ type: 'persistActiveRide', ride: activeRide });
  if (s.activeRide && !activeRide && !s.closed && !sync.activeRideInvalid) {
    effects.push({ type: 'toast', text: T.ride.detail.changed });
  }

  // --- Açık çağrılar (eşleşmişken liste boştur)
  const pending = s.pendingDecline?.request.rideId;
  // Reddi bekleyen çağrı sunucuda artık açık değilse (kapandı) GERİ AL şeridi kalkar; kapanmış çağrı geri gelmez.
  const pendingClosed = pending != null && (activeRide != null || !sync.openRequests.some((r) => r.rideId === pending));
  if (pendingClosed) effects.push({ type: 'cancelDeclineFlush' });
  const incoming: OpenRequest[] = activeRide
    ? []
    : sortRequests(
        sync.openRequests.filter((r) => r.rideId !== pending && !isStale(rideVersions, r.rideId, r.version)),
      );
  for (const r of incoming) rideVersions = noteVersion(rideVersions, r.rideId, r.version);

  const prevLive = live(s.requests);
  const prevIds = new Set(prevLive.map((r) => r.rideId));
  const incomingIds = new Set(incoming.map((r) => r.rideId));
  const added = incoming.filter((r) => !prevIds.has(r.rideId));
  // Kabul sonucu bilinmiyordu (zaman aşımı) ve çağrı artık yoksa: sonuç alınamadı bildirimi.
  const acc = s.accepting;
  const resolvedAcceptance = acc != null && (acc.timedOut || activeRide?.rideId === acc.rideId);
  const closedCount = prevLive.filter((r) => !incomingIds.has(r.rideId) && r.rideId !== acc?.rideId).length;
  if (!activeRide && closedCount > 0) {
    effects.push({ type: 'toast', text: T.ride.req.closedCount(closedCount), ms: CLOSED_TOAST_MS });
  }
  if (acc?.timedOut && !activeRide) effects.push({ type: 'toast', text: T.ride.req.unknown });
  if (added.length > 0) {
    effects.push({ type: 'ring', kind: ringKindFor(prevLive.length > 0) });
    effects.push({
      type: 'announce',
      text:
        prevLive.length > 0
          ? T.ride.a11y.newRequestMore(incoming.length)
          : T.ride.a11y.newRequest(formatDistance(added[0]!.distanceM), added[0]!.pickupAddress),
    });
  }
  if (incoming.length === 0 && prevLive.length > 0) effects.push({ type: 'stopRing' });

  // Kabul denenen ve hâlâ sunucuda açık çağrı yerel `accepting` ile korunur (ack gelecek).
  const keptAccepting = acc != null && !resolvedAcceptance ? acc : null;
  const focus = refocus(s.focusedId, incoming, now, s.actionLockedUntil);
  return step(
    {
      activeRide,
      rideVersions,
      clockOffsetMs: offset,
      requests: incoming,
      unseen: [...s.unseen.filter((id) => incomingIds.has(id)), ...added.map((r) => r.rideId)],
      accepting: keptAccepting,
      ...(pendingClosed ? { pendingDecline: null } : {}),
      // Yolculuk sunucuda artık yoksa süren eylem de biter.
      ...(!activeRide ? { rideAction: null, rideMessage: null } : {}),
      ...(activeRide ? { closed: null } : {}),
      ...focus,
    },
    effects,
  );
}

/** Yerel varlık `available` dışına çıktı (pasif oldu): çağrı listesi temizlenir, bekleyen ret düşer. */
export function clearRequests(s: RideCtx): RideStep {
  if (s.requests.length === 0 && !s.pendingDecline && !s.accepting) return NOOP;
  // Bekleyen ret şoförün bilinçli niyetidir: sessizce düşmez, hemen gönderilir (bağlantı yoksa emit zaman aşımına
  // düşer; çağrı sunucuda açık kalırsa sonraki session_sync zaten listeyi belirler).
  const flush: RideEffect[] = s.pendingDecline
    ? [{ type: 'emitDecline', rideId: s.pendingDecline.request.rideId, request: s.pendingDecline.request }]
    : [];
  return step(
    { requests: [], focusedId: null, unseen: [], pendingDecline: null, accepting: null },
    [{ type: 'cancelDeclineFlush' }, ...flush, { type: 'stopRing' }],
  );
}

/** Bağlantı bağlamı seçicisi (UI için): kabul/ret düğmeleri etkin mi. */
export const canActOnRequests = (s: { conn: Conn }) => s.conn === 'connected';
