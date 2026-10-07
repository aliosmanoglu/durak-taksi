// İstemci varlık durumu (tasarım 3.1). Saf veri; React Native'e bağımlı değildir.
import type { DriverStatus, OfflineReason } from '@duraknet/shared';
import {
  FIX_GOOD_ACCURACY_M,
  FIX_STALE_MS,
  GO_ONLINE_MAX_ACCURACY_M,
  LOCATION_MIN_SEND_GAP_MS,
} from '../constants';

export type Conn = 'idle' | 'connecting' | 'connected' | 'disconnected';
export type ServerStatus = 'unknown' | DriverStatus;
/**
 * Bekleyen kullanıcı/sistem isteği. `reactivating` = S4 otomatik yeniden aktif olma sürüyor
 * (tasarımdaki "Yeniden aktif olunuyor…" varyantı).
 */
export type Intent = 'none' | 'goingOnline' | 'goingOffline' | 'offlinePending' | 'reactivating';
export type Perm = 'undetermined' | 'denied' | 'deniedForever' | 'foreground' | 'background';
export type Gps = 'on' | 'off' | 'unknown';

/** Son konum düzeltmesi. Koordinatlar yalnızca bellekte tutulur; ekrana ve loglara yazılmaz. */
export type Fix = { at: number; lat: number; lng: number; accuracy: number | null; heading?: number };

export type ReactivateFailReason = 'gps' | 'perm' | 'fix' | 'server';

/** Ana ekrandaki kapatılabilir bildirim kartı. */
export type Notice =
  | { kind: 'reactivated' }
  | { kind: 'reactivateFailed'; reason: ReactivateFailReason }
  | { kind: 'droppedLong' }
  /** Otomatik yeniden aktif olma üst sınırı aşıldı (10 dk içinde 3). */
  | { kind: 'droppedRepeated' }
  | { kind: 'dropped' }
  | { kind: 'stillActive' }
  | { kind: 'forcedOfflineNoPerm' };

export type PresenceState = {
  conn: Conn;
  /** Kopukluğun başladığı an (bağlanınca sıfırlanır). */
  disconnectedAt: number | null;
  server: ServerStatus;
  offlineReason?: OfflineReason;
  /** Bu socket bağlantısında görülen en büyük `presenceVersion`; her yeni bağlantıda `null`. */
  presenceVersion: number | null;
  intent: Intent;
  /** `goingOnline` alt adımı: konum alınıyor mu, ack mı bekleniyor. */
  goOnlineStep: 'fix' | 'ack' | null;
  perm: Perm;
  gps: Gps;
  fix: Fix | null;
  /** Bağlıyken yapılan son `driver_location_update` emit'i. */
  lastSentAt: number | null;
  /**
   * Konum görevinden gelen son NORMAL gönderim (aktif olunca yapılan zorunlu ilk gönderim sayılmaz). S4'teki
   * 10 dk ölçütü buna göre hesaplanır; böylece her otomatik aktif olma ölçütü kendiliğinden sıfırlamaz. Kalıcıdır.
   */
  lastRoutineSentAt: number | null;
  /** Son otomatik yeniden aktif olma zamanları (üst sınır için). */
  autoReactivations: number[];
  /** Şoförün son bilinçli seçimi (AKTİF OL → true, PASİF OL / çıkış → false). Kalıcıdır. */
  wantsOnline: boolean;
  /** Konum görevi çalışıyor mu (bilgi amaçlı; gerçek durumu servis tutar). */
  tracking: boolean;
  notice: Notice | null;
  /** Taze `session_sync` bekleniyor (başlıkta "Güncelleniyor…"). */
  syncPending: boolean;
  /** Aktif/Pasif düğmesi bu zamana kadar kilitli (çift dokunma). */
  toggleLockedUntil: number;
};

export const initialPresence = (persisted?: {
  wantsOnline?: boolean;
  lastRoutineSentAt?: number | null;
}): PresenceState => ({
  conn: 'idle',
  disconnectedAt: null,
  server: 'unknown',
  presenceVersion: null,
  intent: 'none',
  goOnlineStep: null,
  perm: 'undetermined',
  gps: 'unknown',
  fix: null,
  lastSentAt: null,
  lastRoutineSentAt: persisted?.lastRoutineSentAt ?? null,
  autoReactivations: [],
  wantsOnline: persisted?.wantsOnline ?? false,
  tracking: false,
  notice: null,
  syncPending: false,
  toggleLockedUntil: 0,
});

export const hasLocationPermission = (p: Perm) => p === 'foreground' || p === 'background';

/** Sunucu durumu konum paylaşımı gerektiriyor mu (kural 3.4-1). */
export const serverNeedsLocation = (s: ServerStatus) => s === 'available' || s === 'busy';

export type FixQuality = 'none' | 'good' | 'poor' | 'stale';

/** Fix kalitesi. `ignoreAge`: pasifken son bilinen konum yaşından bağımsız değerlendirilir. */
export function fixQuality(fix: Fix | null, now: number, ignoreAge = false): FixQuality {
  if (!fix) return 'none';
  if (!ignoreAge && now - fix.at > FIX_STALE_MS) return 'stale';
  if (fix.accuracy == null || fix.accuracy > FIX_GOOD_ACCURACY_M) return 'poor';
  return 'good';
}

/** `driver_go_online` için eldeki fix yeterli mi (≤ 30 sn, ≤ 100 m). */
export function fixUsableForGoOnline(fix: Fix | null, now: number): fix is Fix {
  return (
    !!fix &&
    now - fix.at <= FIX_STALE_MS &&
    fix.accuracy != null &&
    fix.accuracy <= GO_ONLINE_MAX_ACCURACY_M
  );
}

/** Log için doğruluk kovası (tasarım Bölüm 8: ham konum yerine). */
export function accuracyBucket(accuracy: number | null | undefined): '≤50' | '≤100' | '>100' | 'yok' {
  if (accuracy == null) return 'yok';
  if (accuracy <= 50) return '≤50';
  if (accuracy <= 100) return '≤100';
  return '>100';
}

/**
 * Konum gönderilebilir mi (kural 3.4-1): yalnızca sunucu `available`/`busy` iken, bağlıyken ve bağlantının
 * `session_sync`'i alınmışken. Pasif olunurken gönderilmez. İstemci tarafı alt sınır 3 sn (`force` hariç).
 */
export function canSendLocation(s: PresenceState, now: number, force = false): boolean {
  if (!serverNeedsLocation(s.server)) return false;
  if (s.conn !== 'connected' || s.syncPending) return false;
  if (s.intent === 'goingOffline' || s.intent === 'offlinePending') return false;
  if (!force && s.lastSentAt != null && now - s.lastSentAt < LOCATION_MIN_SEND_GAP_MS) return false;
  return true;
}

/** Başarılı konum gönderiminin yaması. `routine`: görevden gelen normal gönderim (zorunlu ilk gönderim değil). */
export function onLocationSent(now: number, routine: boolean): Partial<PresenceState> {
  return routine ? { lastSentAt: now, lastRoutineSentAt: now } : { lastSentAt: now };
}
