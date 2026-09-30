// İstemci zamanlamaları (docs/design/driver-mobile-faz2.md). Sunucu eşikleri @duraknet/shared → PRESENCE.
import { PRESENCE } from '@duraknet/shared';

/** Ack'li her emit bu süre içinde yanıt almazsa "sonuç bilinmiyor" sayılır (kural 3.4-3). */
export const ACK_TIMEOUT_MS = 10_000;
/** REST istek zaman aşımı (E1: ağ hatası / zaman aşımı 15 sn). */
export const HTTP_TIMEOUT_MS = 15_000;

/** Konum görevi aralığı (E5 "Konum görevi parametreleri"). */
export const LOCATION_INTERVAL_MS = 4_000;
/** İstemci tarafı gönderim alt sınırı: iOS `timeInterval`'ı dikkate almaz; sunucu 1/sn'den fazlasını zaten düşürür. */
export const LOCATION_MIN_SEND_GAP_MS = 3_000;

/** Fix doğruluk eşikleri. */
export const FIX_GOOD_ACCURACY_M = 50;
/** `driver_go_online` için kabul edilen en kötü doğruluk ve en eski fix (E4 AKTİF OL adım 4). */
export const GO_ONLINE_MAX_ACCURACY_M = 100;
export const FIX_STALE_MS = 30_000;
export const GO_ONLINE_FIX_TIMEOUT_MS = 10_000;

/** Kopukluğun ilk 15 sn'si sessizdir (3.2). */
export const DISCONNECT_QUIET_MS = 15_000;
/** Sweeper eşiği: son konumdan bu kadar sonra şoför muhtemelen pasife düşmüştür. */
export const PROBABLY_OFFLINE_MS = PRESENCE.HEARTBEAT_STALE_MS;
/** Son gönderim bundan eskiyse "Konum gönderilemiyor" (C4). */
export const LAST_SENT_WARN_MS = 20_000;

/** S4: son başarılı konum gönderiminden yeniden bağlanmaya bu süreden fazla geçtiyse otomatik aktif olunmaz. */
export const AUTO_REACTIVATE_MAX_GAP_MS = 10 * 60_000;
/** Otomatik yeniden aktif olma üst sınırı: bu pencere içinde en çok bu kadar (saat kayması vb. döngülere karşı). */
export const AUTO_REACTIVATE_WINDOW_MS = 10 * 60_000;
export const AUTO_REACTIVATE_MAX_COUNT = 3;

/** Bağlandıktan sonra bu süre içinde session_sync gelmezse session_sync_request gönderilir. */
export const SYNC_WATCH_FIRST_MS = 5_000;

/** Arka planda bundan uzun kalındıysa ön plana gelişte `session_sync_request` gönderilir. */
export const BACKGROUND_RESYNC_MS = 30_000;

/** Aktif/Pasif geçişinden sonra çift dokunmayı önleyen kilit. */
export const TOGGLE_LOCK_MS = 1_500;

/** Access token süresinin bu oranında proaktif yenileme yapılır. */
export const PROACTIVE_REFRESH_RATIO = 0.8;
/** `auth_expired` sonrası refresh ağ hatası verirse tekrar aralığı (sunucu 30 sn bekler). */
export const AUTH_EXPIRED_RETRY_MS = 5_000;
/** Refresh üstel geri çekilme: 2, 4, 8 … en çok 30 sn. */
export const REFRESH_BACKOFF_BASE_MS = 2_000;
export const REFRESH_BACKOFF_MAX_MS = 30_000;
/** 429'da `Retry-After` yoksa giriş düğmesinin kilit süresi. */
export const RATE_LIMIT_FALLBACK_MS = 60_000;

/** Geçici kısa bildirimlerin (toast) ekranda kalma süresi. */
export const TOAST_MS = 4_000;
/** Kalıcı `lastSentAt` en fazla bu aralıkla diske yazılır (soğuk açılışta S4 kuralı için). */
export const LAST_SENT_PERSIST_EVERY_MS = 15_000;
