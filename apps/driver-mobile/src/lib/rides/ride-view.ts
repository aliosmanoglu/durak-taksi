// Çağrı ve yolculuk ekranlarının türetilmiş durumu (D1 / D2). Saf fonksiyonlar; yalnızca `now`'a bağlıdır.
import { MAX_LISTED_REQUESTS } from '../constants';
import { formatDistance, formatElapsed, formatElapsedA11y } from '../format';
import { T } from '../texts';
import { elapsedSince } from './clock';
import type { RideCtx } from './transitions';
import type { OpenRequest } from './state';

export type RequestsView = {
  /** Odaklı kart (yoksa liste boştur). */
  focused: OpenRequest | null;
  /** Odaklı olmayan çağrılar (en çok 10); fazlası `moreCount`. */
  others: OpenRequest[];
  moreCount: number;
  /** Açık (kapanmamış) çağrı sayısı. */
  total: number;
  /** 1 tabanlı odak sırası (a11y "Çağrı 1/3"). */
  focusIndex: number;
  /** Odaklı kart henüz görülmemiş (YENİ). */
  focusedIsNew: boolean;
  /** Başlık altında bağlantı yok şeridi. */
  offline: boolean;
  /** KABUL/REDDET bir süre kilitli (kayan içerik koruması). */
  locked: boolean;
  /** KABUL/REDDET dokunulabilir. */
  canAct: boolean;
  accepting: boolean;
  /** Kabul sonucu bekleniyor (zaman aşımı). */
  waiting: boolean;
  elapsedText: string;
  elapsedA11y: string;
  distanceText: string;
};

export function deriveRequests(s: RideCtx, now: number): RequestsView {
  const focused = s.requests.find((r) => r.rideId === s.focusedId) ?? s.requests[0] ?? null;
  const rest = s.requests.filter((r) => r.rideId !== focused?.rideId);
  const live = s.requests.filter((r) => !r.taken);
  const offline = s.conn !== 'connected';
  const locked = now < s.actionLockedUntil;
  const accepting = s.accepting != null;
  const ms = focused ? elapsedSince(focused.createdAt, now, s.clockOffsetMs) : 0;
  return {
    focused,
    others: rest.slice(0, MAX_LISTED_REQUESTS - 1),
    moreCount: Math.max(0, rest.length - (MAX_LISTED_REQUESTS - 1)),
    total: live.length,
    focusIndex: focused ? Math.max(1, live.findIndex((r) => r.rideId === focused.rideId) + 1) : 0,
    focusedIsNew: focused != null && s.unseen.includes(focused.rideId),
    offline,
    locked,
    canAct: !!focused && !focused.taken && !offline && !locked && !accepting,
    accepting,
    waiting: s.accepting?.timedOut === true,
    elapsedText: ms < 5_000 ? T.ride.req.justNow : T.ride.req.elapsed(formatElapsed(ms)),
    elapsedA11y: ms < 60_000 ? T.ride.req.justNow : T.ride.req.elapsed(formatElapsedA11y(ms)),
    distanceText: focused ? formatDistance(focused.distanceM) : '',
  };
}

export type DetailView = {
  /** Soğuk açılış: sunucudan henüz doğrulanmadı → kart soluk + "Güncelleniyor…". */
  loading: boolean;
  /** Bağlantı yok şeridi (NAVİGASYON yine etkin). */
  offline: boolean;
  /** "Konumunuz paylaşılmıyor" şeridi + KONUM PAYLAŞ (yalnızca sunucu durumu pasifken). */
  noLocation: boolean;
  /** Konum çipi: paylaşılıyor mu. */
  sharing: boolean;
  navigateEnabled: boolean;
  /** TAMAMLA ve "Çağrıyı iptal et": sunucu onayı gerektirir. */
  serverActionsEnabled: boolean;
  callStandEnabled: boolean;
  completing: boolean;
  cancelling: boolean;
};

/** D2 (Kabul/Detay) durumu (4.5 durum tablosu). */
export function deriveDetail(s: RideCtx): DetailView {
  const ride = s.activeRide;
  const loading = s.server === 'unknown';
  const offline = s.conn !== 'connected';
  const synced = !loading && !s.syncPending;
  return {
    loading,
    offline,
    // Sunucu pasif görüyor (çıkış/yeniden giriş) ya da `busy` ama konum görevi çalışmıyor (izin sorulmadı vb.).
    noLocation: synced && (s.server === 'offline' || (s.server === 'busy' && !s.tracking)),
    sharing: s.server === 'busy' && s.tracking,
    // NAVİGASYON yerel veriyle (alış koordinatı) çalışır: bağlantıdan bağımsız, yükleniyorken de etkin.
    navigateEnabled: !!ride,
    serverActionsEnabled: !!ride && !offline && synced && s.rideAction == null,
    callStandEnabled: !!ride && ride.stand.phone.trim().length > 0,
    completing: s.rideAction === 'completing',
    cancelling: s.rideAction === 'cancelling',
  };
}
