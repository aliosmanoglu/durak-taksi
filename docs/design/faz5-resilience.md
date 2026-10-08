# Faz 5 — Push & Dayanıklılık: tasarım

Kaynak: CLAUDE.md Bölüm 8 (Faz 5), repo taraması (dal `faz-5-resilience`). Karar: Faz 5'e cihaz testinden önce geçildi; Expo credentials mevcut, eşikler makul varsayılanlarla **ortam değişkeniyle yapılandırılabilir**. Kabul kriterinin cihaz kısmı (kapalı uygulamada bildirim) development build gerektirir ve açık borçtur.

**Kabul kriteri:** (1) Uygulama kapalıyken şoför bildirim alır, açınca çağrıyı görür. (2) Bir API node'u öldürülünce istemciler diğer node'a bağlanıp `session_sync` ile devam eder.
Backend tarafında entegrasyon testiyle kanıtlanacaklar: push gönderim hattı (sahte `PushSender` ile), token yaşam döngüsü, limitler, idempotency, metrikler, node kaybı.

## 1. Push

**Karar:** Push, `ride_requested` ile **paralel** ve **yalnızca bildirimdir**; kabul her zaman `ride_accept` ile yapılır (CLAUDE.md Bölüm 6). Push içeriğine güvenilmez.

- **Token kaydı:** `PUT /me/push-token` `{ token }` ve `DELETE /me/push-token` (yalnızca `driver`). Token biçimi `ExponentPushToken[...]` / `ExpoPushToken[...]` (zod). Şoför başına tek token (tek cihaz modeli, bkz. kimlik mimarisi). Depolama: `drivers.push_token` (kolon var); **yeni migration:** `push_token` üzerinde kısmi UNIQUE indeks (NULL olmayanlar). `PUT`, aynı token başka şoförde kayıtlıysa onu aynı transaction'da NULL'lar (telefon el değiştirirse eski hesaba bildirim gitmesin).
- **Temizlik:** `/auth/logout`, askıya alma, `DELETE /me/push-token` ve Expo'dan `DeviceNotRegistered` gelince token NULL'lanır.
- **Gönderim noktası:** worker `dispatch.ts` içinde `emitter.toDriver(... rideRequested ...)` döngüsünden sonra, `added` listesindeki şoförler için tek toplu PG sorgusu (`push_token IS NOT NULL`) → `PushSender.send(...)`. Socket ve push birbirini beklemez; push hatası dispatch'i bozmaz (loglanır, metrik sayılır).
- **`PushSender` arayüzü** (worker, `apps/worker/src/push/`): Expo uygulaması (`expo-server-sdk`, 100'lük `chunkPushNotifications`, `EXPO_ACCESS_TOKEN` isteğe bağlı) ve testler için sahte uygulama. Ticket hatası `DeviceNotRegistered` → token temizle. Makbuzlar (receipt) 15 dk sonra BullMQ gecikmeli job'ıyla kontrol edilir (`push-receipts`), aynı hata türü token temizler.
- **İçerik:** başlık "Yeni çağrı", gövde "{durak adı} · {mesafe}" (adres ve not kilit ekranında görünmesin); `data: { type: 'ride_requested', rideId }`; Android kanalı `rides` (HIGH, ses), `priority: high`, `ttl` varsayılan 300 sn (açık çağrı süresizdir ama eski bildirim işe yaramaz), `sound: default`. Yan bildirim: `account_suspended` (faz3 Q5); API askıya almada token'ı iş verisine alıp BullMQ `push` job'ı atar (API'ye `expo-server-sdk` eklenmez), ardından token temizlenir.
- **Mobil:** izin verildikten ve giriş yapıldıktan sonra `getExpoPushTokenAsync({ projectId })` → `PUT`; token değişimi için `addPushTokenListener`; çıkışta `DELETE`. Yanıt dinleyicisi + `getLastNotificationResponseAsync` bildirime dokununca `session_sync_request` atar ve `/requests` ekranına gider. Ön plandayken `ride_requested` push'u gösterilmez (socket zaten ekrana getirir; mevcut `setNotificationHandler` buna göre genişletilir). Android kanalı `rides` oluşturulur.
- **Bilinen sınır:** worker şoförün uygulamasının ön planda olup olmadığını bilmez; bu yüzden push **her zaman** gönderilir, ön plan bastırma istemcidedir.

## 2. Hız sınırları (varsayılanlar, hepsi env ile ayarlanabilir)

Mevcut kimlik limitleri (`auth/limits.ts`) aynen kalır. Eklenenler:

| Kapsam | Varsayılan | Not |
|---|---|---|
| REST genel (IP) | 600/dk | `/health`, `/ready`, `/metrics` hariç; `trustProxy` doğru olmalı |
| REST kimlikli (hesap) | 240/dk | `/me`, `/stands/*`, `/admin/*`, `/me/push-token` |
| `PUT /me/push-token` | 20/10 dk, hesap | |
| Socket handshake (IP) | 60/dk | bağlantı fırtınası koruması |
| `ride_create` (durak) | 10/dk | |
| `ride_accept` (şoför) | 30/dk | her çağrıda PG sorgusu yaptığı için |
| `ride_decline` | 60/dk | |
| `ride_cancel`, `ride_complete` | 30/dk | |
| `ride_driver_cancel` | 10/dk | |
| `driver_go_online` / `driver_go_offline` | 20/dk | |
| `session_sync_request` | 20/dk | |
| `auth_refresh` (socket) | 10/dk | |

- Socket limiti Redis tabanlı sabit pencere (tek Lua `INCR`+`PEXPIRE`), anahtar `dn:ratelimit:ev:{olay}:{hesapId}`; aşılırsa ack `RATE_LIMITED` (ErrorCode zaten var). `driver_location_update` kendi 1/sn throttle'ında kalır. **Redis hatasında fail-open** (loglanır, `duraknet_rate_limit_errors_total`): limitleyici kullanılabilirliği düşürmesin.
- Socket.IO `maxHttpBufferSize` 100 KB.

## 3. Idempotency

- **`ride_create`:** `rideCreateSchema`'ya **isteğe bağlı** `clientRequestId` (uuid). Migration: `rides.client_request_id uuid` + UNIQUE `(stand_id, client_request_id)` (NULL hariç). `INSERT ... ON CONFLICT DO NOTHING`; çakışmada mevcut ride'ın `{ rideId, shortCode }`'u ack'e döner, yeni arama başlatılmaz (ilk isteğin zinciri uzlaştırıcıda zaten güvence altında). Panel her form gönderiminde bir `clientRequestId` üretir; ack `TIMEOUT` olursa **aynı** kimlikle yeniden dener, form temizlenince kimlik yenilenir.
- **Terminal geçiş tekrarları** (ack kaybı sonrası istemci yeniden denemesi) artık hata yerine **aynı sonucu** döner:
  - `ride_complete` ride zaten `completed` ise (ve çağıran yetkili tarafsa) → `ok` + güncel snapshot.
  - `ride_cancel` ride zaten `cancelled` ise (aynı durak) → `ok`.
  - `ride_driver_cancel`: ride artık o şoföre ait değil ve şoför `excluded` kümesindeyse → `ok`.
  - `ride_accept`: ride zaten bu şoföre `matched` ise → `ok` + snapshot (mevcut davranış doğrulanacak).
  - Sürüm uyuşmazlığı yalnızca durum hedefte DEĞİLSE `VERSION_CONFLICT` döner. Yabancı hesap hâlâ `FORBIDDEN`/`NOT_FOUND` alır (yetki kontrolü sonuç kontrolünden önce).
- Zaten idempotent olanlar korunur: `ride_decline`, BullMQ job id'leri, `driver_go_online`, sweeper.

## 4. Metrikler ve sağlık

- `prom-client`. **API** `GET /metrics`: işlem metrikleri + `duraknet_location_update_seconds` (histogram, `driver_location_update` handler süresi; Faz 2'den açık p95 ölçümü), `duraknet_rides_total{event}` (created/matched/completed/cancelled), `duraknet_match_seconds` (`matched_at - searching_at`, kabulde gözlenir; Faz 6 hedefi < 60 sn), `duraknet_socket_connections`, `duraknet_rate_limited_total{scope}`, `duraknet_rate_limit_errors_total`, `duraknet_push_total{result}` (worker'da). `METRICS_TOKEN` tanımlıysa `Authorization: Bearer` zorunlu; **üretimde tanımsızsa uç kapalıdır** (404), geliştirmede açıktır.
- **Worker** küçük bir HTTP sunucusu açar (`WORKER_HTTP_PORT`, varsayılan 9102): `/health`, `/ready` (PG + Redis + son sweeper tikinin tazeliği; CLAUDE.md "bilinen sınır (2)" kapanır), `/metrics` (aynı token kuralı). Küme geneli gauge'lar **yalnızca worker'da** üretilir (çoklu replikada çift sayım olmasın): `duraknet_drivers_active{status}` (available = `ZCARD` GEO, online = `ZCARD` heartbeat, busy = fark), `duraknet_open_rides{status}` (PG sayımı, 10 sn önbellek).
- `/ready` kapanış başlayınca 503 döner (bkz. 5).

## 5. Dayanıklılık: API kapanışı ve node kaybı

- **Graceful shutdown (`server.ts`)**: tekrar girişe karşı `shuttingDown` bayrağı → `/ready` 503 → `SHUTDOWN_DRAIN_MS` (varsayılan 5000) bekle (LB çıkarsın) → `httpServer.close()` → `io.close()` (istemciler kopar ve diğer node'a bağlanır) → kaynakları kapat; `SHUTDOWN_TIMEOUT_MS` (varsayılan 15000) sonunda zorla çık (worker'daki 10 sn desenine paralel).
- **Node kaybı kanıtı (test):** aynı PG + Redis'e bağlı iki API örneği; istemci A'ya bağlıyken eşleşmiş ride; A kapatılır (graceful ve sert); istemci B'ye bağlanır → `session_sync.activeRide` ve konum doğru; A kapalıyken B'de kabul/tamamla olayları diğer node'daki bağlı istemcilere adapter ile ulaşır; sweeper/presence etkilenmez. İstemci yeniden bağlanma kodu (mobil `lib/realtime.ts`, panel `connection-core.ts`) zaten var; değişiklik beklenmiyor, yalnızca test.
- Redis HA / cluster bu fazın kapsamı dışıdır (CLAUDE.md: tek primary + replika, `noeviction`/`volatile-*`).

## 6. Paketler ve sözleşme (`packages/shared`)

- `pushTokenSchema` (`{ token }`), `rideCreateSchema`'ya `clientRequestId?`, `PUSH` sabitleri (`PUSH_DATA_TYPES`, kanal adı `rides`, TTL varsayılanı), limit sabitleri tek yerde (`RATE_LIMITS`), `account_suspended` push veri tipi.
- CLAUDE.md Bölüm 6'ya: `PUT/DELETE /me/push-token`, `ride_create.clientRequestId`, idempotent tekrar semantiği, `RATE_LIMITED` ack'i, `/metrics`.

## 7. İş bölümü ve sıra

1. Sözleşme (`packages/shared`) + migration → onay noktası yok (varsayılanlarla ilerleniyor).
2. Paralel: `backend-gelistirici` (push hattı, token uçları, limitler, idempotency, metrikler, worker HTTP, shutdown) ve `tester` (her madde için entegrasyon testi; sahte `PushSender`; iki node'lu kayıp testi). `frontend-gelistirici` (mobil push kaydı/dokunma/ön plan bastırma/kanal; panel `clientRequestId` + yeniden deneme).
3. `kalite-kontrolcu` denetimi.
4. Cihaz borcu (kapalı uygulamada gerçek push, S5/S6, Faz 3/4 senaryoları) development build ile kapatılır.

## 8. Varsayılan değerler (özet, env adları)

`PUSH_ENABLED=true`, `EXPO_ACCESS_TOKEN` (isteğe bağlı), `PUSH_TTL_S=300`, `PUSH_RECEIPT_DELAY_S=900`, `RATE_LIMIT_*` (yukarıdaki tablo), `METRICS_TOKEN`, `WORKER_HTTP_PORT=9102`, `SHUTDOWN_DRAIN_MS=5000`, `SHUTDOWN_TIMEOUT_MS=15000`.
