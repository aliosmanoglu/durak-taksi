# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Komutlar

pnpm workspace monorepo (pnpm 12; Node ≥ 20 çalışma zamanı için, **testler Node ≥ 22.19 ister**: `testcontainers` → `undici@8`; CI ve yerel geliştirme Node 24). Kökten çalıştırılır:

```bash
pnpm install
pnpm lint          # eslint
pnpm typecheck     # tüm workspace'lerde tsc --noEmit
pnpm test          # tüm workspace'lerde vitest
pnpm build         # api ve worker → dist/ (tsup)
pnpm dev:api       # tsx watch; .env gerekir (bkz. .env.example)
pnpm migrate:up    # node-pg-migrate; DATABASE_URL gerekir
```

Tek workspace / tek test:
```bash
pnpm --filter @duraknet/api test
pnpm --filter @duraknet/api exec vitest run test/health.test.ts
pnpm --filter @duraknet/api exec vitest run -t "503 döner"
pnpm --filter @duraknet/api exec vitest run --project unit          # Docker gerektirmez
pnpm --filter @duraknet/api exec vitest run --project integration   # Docker gerekir
pnpm --filter @duraknet/worker test                                  # sweeper; Docker gerekir (yalnızca Redis)
pnpm dev:worker                                                      # veya: pnpm --filter @duraknet/worker dev
```

Şoför uygulaması (`apps/driver-mobile`, Expo):
```bash
pnpm --filter @duraknet/driver-mobile test        # vitest (Docker gerektirmez)
pnpm --filter @duraknet/driver-mobile lint
pnpm --filter @duraknet/driver-mobile typecheck
pnpm --filter @duraknet/driver-mobile start       # expo start
```
- API adresi derleme zamanında `EXPO_PUBLIC_API_URL` ile verilir (`apps/driver-mobile/.env.example`; emülatörde `http://10.0.2.2:3000`, gerçek cihazda LAN IP'si).
- Arka plan konumu (`expo-location` + `expo-task-manager`) Expo Go'da çalışmaz; **development build** gerekir (`pnpm --filter @duraknet/driver-mobile android` / `ios`).

Faz 2 yük betiği (CI dışı; iki API node'u aynı PG + Redis'e bağlı çalışırken): `pnpm --filter @duraknet/api exec tsx --env-file=../../.env scripts/loadtest-presence.ts` — kullanım ve ölçüm sınırları dosyanın başında.

- **Testler:** `apps/api/vitest.config.ts` iki proje tanımlar. `unit`: `test/**/*.test.ts`. `integration`: `test/**/*.integration.test.ts`; `test/helpers/containers.ts` (globalSetup) çalıştırma başına **bir** PostGIS + Redis konteyner çifti başlatır, migration'ı node-pg-migrate `runner` ile uygular ve adresleri `inject` ile verir. `test/helpers/app.ts` → `startTestApp()` uygulamayı server.ts ile aynı sırada kurar. Testler birbirinden bağımsızdır: her test benzersiz telefon/plaka/kullanıcı adıyla kendi hesabını açar; IP bazlı limitlere takılmamak için istekler rastgele `X-Forwarded-For` taşır (`trustProxy: 'loopback'`).
- **Yerel geliştirme:** `docker compose up -d` → PostGIS **5433**, Redis **6380** (makinedeki yerel PG 5432 ve eski Redis 6379 ile çakışmasın diye). Testler bu servisleri kullanmaz. Windows'ta Git Bash'te `docker` PATH'te olmayabilir: `/c/Program Files/Docker/Docker/resources/bin`.

- `packages/shared` TS kaynağı olarak tüketilir (`exports` → `src/index.ts`); ayrı build adımı yoktur. api/worker `tsup` ile derlenirken `@duraknet/shared` çıktıya gömülür (`tsup.config.ts` → `noExternal`).
- TypeScript **5.x**'e sabitlidir: `typescript-eslint` henüz TS 7'yi desteklemiyor.
- pnpm bağımlılık build script'lerini engeller; izinliler `pnpm-workspace.yaml` → `allowBuilds` altındadır.
- `docker compose up` PostGIS + Redis 7'yi başlatır. Docker yoksa PG (PostGIS'li) ve **Redis ≥ 6.2** (GEOSEARCH için) elle sağlanmalıdır. Not: testcontainers (Faz 2+ entegrasyon testleri) Docker gerektirir.

## Mevcut durum

**Faz 1 (kimlik & temel veri) tamamlandı; kabul kriteri gerçek PostGIS + Redis üzerinde entegrasyon testleriyle doğrulandı** (`apps/api/test/auth.integration.test.ts`, `rate-limit.integration.test.ts`). Test edilmeyenler: `auth_expired` zamanlayıcısı, handshake/askıya alma yarışı, hesap bazlı dışındaki hız sınırları.

**Faz 2 backend'i (şoför varlığı & konum) tamamlandı; mobil kısmı yazıldı ama gerçek cihazda doğrulanmadı.** Testler: `apps/api/test/presence.integration.test.ts`, `presence-sync.integration.test.ts`, `session-sync-failure.integration.test.ts`, `apps/worker/test/sweeper.integration.test.ts`. Kabul kriteri durumu:
- "Bağlantısı düşen şoför ≤ 75 sn içinde GEO'dan çıkar": doğrulandı (eşik 60 sn + tarama 10 sn = en kötü 70 sn; testte simüle saatle ve kısaltılmış eşiklerle gerçek zamanda).
- "500 şoför / 2 node / p95 < 50 ms": **kesin ölçülmedi.** Yerel yük testinde (2 node, 500 şoför, 60 sn) 9 783 güncellemede 0 kayıp; gönderimden Redis'te görünmeye p95 110 ms (100 ms örnekleme dahil üst sınır). Sunucu içi süre ölçülmüyor; kesin p95 Faz 5'te `driver_location_update` handler'ına `prom-client` histogramı eklenerek alınacak.
- Mobil (aktif/pasif toggle, arka plan konumu, yeniden bağlanma, `session_sync` karşılaştırması): `apps/driver-mobile`'da yapıldı (tasarım: `docs/design/driver-mobile-faz2.md`); **cihazda doğrulanmadı**. Açık: S5 (iOS'ta duran araçta arka plan konumu seyrekleşip 60 sn eşiği aşılabilir), S6 (yalnızca ön plan izniyle konum servisinin arka planda sürüp sürmediği) — ikisi de development build'le gerçek cihazda ölçülmeli. `apps/stand-panel` hâlâ yer tutucudur.

**Faz 3 (çağrı & FCFS eşleşme) yazıldı (dal `faz-3-dispatch`); kabul kriteri entegrasyon testiyle doğrulandı, panel ve mobil ekranlar tarayıcıda/cihazda doğrulanmadı.** Backend: `apps/api/src/rides/**` (state machine, Lua kabul, servis), `apps/worker/src/rides/**` (dispatch dalgaları, hatırlatma, yakındaki şoförler, uzlaştırıcı). Testler: `ride-accept-race` (50 şoför → tam 1 eşleşme), `dispatch`, `ride-lifecycle`, `ride-session`, `ride-race-*`, `ride-reconcile`, `ride-nearby`. API entegrasyon dosyaları **seri** koşar (uzlaştırıcı paylaşılan Redis'i tarar). Tasarım: `docs/design/faz3-dispatch.md` (onaylı varsayılanlarla; E-5 `/stand session_sync_request` ve E-6 `serverTime`/`serverNow` sözleşmeye eklendi). Panel: `apps/stand-panel` (React 18 + Vite; `pnpm --filter @duraknet/stand-panel dev|test|build`, `VITE_API_URL`). Mobil çağrı akışı: `apps/driver-mobile` (D1–D3; yeni native modüller `expo-audio`/`expo-keep-awake` → yeni development build gerekir). Açık: D5 (askıya alınan durağın açık çağrıları), `ride_taken`'a `version` eklenmesi, `ride_accept` ack'inde `presenceVersion`, `apps/worker`/`realtime.ts`'de `'driver_suspended'` literali (shared sabitine çevrilecek), panel gerçek zamanlı katmanı testsiz, Nominatim/KVKK kararı (pilot öncesi).

**Açık PR'lar:** #1 (`faz-2-presence` → `main`, Faz 2 backend) ve #2 (`faz-2-mobile` → `faz-2-presence`, mobil + S1–S4 sözleşmesi). Önce #1 birleşir, sonra #2'nin hedefi `main`'e çevrilir. Mobil tasarım kararları (S1–S4; otomatik yeniden aktif olma: `wantsOnline` iken, son normal konumdan ≤ 10 dk ve 10 dk'da en çok 3 kez) `docs/design/driver-mobile-faz2.md` Bölüm 9'dadır; onaylı görsel tasarım: https://claude.ai/artifact/CXRYFx5ubciRnfWmgJDkkg. Mobil saf mantık `apps/driver-mobile/src/lib/**` (vitest), RN/Expo katmanı `src/services/**` (testsiz, yalnızca typecheck + `expo export`).

**Sıradaki adımlar:** (1) Faz 2 mobilin gerçek cihaz doğrulaması (S5, S6; bkz. `docs/design/driver-mobile-device-test.md`). (2) Faz 3 panel + mobilin yerelde/cihazda uçtan uca denemesi, ardından PR (#1 ve #2 birleştikten sonra hedef `main`). Çalışma düzeni: sözleşme (`packages/shared`) önce yazılır, ardından `backend-gelistirici` ve `tester` paralel çalışır, sonunda `kalite-kontrolcu` denetler. PR açmak için `gh` gerekir (yerelde `C:\Program Files\GitHub CLI\gh.exe`; terminal PATH'i yenilemediyse tam yolla çağır).

### Şoför varlığı (`apps/api/src/presence/`, `apps/worker/src/sweeper.ts`)
- Redis anahtarları ve zamanlamalar tek yerde: `packages/shared/src/redis.ts` (`redisKeys`, `PRESENCE`). Konum PG'ye yazılmaz.
- Durum okuyup yazan her işlem (online, offline, konum, sweep) **Lua ile atomiktir**; "status oku → MULTI" kalıbı kullanılmaz (arada gelen offline/sweep şoförü GEO'ya geri yazar). Heartbeat skoru ve `updatedAt` sunucu saatiyle yazılır; istemcinin `ts`'ine güvenilmez.
- Konum throttle'ı Redis anahtarının TTL'ine dayanır (`SET NX PX`); offline şoförün güncellemesi throttle tüketmez. Offline şoförden konum gelirse sunucu `session_sync` (`driverStatus: 'offline'`) gönderir: sweeper'ın düşürdüğü ama socket'i bağlı kalan şoför "Aktif" görünüp çağrı alamaz halde kalmaz.
- Socket kopması presence'a dokunmaz (mobil ağ toleransı); temizliği sweeper yapar. Şoför askıya alınınca veya `/auth/logout`'ta `disconnectAccount` → `forceOffline` (GEO'dan anında çıkar). `driver_go_online` Lua'dan sonra hesap durumunu tekrar kontrol eder (askıya alma yarışı).
- **`offlineReason`** hash alanı: `driver_go_offline` → `user`, sweeper → `stale_heartbeat`, `forceOffline` → `forced`; `driver_go_online` siler. Hash yoksa veya alan yoksa (eski veri) `session_sync` `not_online` taşır. Hash alan adları `DRIVER_HASH` (shared `redis.ts`).
- **`presenceVersion`** hash'te değil, ayrı ve TTL'siz `dn:driver:{id}:pv` anahtarında tutulur (`redisKeys.driverPresenceVersion`). Her durum geçişinde (online, offline, force, sweep) aynı Lua içinde `max(redisNowMs + 1, eski + 1)` yazılır (`PRESENCE_VERSION_LUA`, API ve worker ortak; Redis `TIME`; anahtar KEYS ile verilir). `go_online` `busy` dönerse, konum güncellemesi ve reddedilen `go_offline` sürümü değiştirmez. Anahtar yoksa okunan sürüm Redis'in o anki zamanıdır; durum/sebep (HMGET) ve sürüm aynı Lua okumasında alınır. Hash silinse ya da süresi dolsa bile sürüm geri gitmez (art arda hızlı geçişlerde saatin önüne geçmiş olsa da). Sweeper hash'i olmayan şoför için pv yazmaz.
- **`session_sync_request`** (`{}` → ack `DriverSessionSync`) bağlıyken aynı gövdeyi döner; offline şoförün konum güncellemesine giden `session_sync` sebep ve sürümü konum Lua'sından alır (ek round-trip yok).
- `createRealtime` `presence`'ı zorunlu alır (`null` yalnızca kimlik testleri içindir); `createApp`'te `auth` verildiğinde zorunludur.
- **`socket.data` yalnızca JSON'a çevrilebilir veri tutar** (şu an sadece `auth` claim'leri): redis-adapter onu node'lar arası `fetchSockets` yanıtında serileştirir. Zamanlayıcı gibi nesneler socket üzerinde Symbol anahtarıyla tutulur (`realtime.ts` → `timersOf`); test 7c bunu korur.
- Sweeper BullMQ job scheduler'ıyla (`presence-sweep`) çalışır; çok replikada her tikte tek job üretilir, Lua idempotenttir. Worker ortamı: `REDIS_URL`, `HEARTBEAT_STALE_MS`, `SWEEP_EVERY_MS`.
- `disconnectAccount` redis-adapter ile tüm node'lara ulaşır ama yerelde bile asenkrondur (bir Pub/Sub turu); askıya almanın etkisi buna bağlı değildir (DB kontrolü + `forceOffline`).
- **Bilinen sınırlar:** (1) Sweeper tek taramada en eski 5 000 adayı okur; stale ama `busy` şoförler heartbeat'ten silinmediği için 5 000'i aşarlarsa available şoförler taranamaz (pilotta olası değil; çözüm: imleçli okuma veya busy şoförleri ayrı tutmak). (2) Worker'da health check yok. (3) **Faz 3 kararı (verildi):** `busy` şoför için: (a) **çıkış** (`/auth/logout`, socket kopması, sweeper) eşleşmiş ride'ı iptal etmez; ride `matched`, şoför `busy` kalır, şoför yeniden girince `session_sync.activeRide` ile devam eder. `forceOffline` logout'ta `busy` şoförü düşürmez. (b) **Askıya alma** eşleşmeyi bozar: ride `searching`'e döner (şoför `excluded`, `driver_id` boşalır, durağa `ride_driver_cancelled`), şoför `forceOffline` ile tamamen offline olur. (c) Eşleşmiş ride'ı **hem şoför hem durak** `completed` yapabilir (durak için yeni `ride_complete` event'i, `/stand`); iptal yine yalnızca durakta (`matched`→`cancelled`) ya da şoförün bilinçli `ride_driver_cancel`'ında (→ `searching`). Terk edilmiş `matched` ride'ı durak iptal/tamamlama ile kapatır.

### Uzlaştırıcı (`apps/worker/src/rides/reconcile.ts`)
BullMQ scheduler (`ride-reconcile`, `RECONCILE_EVERY_S=30`, `RECONCILE_MIN_AGE_S=30`, `RECONCILE_ORPHAN_AGE_S=60`, worker `REMINDER_FIRST_SEC`). PG kazanır; her kural idempotenttir. Yetim `created` ride'ı `searching`'e alır; job'sız `searching` ride'ın dispatch/hatırlatma zincirini yeniden kurar (çağrıyı iptal etmez); ride hash'i `matched` ama PG `searching`, şoför hash'i `busy` ama PG'de `matched` ride'ı yok, PG'de `matched` ama şoför `suspended` durumlarını "iki turda da görülürse" (`dn:reconcile:suspect:*` işareti) onarır; yakın zamanda terminal olmuş ride'ın açık görünen hash'ini kapatır. API tarafında `mirror`/rollback/`startSearch` sınırlı yeniden denenir; kabul PG UPDATE'i şoför hesabının `approved` olmasını da şart koşar.

### Kimlik doğrulama mimarisi (`apps/api/src/auth/`)
- Üç rol: `driver`, `stand`, `admin`. Kimlik bilgileri `drivers` / `stands` tablolarında; ayrı `users` tablosu yok. Yönetici tek hesaptır ve DB'de değil ortam değişkenlerindedir (`ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `ADMIN_TOKEN_VERSION`); sabit id `'admin'`.
- JWT HS256, access ve refresh için **ayrı secret** + `typ` claim'i (biri diğerinin yerine geçemez). Claim'ler: `sub`, `role`, `tv` (= hesabın `token_version`'ı).
- `assertActiveSession` (service.ts) tek kapıdır: REST middleware'i, socket handshake'i ve `/auth/refresh` her seferinde DB'den durum + `token_version` kontrol eder. Bu yüzden askıya alma access token'ın 15 dk'sını beklemeden etkilidir. Askıya alma = `status='suspended'` + `token_version+1` tek UPDATE'te, ardından `realtime.disconnectAccount`.
- Yeni hesap `pending` açılır; `pending`/`suspended` hesap giriş yapamaz ve socket'e bağlanamaz. Durum hatası yalnızca şifre doğrulandıktan sonra döner.
- Refresh token rotasyonu yok (MVP): refresh token süresi dolana veya `token_version` artana kadar geçerli. `token_version`'ı artıran iki yol vardır: yönetici askıya alması ve **`POST /auth/logout`** (tüm cihazlardan çıkış). Cihaz bazlı oturum takibi bilinçli olarak yoktur: şoför ve durak tek telefondan çalışır; kayıp/çalıntı telefonda oturumu kapatmanın yolu başka cihazdan girip çıkış yapmaktır. Bir hesabı birden fazla cihazda ayrı ayrı yönetmek gerekirse Redis tabanlı oturum kaydı düşünülür (yeni tablo eklenmez).
- **Bağlı socket'in ömrü access token'la sınırlıdır:** süre dolunca `auth_expired` gönderilir, 30 sn içinde `auth_refresh` gelmezse bağlantı kesilir. `auth_refresh` hesap durumunu yeniden kontrol eder; yani askıya alınan hesabın socket'i `disconnectAccount` kaçırsa bile en geç ~15 dk içinde düşer. Handshake ile odaya katılma arasındaki askıya alma yarışı için katıldıktan sonra durum bir kez daha kontrol edilir.
- Şifreler `@node-rs/argon2` (argon2id; native derleme gerektirmez). Yönetici hash'i: `pnpm --filter @duraknet/api hash-password` (şifre stdin'den okunur).
- Kimlik uçlarında hız sınırları ayrıdır (`auth/limits.ts`): kayıt (IP), giriş (IP **ve** hesap bazlı, yalnızca başarısız denemeler sayılır), refresh (IP, gevşek: mobil CGNAT'ta çok şoför aynı IP'yi paylaşır). Üretimde Redis store; `createApp` varsayılanı bellek içidir ve yalnızca test içindir.
- **Express önce, Socket.io sonra bağlanır** (`createServer(app)` → `attach`). Ters sırada engine.io'nun polling istekleri Express'e de düşer ve süreç `ERR_HTTP_HEADERS_SENT` ile çöker; `test/socket-transport.test.ts` bunu korur.
- `TRUST_PROXY` ve `CORS_ORIGINS` dağıtım topolojisine göre ayarlanmalıdır (`.env.example`); üretimde `CORS_ORIGINS=*` açılışta reddedilir. Ana namespace (`/`) kapalıdır.
- `createApp(opts)` bağımlılıkları dışarıdan alır (`auth`, `realtime`, `authLimiters`); testler bunu gerçek DB ile kurar. `server.ts` üretim bağlantılarını kurar.

### REST uçları (Faz 1)
| Uç | Yetki | Not |
|---|---|---|
| `POST /auth/driver/register` | — | `pending` açılır |
| `POST /auth/stand/register` | — | `pending` açılır |
| `POST /auth/login` | — | `{ role: 'driver', phone, password }` · `{ role: 'stand' \| 'admin', username, password }` |
| `POST /auth/refresh` | — | `{ refreshToken }` |
| `POST /auth/logout` | driver, stand | Hesabın tüm oturumlarını kapatır (`token_version+1`) ve açık socket'leri keser. Yönetici için 400: admin oturumu `ADMIN_TOKEN_VERSION` ile iptal edilir |
| `GET /me` | herhangi | |
| `PATCH /stands/me/settings` | stand | `{ initialRadiusM, maxRadiusM }` |
| `GET /admin/drivers`, `GET /admin/stands` | admin | `?status=pending` |
| `POST /admin/{drivers\|stands}/:id/approve` · `/suspend` | admin | |

Yanıt biçimi socket ack'iyle aynıdır: `{ ok: true, data } | { ok: false, error: { code, message } }`. Telefon `+90XXXXXXXXXX`, plaka boşluksuz büyük harfle saklanır (normalizasyon `packages/shared/src/auth.ts`).

Bu dosya, Durak Dispeç Sistemi (çalışma adı: **DurakNet**) için mimari referans ve geliştirme rehberidir. Kod yorumları ve commit mesajları Türkçe olabilir; tanımlayıcılar (değişken, tablo, event adları) İngilizce tutulur.

> **KAPSAM KISITI — ÖDEME YOK:** Sistemde uygulama içi ödeme, cüzdan, ücret hesaplama, komisyon veya herhangi bir finansal kayıt **bulunmaz ve eklenmez**. Sistemin tek işi durak ile şoför arasındaki iletişim ve eşleşmedir. Ücret, taksimetre ile uygulama dışında alınır. Bu kısıtı ihlal eden tablo, alan, event veya endpoint önerilmez.

---

## 1. Project Overview

### Amaç
Taksi durakları, kendi sıralarında araç kalmadığında müşteriyi kaybetmek yerine alış noktası çevresindeki **aktif (boşta)** taksilere gerçek zamanlı çağrı fırlatır. İlk kabul eden şoför işi alır, yol tarifini cihazındaki harita uygulamasından alarak müşteriye gider.

### Aktörler
| Aktör | İstemci | Yetki |
|---|---|---|
| **Durak (`stand`)** | Web paneli / tablet | Çağrı oluşturma, iptal, eşleşen aracı görme |
| **Şoför (`driver`)** | Mobil uygulama (Expo) | Aktif/pasif mod, çağrı görme, kabul, iptal, tamamlama |
| **Sistem yöneticisi (`admin`)** | Web paneli (aynı SPA) | Şoför/durak onayı ve askıya alma. MVP'de ayrı tablo yok; tek hesap ortam değişkenleriyle tanımlanır. |

### User Journey (Happy Path)
1. Şoför uygulamayı açar, **Aktif** moda geçer → konumu periyodik olarak Redis GEO indeksine yazılır.
2. Durak görevlisi panelde **yalnızca alış konumunu/adresini** girer (varış adresi ve kısa not opsiyonel) → ride `created` olarak oluşur.
3. Sunucu ride'ı `searching` durumuna alır, alış noktasını merkez alarak Redis'te yarıçap araması yapar ve yalnızca bulunan şoförlere `ride_requested` gönderir.
4. İlk `ride_accept` gönderen şoför işi atomik olarak alır → `matched`. Diğer adaylara `ride_taken` gider.
5. Şoförün önüne **Kabul/Detay ekranı** gelir: alış adresi, (varsa) varış adresi, durak adı, not. **"Navigasyon"** butonu cihazdaki harita uygulamasını alış koordinatıyla açar (bkz. Bölüm 7).
6. Şoför müşteriyi aldığında **"Müşteri alındı / Tamamla"** der → `completed`. Sistemin sorumluluğu burada biter (yolculuğun kendisi izlenmez).
7. Kimse kabul etmezse yarıçap kademeli olarak `max_radius_m`'e kadar genişler; sonra **arama süresiz devam eder** (sürekli tarama, bkz. Senaryo 4). Çağrı ancak bir şoför kabul ettiğinde veya **durak iptal ettiğinde** kapanır. Sistem çağrıyı hiçbir zaman kendiliğinden iptal etmez.

### Ride State Machine
```
created ──► searching ──► matched ──► completed
               │  ▲          │
               │  └──────────┘  şoför iptali → yeniden arama (o şoför hariç tutulur)
               │
               └──► cancelled   (yalnızca durak iptali)
matched ──► cancelled           (yalnızca durak iptali)
```
**Kurallar:**
- Durumlar: `created`, `searching`, `matched`, `completed`, `cancelled`. Terminal: `completed`, `cancelled`.
- `cancelled`'a **yalnızca durak** geçirebilir. Zaman aşımı, "şoför bulunamadı" veya sistem kaynaklı iptal yoktur; `searching` süresiz sürebilir.
- Geçişler yalnızca `RideStateMachine` modülünden yapılır; başka yerde `status` doğrudan güncellenmez. Geçersiz geçiş `INVALID_TRANSITION` hatası verir.
- Her geçişte `rides.version` bir artar (optimistic concurrency) ve ilgili zaman damgası kolonu (`searching_at`, `matched_at` …) doldurulur.
- `matched` sonrası **şoför** iptali → ride `searching`'e döner, `driver_id` boşaltılır, şoför `excluded` kümesine eklenir. **Durak** iptali → `cancelled`.

---

## 2. System Architecture

### Bileşenler
```
 ┌──────────────────┐        ┌──────────────────────────┐
 │ Driver App       │        │ Stand Panel (Web/Tablet) │
 │ Expo / RN        │        │ React + Vite (+ admin)   │
 └────────┬─────────┘        └────────────┬─────────────┘
          │    WSS (Socket.io) + HTTPS REST│
          └───────────────┬────────────────┘
                          ▼
               ┌──────────────────────┐
               │ Load Balancer        │  sticky session (Socket.io)
               └──────────┬───────────┘
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
      ┌──────────┐  ┌──────────┐  ┌──────────┐
      │ API Node │  │ API Node │  │ API Node │   Express + Socket.io (stateless)
      └────┬─────┘  └────┬─────┘  └────┬─────┘
           │   @socket.io/redis-adapter (node'lar arası yayın)
           ▼             ▼             ▼
   ┌─────────────────────────────────────┐     ┌────────────────────┐
   │ Redis                               │◄────│ Worker             │
   │ GEO index · aktif ride cache ·      │     │ BullMQ: dispatch   │
   │ Pub/Sub · BullMQ · rate limit       │     │ dalgaları, sweeper │
   └─────────────────────────────────────┘     └─────────┬──────────┘
                     │                                   │
                     ▼                                   │
   ┌─────────────────────────────────────┐               │
   │ PostgreSQL + PostGIS                │◄──────────────┘
   │ stands · drivers · rides            │
   └─────────────────────────────────────┘
   Harici: Expo Push Service (uygulama arka plandayken çağrı bildirimi)
           Cihazdaki harita uygulamaları (deep-link, sunucu ile ilişkisiz)
```

### Sorumluluklar
| Bileşen | Sorumluluk |
|---|---|
| **API Node** (N replika) | REST (auth, durak/şoför yönetimi, ride geçmişi), Socket.io bağlantıları, state machine çağrıları. **Bellekte paylaşılan state tutmaz.** |
| **Worker** | Dispatch dalgaları (yarıçap genişletme) ve maksimum yarıçapta sürekli tarama, heartbeat ile ölü şoför temizliği, push bildirimleri. |
| **Redis** (6.2+, **cluster modu değil**: tek primary + replika; `maxmemory-policy` **`noeviction`** veya `volatile-*` olmalı: TTL'siz `dn:driver:{id}:pv` ve BullMQ anahtarları tahliye edilmemeli) | Anlık konum (GEO), şoför müsaitliği, aktif ride cache'i, atomik kabul (Lua), Socket.io adapter Pub/Sub, BullMQ. |
| **PostgreSQL** (15+, PostGIS) | Kaynak doğruluk: duraklar, şoförler, ride'lar ve durum zaman damgaları. |

### Veri Akışı İlkeleri
- **Genel yazma sırası:** State değişikliği önce PG'de commit edilir, sonra Redis cache güncellenir ve event yayınlanır. Uyuşmazlıkta PG kazanır.
- **İstisna 1 — kabul:** Yarış çözümü için önce Redis Lua (Senaryo 5), ardından koşullu PG `UPDATE`; PG 0 satır dönerse Redis geri alınır (compensating action).
- **İstisna 2 — konum:** Şoför konumu yalnızca Redis'te tutulur; PG'ye yazılmaz.
- **Yatay ölçek:** Hedefleme yalnızca odalarla yapılır (`driver:{id}`, `stand:{id}`, `ride:{id}`); hiçbir kod `socket.id` listesini bellekte tutmaz.
- **Kritik zamanlama** (dispatch dalgaları, sürekli tarama) Pub/Sub'a değil **BullMQ**'ya dayanır; Pub/Sub at-most-once'tır.
- **Backend dili:** Referans implementasyon **Node.js (Express)**. Spring Boot'a geçilirse event sözlüğü, Redis anahtar şeması ve PG şeması aynen korunur (sözleşme bu dokümandır).

---

## 3. Tech Stack & Tooling

### Backend (Node.js 20 LTS, TypeScript)
| Alan | Paket |
|---|---|
| HTTP | `express`, `helmet`, `cors`, `express-rate-limit` + `rate-limit-redis` |
| Realtime | `socket.io` v4, `@socket.io/redis-adapter` |
| Redis | `ioredis` (Lua / pipeline) |
| Kuyruk | `bullmq` |
| PostgreSQL | `pg` + `kysely` (veya `prisma`); migration: `node-pg-migrate` / Prisma Migrate |
| Doğrulama | `zod` — REST body'leri ve socket payload'ları için ortak şema |
| Auth | `jsonwebtoken` (access 15 dk / refresh 30 gün + `token_version`), `@node-rs/argon2` |
| Push | `expo-server-sdk` |
| Log | `pino` (JSON) |
| Test | `vitest`, `supertest`, `socket.io-client`, `testcontainers` (gerçek PG + Redis) |

*Alternatif:* Spring Boot 3 + `spring-websocket` yerine `netty-socketio`, Lettuce (Redis), Flyway, Testcontainers.

### Mobil (Şoför Uygulaması)
- Expo SDK (güncel), Expo Router, TypeScript
- `expo-location` + `expo-task-manager` (foreground + background konum)
- `react-native` `Linking` (dış navigasyon), `@expo/react-native-action-sheet` (harita uygulaması seçimi)
- `socket.io-client`, `expo-secure-store` (refresh token), `expo-notifications`, `expo-haptics` / `expo-av` (çağrı sesi/titreşim)
- `zustand`, `@tanstack/react-query`
- EAS Build / EAS Update

### Durak Paneli (Web / Tablet)
- React 18 + Vite + TypeScript, Tailwind CSS, PWA (tablet kiosk)
- `react-leaflet` (alış noktası seçimi, yakındaki araçlar), `socket.io-client`, `zustand`, `@tanstack/react-query`
- Adres → koordinat: harita üzerinde pin + geocoding servisi (ör. Nominatim veya ticari bir sağlayıcı)

### Altyapı
- Monorepo (npm/pnpm workspaces): `apps/api`, `apps/worker`, `apps/driver-mobile`, `apps/stand-panel`, `packages/shared`
- Docker + `docker-compose.yml` (api, worker, postgis, redis)
- GitHub Actions: lint → typecheck → test (testcontainers) → build
- `.env` ile yapılandırma; repoda yalnızca `.env.example`
- `/health`, `/ready`, Prometheus metrikleri (`prom-client`): aktif şoför sayısı, eşleşme süresi, eşleşme oranı

---

## 4. Database Schema (PostgreSQL)

Yalnızca üç tablo: `stands`, `drivers`, `rides`. **Ödeme, cüzdan, ücret, komisyon tablosu veya kolonu yoktur.** Kimlik bilgileri her aktörün kendi tablosunda tutulur. PostGIS etkin; zaman alanları `timestamptz`, ID'ler `uuid`.

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE account_status AS ENUM ('pending', 'approved', 'suspended');
CREATE TYPE ride_status    AS ENUM ('created', 'searching', 'matched', 'completed', 'cancelled');

-- ===== Duraklar =====
-- Bir durak tek panel hesabıyla giriş yapar (MVP'de görevli bazlı hesap yok).
CREATE TABLE stands (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              varchar(120) NOT NULL,
  phone             varchar(20)  NOT NULL,
  address           text,
  location          geography(Point, 4326) NOT NULL,
  username          varchar(60)  NOT NULL UNIQUE,
  password_hash     text         NOT NULL,
  token_version     integer      NOT NULL DEFAULT 0,
  status            account_status NOT NULL DEFAULT 'pending',
  initial_radius_m  integer NOT NULL DEFAULT 2000,
  max_radius_m      integer NOT NULL DEFAULT 8000,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (initial_radius_m > 0 AND max_radius_m >= initial_radius_m)
);
CREATE INDEX idx_stands_location ON stands USING GIST (location);

-- ===== Şoförler =====
CREATE TABLE drivers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         varchar(120) NOT NULL,
  phone             varchar(20)  NOT NULL UNIQUE,
  password_hash     text         NOT NULL,
  token_version     integer      NOT NULL DEFAULT 0,   -- refresh token iptali
  status            account_status NOT NULL DEFAULT 'pending',
  home_stand_id     uuid REFERENCES stands(id) ON DELETE SET NULL,
  plate             varchar(15)  NOT NULL UNIQUE,
  license_no        varchar(40)  NOT NULL,
  vehicle_model     varchar(80),
  vehicle_color     varchar(30),
  push_token        text,
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ===== Çağrılar =====
CREATE TABLE rides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code        varchar(8)   NOT NULL UNIQUE,      -- telefonda okunabilir kod
  stand_id          uuid NOT NULL REFERENCES stands(id),
  driver_id         uuid REFERENCES drivers(id),
  status            ride_status  NOT NULL DEFAULT 'created',
  version           integer      NOT NULL DEFAULT 0,   -- optimistic concurrency

  pickup_location   geography(Point, 4326) NOT NULL,
  pickup_address    text NOT NULL,
  dropoff_location  geography(Point, 4326),            -- opsiyonel
  dropoff_address   text,                              -- opsiyonel
  notes             varchar(280),                      -- ör. "Hastane acil girişi"

  dispatch_wave     smallint NOT NULL DEFAULT 0,
  current_radius_m  integer,
  notified_count    integer  NOT NULL DEFAULT 0,       -- toplam bildirilen şoför

  cancel_reason     varchar(120),                      -- durağın girdiği opsiyonel sebep (iptal yalnızca duraktan gelir)

  created_at        timestamptz NOT NULL DEFAULT now(),
  searching_at      timestamptz,
  matched_at        timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz
);
CREATE INDEX idx_rides_stand_status  ON rides (stand_id, status);
CREATE INDEX idx_rides_driver_status ON rides (driver_id, status);
CREATE INDEX idx_rides_created_at    ON rides (created_at DESC);
-- Bir şoförün aynı anda en fazla bir aktif işi olabilir
CREATE UNIQUE INDEX uq_driver_one_active_ride ON rides (driver_id) WHERE status = 'matched';
```

**Şema kuralları:**
- `stands` ve `drivers` üzerinde `updated_at`'i güncelleyen `set_updated_at()` trigger'ı vardır (migration'da).
- Müşteri adı/telefonu tutulmaz; durak müşteriyle kendi kanalından iletişim kurar (KVKK yüzeyini küçültür).
- Şoför iptali sonrası yeniden arama için ayrı tablo yoktur; iptal eden şoför Redis `excluded` kümesinde tutulur ve olay `pino` loguna yazılır.
- Eşleşme süresi raporu `matched_at - searching_at` üzerinden hesaplanır.

---

## 5. Redis Data Structures

Tüm anahtarlar `dn:` önekiyle başlar. GEO komutlarında sıra **(longitude, latitude)**'dır — en sık yapılan hata budur.

> `GEORADIUS` Redis 6.2'den beri **deprecated**'dır. Aynı iş için `GEOSEARCH` kullanılır (aşağıda).

### Anahtar Sözlüğü
| Anahtar | Tip | İçerik | TTL |
|---|---|---|---|
| `dn:geo:drivers:available` | GEO | Yalnızca `available` şoförler; member = `driverId` | — (sweeper temizler) |
| `dn:driver:{driverId}` | HASH | `status` (`offline`/`available`/`busy`), `lat`, `lng`, `heading`, `updatedAt`, `rideId`, `offlineReason` | 24 saat, her güncellemede yenilenir |
| `dn:driver:{driverId}:pv` | STRING | Varlık sürümü (`presenceVersion`, epoch ms tabanlı, kesin artan); her durum geçişinde presence Lua'sı yazar | — (hash silinse bile sürüm geri gitmesin diye). Tahliye edilirse sürüm Redis saatine düşer (geri gidebilir): `maxmemory-policy` `noeviction` / `volatile-*` olmalı |
| `dn:drivers:heartbeat` | ZSET | member=`driverId`, score=son konum zamanı (epoch ms) | — |
| `dn:ride:{rideId}` | HASH | `status`, `version`, `standId`, `driverId`, `pickupLat`, `pickupLng`, `radius`, `wave` | Terminal durumdan 1 saat sonra |
| `dn:ride:{rideId}:candidates` | SET | Çağrının bildirildiği şoförler | Ride ile aynı |
| `dn:ride:{rideId}:excluded` | SET | Reddeden / iptal eden şoförler | Ride ile aynı |
| `dn:driver:{driverId}:requests` | SET | Şoföre gösterilen açık çağrılar (`session_sync` için); ride `searching`'den çıkınca tüm adaylardan `SREM` ile silinir | — |
| `dn:stand:{standId}:active_rides` | SET | Durağın açık ride ID'leri | — |
| `dn:ratelimit:loc:{driverId}` | STRING | Konum güncelleme throttle sayacı | 1 sn |
| `dn:ratelimit:<register, login-ip, login-acct, refresh>:{anahtar}` | STRING | Kimlik uçları hız sınırı sayaçları (`express-rate-limit` + `rate-limit-redis`) | Pencere süresi |

Şoför, teklif aldığında `available` kalır (birden fazla çağrı görebilir); yalnızca kabul ile `busy` olur.

### Senaryo 1 — Konum güncellemesi (her 3–5 sn)
```
MULTI
  GEOADD dn:geo:drivers:available 28.9784 41.0082 drv_123      # yalnızca status=available ise
  HSET   dn:driver:drv_123 lat 41.0082 lng 28.9784 heading 90 updatedAt 1790000000000
  EXPIRE dn:driver:drv_123 86400
  ZADD   dn:drivers:heartbeat 1790000000000 drv_123
EXEC
```
`busy` şoför GEO kümesine yazılmaz (arama sonuçlarına girmez); konumu yalnızca hash'te güncellenir ve `ride:{rideId}` odasına (durağa) yayınlanır.

### Senaryo 2 — Aktif / Pasif mod
- **Aktif:** `HSET status available` + `GEOADD dn:geo:drivers:available ...`
- **Pasif:** `ZREM dn:geo:drivers:available <id>` + `HSET status offline`
- **Socket kopması:** Hemen silinmez; heartbeat sweeper'ın eşiği dolana kadar tolerans tanınır (mobil ağ dalgalanması).

### Senaryo 3 — Heartbeat sweeper (worker, her 10 sn)
```
ZRANGEBYSCORE dn:drivers:heartbeat -inf (now-60000)   → stale driverId listesi
# her biri için (status=busy olanlar hariç; aktif ride'ı olan şoför düşürülmez):
ZREM dn:geo:drivers:available <id>
ZREM dn:drivers:heartbeat <id>
# yalnızca dn:driver:<id> hash'i hâlâ varsa:
HSET dn:driver:<id> status offline offlineReason stale_heartbeat
SET dn:driver:<id>:pv max(redisNowMs + 1, GET pv + 1)   # presenceVersion artışı (Lua içinde)
```
Hepsi aday partisi başına tek Lua script'inde; eşik ve `busy` kontrolü script içinde yeniden yapılır.

### Senaryo 4 — Çağrı fırlatma: yarıçapta şoför arama
```
GEOSEARCH dn:geo:drivers:available
  FROMLONLAT 28.9784 41.0082
  BYRADIUS 2000 m
  ASC COUNT 25
  WITHDIST
```
(Eski eşdeğeri: `GEORADIUS dn:geo:drivers:available 28.9784 41.0082 2000 m WITHDIST ASC COUNT 25` — kullanılmaz.)

Uygulama katmanında:
1. `:excluded` ve `:candidates` içindekileri çıkar (`SMISMEMBER`).
2. `dn:driver:{id}` hash'inde `status == available` ve `updatedAt` son 30 sn içinde olanları tut.
3. Kalanlara `ride_requested` gönder (`driver:{id}` odası + Expo push), `SADD :candidates`, `SADD dn:driver:{id}:requests`.

**Dalga stratejisi (BullMQ delayed job):**
| Dalga | Yarıçap | Bekleme |
|---|---|---|
| 1 | `initial_radius_m` (2 km) | 20 sn |
| 2 | 2 × initial (4 km) | 20 sn |
| 3 | `max_radius_m` (8 km) | 30 sn |
| 4, 5, … (sürekli tarama) | `max_radius_m` | 30 sn — ride `searching` olduğu sürece süresiz tekrar |

- Her dalga/tarama yalnızca **yeni** adaylara bildirim gönderir (sonradan aktif olan veya bölgeye giren şoförler); önceki adayların çağrısı ride `searching` kaldıkça açık kalır. Durak her dalgada `ride_searching` alır.
- Her job çalıştığında önce ride durumunu kontrol eder; `searching` değilse bir sonraki job'ı planlamadan çıkar. Job ID'si `dispatch:{rideId}:{wave}` olarak verilir (tekrar çalıştırmaya karşı idempotent).
- Reddeden şoför (`ride_decline`) o çağrı için `excluded`'da kalır ve sürekli taramada da tekrar bildirilmez.
- Çağrının arka planda kapanma yolları yalnızca: kabul (`matched`) veya durak iptali (`cancelled`).

**"Çağrı hâlâ açık" hatırlatması:** Ride `searching` kaldıkça worker, `dispatch` job'larından bağımsız bir `reminder:{rideId}:{n}` job'ı ile durağa `ride_still_open` gönderir. İlk hatırlatma aramanın 3. dakikasında, sonrakiler 5 dakikada bir gelir (`REMINDER_FIRST_SEC=180`, `REMINDER_EVERY_SEC=300`; ortam değişkeni). Hatırlatma **yalnızca bildirimdir**: çağrıyı iptal etmez, aramayı etkilemez. Panel bunu görünür bir uyarı olarak gösterir ("X dakikadır aranıyor — beklemeye devam / iptal et"); "beklemeye devam" seçimi sadece uyarıyı kapatır, sunucuya bir şey yazmaz. Job her çalışmada ride durumunu kontrol eder; `searching` değilse kendini yeniden planlamaz. Şoför iptaliyle ride tekrar `searching`'e döndüğünde sayaç `searching_at`'ten yeniden başlar (`searching_at` her `searching` girişinde güncellenir).

### Senaryo 5 — FCFS atomik kabul (Lua)
```lua
-- KEYS[1]=dn:ride:{rideId}  KEYS[2]=dn:driver:{driverId}
-- KEYS[3]=dn:geo:drivers:available  KEYS[4]=dn:ride:{rideId}:candidates
-- ARGV[1]=driverId  ARGV[2]=rideId
if redis.call('HGET', KEYS[1], 'status') ~= 'searching' then return {0, 'RIDE_NOT_AVAILABLE'} end
if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 0 then return {0, 'NOT_A_CANDIDATE'} end
if redis.call('HGET', KEYS[2], 'status') ~= 'available' then return {0, 'DRIVER_NOT_AVAILABLE'} end
redis.call('HSET', KEYS[1], 'status', 'matched', 'driverId', ARGV[1])
local v = redis.call('HINCRBY', KEYS[1], 'version', 1)
redis.call('HSET', KEYS[2], 'status', 'busy', 'rideId', ARGV[2])
redis.call('ZREM', KEYS[3], ARGV[1])
return {1, v}
```
Lua başarılıysa:
```sql
UPDATE rides SET status='matched', driver_id=$1, matched_at=now(), version=version+1
WHERE id=$2 AND status='searching';
```
**0 satır dönerse** Redis state'i geri alınır ve şoföre `RIDE_NOT_AVAILABLE` döner. `uq_driver_one_active_ride` ikinci güvenlik katmanıdır. Başarıda: kazanana ack + `ride_accepted`, diğer adaylara `ride_taken`, durağa `ride_matched`, bekleyen dalga job'ı iptal edilir.

> Script birden fazla anahtara dokunduğu için Redis **cluster modunda çalışmaz** (CROSSSLOT). Cluster'a geçilecekse anahtarlar hash tag ile yeniden tasarlanmalıdır.

### Pub/Sub
Socket.io yayınları `@socket.io/redis-adapter` ile node'lar arasında dağılır. İç olaylar için `dn:events:ride` kanalı (`{ rideId, from, to, version }`) worker tarafından dinlenir (ör. dalga job'ını iptal etme). Kritik iş BullMQ'dadır.

---

## 6. WebSocket Event Dictionary

### Bağlantı & Kimlik Doğrulama
- Namespace'ler: `/driver` (mobil), `/stand` (panel).
- Handshake: `io('/driver', { auth: { token: '<accessToken>' } })`. Middleware JWT'yi doğrular; hesap `approved` değilse veya `token_version` eşleşmezse bağlantı reddedilir. Red `connect_error` olarak gelir: `err.message` = hata kodu, `err.data` = `{ code, message }`.
- Otomatik odalar: şoför → `driver:{id}`; durak → `stand:{id}`; eşleşmeden sonra ilgili şoför ve durak → `ride:{rideId}`.
- **Ack sözleşmesi:** İstemci → sunucu event'lerinin hepsi callback alır: `{ ok: true, data? } | { ok: false, error: { code, message } }`.
- Payload'lar `packages/shared` içindeki `zod` şemalarıyla doğrulanır.
- Ride içeren her sunucu event'i `version` taşır; istemci elindekinden düşük versiyonlu event'i yok sayar.

### Ortak Tipler
```ts
type LatLng = { lat: number; lng: number };
type RideStatus = 'created' | 'searching' | 'matched' | 'completed' | 'cancelled';
type ErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'VALIDATION_ERROR' | 'RIDE_NOT_AVAILABLE'
               | 'NOT_A_CANDIDATE' | 'DRIVER_NOT_AVAILABLE' | 'INVALID_TRANSITION'
               | 'VERSION_CONFLICT' | 'RATE_LIMITED'
               | 'INVALID_CREDENTIALS' | 'ACCOUNT_PENDING' | 'ACCOUNT_SUSPENDED'
               | 'CONFLICT' | 'NOT_FOUND' | 'INTERNAL';

type RideRequest = {             // şoföre gösterilen açık çağrı
  rideId: string; shortCode: string;
  pickup: LatLng; pickupAddress: string;
  dropoffAddress?: string; notes?: string;
  standName: string; distanceM: number;
  createdAt: string; version: number;   // süre sınırı yok; ride_taken gelene kadar açık
  serverNow: string;                    // sunucu saati (ISO-8601 Z); istemci cihaz saati farkını bununla giderir
};

type RideSnapshot = {
  rideId: string; shortCode: string; status: RideStatus; version: number;
  stand: { id: string; name: string; phone: string; location: LatLng };
  pickup: LatLng; pickupAddress: string;
  dropoff?: LatLng; dropoffAddress?: string; notes?: string;
  driver?: { id: string; name: string; plate: string; vehicle?: string; phone: string; location?: LatLng };
  createdAt: string; matchedAt?: string;
};
```

### Ortak
| Event | Yön | Payload | Açıklama |
|---|---|---|---|
| `auth_refresh` | C → S | `{ token }` | Bağlantıyı koparmadan access token yenileme |
| `auth_expired` | S → C | `{}` | Access token süresi doldu; istemci 30 sn içinde REST ile refresh edip yeni access token'ı `auth_refresh` ile göndermezse bağlantı kesilir |
| `session_sync` | S → C | Şoför: `{ driverStatus, offlineReason?, presenceVersion, activeRide?: RideSnapshot, openRequests: RideRequest[], serverTime }` · Durak: `{ activeRides: RideSnapshot[], serverTime }` | Her (yeniden) bağlanmada ve `session_sync_request` ack'inde (`/driver` ve `/stand`); istemci state'ini bununla düzeltir. `serverTime` sunucu saatidir (ISO-8601 `Z`): istemci `serverTime - cihazSaati` farkını hesaplayıp geçen süreyi buna göre gösterir (`RideRequest.serverNow` aynı amaçla).  Şoföre ayrıca offline durumdayken konum gönderdiğinde de gelir (ör. sweeper düşürdü). `offlineReason` (`user` \| `stale_heartbeat` \| `forced` \| `not_online`) yalnızca offline iken bulunur. `presenceVersion` her durum geçişinde kesin artar (Redis `TIME` tabanlı); istemci aynı bağlantıda daha küçük sürümlüyü yok sayar |

### Şoför (`/driver`)
| Event | Yön | Payload |
|---|---|---|
| `driver_go_online` | C → S | `{ location: LatLng }` → ack `{ ok, data: { status: 'available' | 'busy', presenceVersion } }` — aktif işi olan şoför `busy` kalır ve sürüm değişmez |
| `driver_go_offline` | C → S | `{}` → ack `{ ok, data: { status: 'offline', presenceVersion } }` (aktif ride varken `INVALID_TRANSITION`). Gövde **zorunlu** (`{}`): gövdesiz `emit(event, ack)`'te sunucu callback'i payload olarak alır, doğrulama düşer ve **ack hiç dönmez** (istemci zaman aşımına düşer). `session_sync_request` için de aynı |
| `session_sync_request` | C → S | `{}` → ack `{ ok, data: DriverSessionSync }` — bağlıyken güncel durumu istemek için (ör. uygulama arka plandan döndü) |
| `driver_location_update` | C → S | `{ location: LatLng, heading?: number, accuracy?: number, ts: number }` — ack'siz, throttle 1/sn |
| `ride_requested` | S → C | `RideRequest` |
| `ride_accept` | C → S | `{ rideId }` → ack `{ ok, data: RideSnapshot }` veya `RIDE_NOT_AVAILABLE` |
| `ride_accepted` | S → C | `RideSnapshot` — kabul onayı (diğer cihaz oturumları için de) |
| `ride_decline` | C → S | `{ rideId }` — şoför `excluded`'a eklenir |
| `ride_taken` | S → C | `{ rideId }` — başkası aldı veya çağrı kapandı; ekrandan kaldırılır |
| `ride_driver_cancel` | C → S | `{ rideId, reason?, version }` — yalnızca `matched` durumundaki kendi ride'ı için; ride `searching`'e döner, şoför `excluded`'a eklenir ve tekrar `available` olur. Şoförün "Kabul/Detay" ekranında **"Çağrıyı iptal et"** butonu (onay diyaloğuyla) bulunur. |
| `ride_complete` | C → S | `{ rideId, version }` — müşteri alındı |
| `ride_completed` | S → C | `{ rideId, completedAt, version }` — yalnızca **durak** tamamladığında şoföre gider (şoför kendi tamamlamasında ack alır) |
| `ride_cancelled` | S → C | `{ rideId, reason?, version }` — durak iptal etti (eşleşmiş şoföre gider) |

### Durak Paneli (`/stand`)
| Event | Yön | Payload |
|---|---|---|
| `ride_create` | C → S | `{ pickup: LatLng, pickupAddress, dropoff?: LatLng, dropoffAddress?, notes? }` → ack `{ ok, data: { rideId, shortCode } }` |
| `ride_searching` | S → C | `{ rideId, wave, radiusM, notifiedCount, searchingSince, version }` — her dalga/taramada; panel geçen arama süresini gösterir |
| `ride_matched` | S → C | `{ rideId, driver: { id, name, plate, vehicle, phone }, distanceM, version }` |
| `ride_driver_cancelled` | S → C | `{ rideId, reason?, driverName, plate, version }` — eşleşen şoför vazgeçti, arama yeniden başladı (panel uyarı gösterir) |
| `ride_still_open` | S → C | `{ rideId, searchingSince, minutesOpen, version }` — hatırlatma; çağrıyı iptal etmez |
| `ride_complete` | C → S | `{ rideId, version }` → ack — eşleşmiş (`matched`) ride'ı durak da tamamlayabilir |
| `ride_completed` | S → C | `{ rideId, completedAt, version }` — şoför veya durak tamamlamasında durağa gider |
| `ride_cancel` | C → S | `{ rideId, reason?, version }` |
| `ride_cancelled` | S → C | `{ rideId, reason?, version }` — iptalin onayı (aynı durağın diğer tabletleri için) |
| `session_sync_request` | C → S | `{}` (gövde zorunlu) → ack `{ ok, data: { activeRides: RideSnapshot[], serverTime } }` — bağlıyken güncel durumu istemek için (şoför tarafının eşi) |
| `stand_nearby_drivers` | S → C | `{ drivers: { id, location: LatLng }[] }` — 10 sn'de bir, `max_radius_m` içindeki `available` şoförler |

### Ride Odası (`ride:{rideId}`)
| Event | Yön | Payload |
|---|---|---|
| `ride_driver_location` | S → C | `{ rideId, location: LatLng, heading?, ts }` — durak panelinde eşleşen aracı haritada göstermek için |

### Arka Plan Bildirimi
Şoför uygulaması arka plandaysa veya socket kopuksa `ride_requested` ile **paralel** Expo push gönderilir (`data: { type: 'ride_requested', rideId }`). Bildirime dokununca uygulama bağlanır, `session_sync` ile güncel açık çağrıları alır; push içeriğine güvenilerek kabul yapılmaz.

---

## 7. External Navigation Integration

Uygulama içinde rota çizilmez. Kabul/Detay ekranındaki **"Navigasyon"** butonu, alış koordinatını (`pickup`) cihazdaki harita uygulamasına deep-link ile verir. Kod `apps/driver-mobile/src/lib/navigation.ts` altında tek modülde toplanır.

### URI Şemaları
| Uygulama | Platform | URI (hedef = `lat,lng`) |
|---|---|---|
| Google Maps (uygulama, navigasyon modu) | Android | `google.navigation:q={lat},{lng}&mode=d` |
| Google Maps (uygulama) | iOS | `comgooglemaps://?daddr={lat},{lng}&directionsmode=driving` |
| Yandex Navigasyon | Android / iOS | `yandexnavi://build_route_on_map?lat_to={lat}&lon_to={lng}` |
| Yandex Haritalar | Android / iOS | `yandexmaps://maps.yandex.ru/?rtext=~{lat},{lng}&rtt=auto` |
| Apple Maps | iOS | `maps://?daddr={lat},{lng}&dirflg=d` |
| **Fallback** (evrensel link) | Her ikisi | `https://www.google.com/maps/dir/?api=1&destination={lat},{lng}&travelmode=driving` |

### Strateji
```ts
import { Linking, Platform } from 'react-native';

type NavApp = { id: string; label: string; url: (p: LatLng) => string };

const APPS: NavApp[] = [
  Platform.OS === 'android'
    ? { id: 'google', label: 'Google Maps', url: p => `google.navigation:q=${p.lat},${p.lng}&mode=d` }
    : { id: 'google', label: 'Google Maps', url: p => `comgooglemaps://?daddr=${p.lat},${p.lng}&directionsmode=driving` },
  { id: 'yandexnavi', label: 'Yandex Navigasyon', url: p => `yandexnavi://build_route_on_map?lat_to=${p.lat}&lon_to=${p.lng}` },
  { id: 'yandexmaps', label: 'Yandex Haritalar', url: p => `yandexmaps://maps.yandex.ru/?rtext=~${p.lat},${p.lng}&rtt=auto` },
  ...(Platform.OS === 'ios'
    ? [{ id: 'apple', label: 'Apple Haritalar', url: (p: LatLng) => `maps://?daddr=${p.lat},${p.lng}&dirflg=d` }]
    : []),
];

const fallbackUrl = (p: LatLng) =>
  `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`;

export async function getInstalledNavApps(p: LatLng): Promise<NavApp[]> {
  const checks = await Promise.all(APPS.map(a => Linking.canOpenURL(a.url(p)).catch(() => false)));
  return APPS.filter((_, i) => checks[i]);
}

export async function openNavigation(p: LatLng, app?: NavApp) {
  try {
    if (app) return await Linking.openURL(app.url(p));
  } catch { /* uygulama açılamadı → fallback */ }
  await Linking.openURL(fallbackUrl(p));
}
```
- **Seçim akışı:** Yüklü uygulamalar `getInstalledNavApps` ile bulunur. Bir tane varsa doğrudan açılır, birden fazlaysa Action Sheet gösterilir. Şoförün seçimi "varsayılan yap" ile `AsyncStorage`'a kaydedilir ve Ayarlar'dan değiştirilebilir.
- **iOS:** `canOpenURL` için şemalar `app.json` → `ios.infoPlist.LSApplicationQueriesSchemes` içine eklenmelidir: `["comgooglemaps", "yandexnavi", "yandexmaps"]` (`maps` sistem şemasıdır).
- **Android 11+ (package visibility):** `canOpenURL`'ün doğru sonuç vermesi için `AndroidManifest.xml`'e `<queries>` bloğu gerekir (`google.navigation`, `yandexnavi`, `yandexmaps` şemaları için `<intent><action android:name="android.intent.action.VIEW"/><data android:scheme="..."/></intent>`). Expo'da bu, `withAndroidManifest` kullanan küçük bir **config plugin** ile eklenir; Expo Go'da değil development build'de test edilir.
- Koordinatlar her zaman nokta ondalık ayraçla yazılır (`toFixed(6)`); cihaz dili Türkçe olsa bile virgül kullanılmaz.
- Navigasyon açıldıktan sonra uygulama arka plana geçer; konum yayını background location task ile sürer ve ride ekranı `session_sync` ile geri yüklenir.

---

## 8. Development Phases (Milestones)

Her faz bir **kabul kriteri** ile biter; kriter karşılanmadan sonraki faza geçilmez.

### Faz 0 — Proje İskeleti (≈1 hafta)
- Monorepo (`apps/api`, `apps/worker`, `apps/driver-mobile`, `apps/stand-panel`, `packages/shared`), `docker-compose` (PostGIS + Redis), migration altyapısı, lint/typecheck/test CI.
- **Kabul:** `docker compose up` + testler temiz; `/health` 200 döner. Bu dosyanın başına gerçek komutlar eklenir.

### Faz 1 — Kimlik & Temel Veri (≈1 hafta)
- Şoför kaydı (telefon + şifre + plaka/ruhsat), durak hesabı, admin onay/askıya alma, JWT access/refresh + `token_version`.
- **Kabul:** Onaysız hesap socket'e bağlanamaz; askıya alınan hesabın refresh token'ı anında geçersiz olur.

### Faz 2 — Şoför Varlığı & Konum (≈1–2 hafta)
- Socket.io + redis-adapter, `/driver` namespace, `driver_go_online/offline`, `driver_location_update`, heartbeat sweeper.
- Mobil: aktif/pasif toggle, foreground + background konum, yeniden bağlanma + `session_sync`.
- **Kabul:** 2 API node'u arkasında 500 simüle şoför 3 sn aralıkla konum gönderirken p95 işleme < 50 ms; bağlantısı düşen şoför ≤ 75 sn içinde GEO'dan çıkar.

### Faz 3 — Çağrı & FCFS Eşleşme (MVP çekirdeği) (≈2 hafta)
- `RideStateMachine`, `ride_create`, dalga bazlı `GEOSEARCH` dispatch (BullMQ), Lua atomik kabul, `ride_taken`, maksimum yarıçapta sürekli tarama, durak iptali.
- Panel: harita üzerinden alış noktası seçimi + çağrı durum kartı.
- Mobil: gelen çağrı ekranı (ses + titreşim + geri sayım), kabul/ret.
- **Kabul:** 50 şoförün aynı anda kabul gönderdiği entegrasyon testinde tam olarak 1 eşleşme; kaybedenler `RIDE_NOT_AVAILABLE` alır.

### Faz 4 — Kabul Ekranı, Navigasyon & Yaşam Döngüsü (≈1 hafta)
- Kabul/Detay ekranı, Bölüm 7'deki navigasyon modülü + iOS/Android şema yapılandırması.
- `ride_complete`, durak iptali, şoför iptalinde yeniden arama, `ride_still_open` hatırlatması; panelde eşleşen aracın canlı konumu.
- **Kabul:** Gerçek cihazda Google Maps, Yandex Navigasyon ve Apple Maps (iOS) alış noktasına rota açar; hiçbiri yüklü değilse web fallback açılır. Uçtan uca: çağrı → kabul → navigasyon → tamamlandı; panel yenilense de state doğru geri yüklenir.

### Faz 5 — Push & Dayanıklılık (≈1 hafta)
- Expo push (arka plan çağrıları), push token yönetimi, rate limiting (REST + socket), idempotent handler'lar, Prometheus metrikleri.
- **Kabul:** Uygulama kapalıyken şoför bildirim alır ve açınca çağrıyı görür; bir API node'u öldürülünce istemciler diğer node'a bağlanıp `session_sync` ile devam eder.

### Faz 6 — MVP Pilot
- 1–2 durak ile saha pilotu, basit raporlar (günlük çağrı, eşleşme oranı, ortalama eşleşme süresi), KVKK aydınlatma metni, EAS production build.
- **Kabul:** Pilot süresince state tutarsızlığından kaynaklı kayıp çağrı sıfır; ortalama eşleşme süresi ölçülür (hedef < 60 sn).

---

## Engineering Rules (Claude için)

- **Ödeme yok:** Ücret, ödeme, cüzdan, komisyon veya finansal kayıtla ilgili kod, tablo, alan ya da event eklenmez (bkz. kapsam kısıtı).
- **Tek kaynak sözleşme:** Event adları, payload şemaları ve enum'lar yalnızca `packages/shared` içinde tanımlanır. Yeni event önce oraya, sonra bu dokümanın Bölüm 6'sına eklenir.
- **Bellekte state yok:** API node'larında modül seviyesinde kullanıcı/ride/socket listesi tutulmaz.
- **Eşzamanlılık:** Kabul/iptal/tamamlama gibi yarışabilen işlemler Redis Lua + PG koşullu `UPDATE ... WHERE status = ... AND version = ...` ile yapılır; `SELECT` sonra `UPDATE` kalıbı yasaktır. Versiyon uyuşmazlığı `VERSION_CONFLICT` döner.
- **Konum yayını** yalnızca ilgili odalara (`ride:{id}`, `stand:{id}`) yapılır.
- **Testler** mock yerine testcontainers ile gerçek PG + Redis üzerinde koşar; kabul yarışı için eşzamanlı istemcili entegrasyon testi zorunludur.
- **Gizlilik:** Loglara ham konum ve telefon numarası yazılmaz.
