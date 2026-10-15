# Üretim dağıtım planı (pilot: 1–2 durak)

Durum: PLAN (kod/imaj henüz yok; repoda api/worker için Dockerfile bulunmuyor). Hedef: cihaz turundan sonra pilotu açabilecek, geri alınabilir ve ucuz bir kurulum.

## 1. Kararlar ve varsayılanlar

| Konu | Önerilen varsayılan | Neden / alternatif |
|---|---|---|
| Barındırma | Tek Linux VPS (Türkiye veya AB bölgesi), Docker Compose | Pilot yükü küçük (p95 handler 4,9 ms @ 500 şoför). K8s/PaaS gereksiz karmaşa. Veri yerleşimi KVKK metnine yazılacak |
| Boyut | 4 vCPU / 8 GB / 80 GB SSD (uygulama + PG + Redis) | Nominatim ayrı: 8+ GB RAM, ~30 GB disk (bölüm 6) |
| Veritabanı | PostGIS 16 konteyneri + günlük `pg_dump` + WAL arşivi yok | Pilot için yeterli. Yönetilen PG tercih edilirse PostGIS desteği şart |
| Redis | `redis:7`, AOF `everysec`, `maxmemory-policy noeviction`, parola | BullMQ ve `dn:driver:*:pv` kalıcı olmalı; cluster modu YOK (Lua CROSSSLOT) |
| TLS / proxy | Caddy (otomatik Let's Encrypt) | Tek dosya yapılandırma; WebSocket desteği yerleşik |
| API replikası | 2 (pilotta 1 de yeter) | Düğüm kaybı davranışı Faz 5'te test edildi; 2 replika gerçek durumu denemek için |
| Worker | 1 replika | Çok replika güvenli (idempotent) ama gerekmez |
| Panel | `vite build` statik dosya, Caddy servis eder | Alan adı: `panel.<alan>`; API `api.<alan>` |
| Konteyner kayıt defteri | GHCR | GitHub Actions ile aynı yerde |
| Gizli bilgiler | VPS'te `/opt/duraknet/.env` (0600) + GitHub Actions secrets | Pilot için yeterli; repoda yok |

Sizden gereken kararlar: (a) alan adı, (b) VPS sağlayıcı/bölge, (c) alarm kanalı (e-posta/Telegram), (d) yedeklerin gideceği yer (ikinci sunucu/S3 uyumlu depolama).

## 2. Topoloji

```
internet ─► Caddy :443 ─┬─ api.<alan>   ─► api-1:3000, api-2:3000   (REST + Socket.io)
                        ├─ panel.<alan> ─► statik dosyalar
                        └─ geocode.<alan> ─► nominatim (ayrı VPS, CORS: panel origin'i)
api-N, worker ─► redis:6379 (iç ağ), postgres:5432 (iç ağ)
worker :9102 (yalnız iç ağ, Prometheus kazıyıcı)
```

- PG ve Redis portları dışarı AÇILMAZ (yalnızca compose iç ağı). Güvenlik duvarı: 22 (IP kısıtlı), 80, 443.
- **Sticky session:** Mobil istemci yalnızca `websocket` transportu kullanır (`transports: ['websocket']`), sticky gerekmez. Panel istemcisi polling'e düşebiliyorsa Caddy'de `lb_policy ip_hash` ya da panelde de `transports: ['websocket']` zorunlu kılınmalı (ikincisi önerilir; küçük değişiklik).
- `TRUST_PROXY`: Caddy önde tek proxy ise `TRUST_PROXY=1` (hop sayısı), `false` bırakmayın: aksi halde tüm istemciler tek IP'ye düşer ve IP hız sınırları (handshake 600/dk) herkesi birlikte keser.
- `CORS_ORIGINS=https://panel.<alan>` (`*` üretimde açılışta reddedilir).

## 3. Üretilecek dosyalar (iş kalemleri)

| # | Dosya | İçerik |
|---|---|---|
| D1 | `apps/api/Dockerfile`, `apps/worker/Dockerfile` | Çok aşamalı: `node:24-slim` + corepack/pnpm, `pnpm install --frozen-lockfile`, `pnpm --filter … build` (tsup, `@duraknet/shared` gömülür), çalışma imajı yalnızca `dist` + prod bağımlılıkları (native: `@node-rs/argon2` linux-x64-gnu otomatik). Kullanıcı: node (root değil). `HEALTHCHECK` `/health` |
| D2 | `apps/stand-panel/Dockerfile` veya CI adımı | `VITE_API_URL`, `VITE_GEOCODER_URL` derleme argümanı; çıktı `dist/` Caddy volume'üne |
| D3 | `deploy/docker-compose.prod.yml` | postgres, redis, `migrate` (tek seferlik), api (2), worker, caddy; healthcheck'ler, `restart: unless-stopped`, log rotasyonu, kaynak limitleri |
| D4 | `deploy/Caddyfile` | api/panel/geocode vhost'ları, güvenlik başlıkları (panel CSP: karo + geocoder + api), `/metrics` dışarıya KAPALI (`respond 404`) |
| D5 | `deploy/.env.production.example` | Aşağıdaki tam liste |
| D6 | `.github/workflows/ci.yml`, `release.yml` | CI: lint → typecheck → test (testcontainers) → build. Release: etiket (`v*`) → imajları GHCR'ye it → SSH ile `docker compose pull && up -d` (önce `migrate`) |
| D7 | `deploy/backup.sh` + systemd timer/cron | Günlük `pg_dump -Fc` + Redis RDB kopyası, 14 gün tut, ikinci hedefe gönder, haftalık geri yükleme denemesi |
| D8 | `deploy/prometheus.yml`, alarm kuralları, (isteğe bağlı) Grafana | Kazıma: API `/metrics` (Bearer), worker `:9102/metrics` |
| D9 | `docs/ops/production-deploy.md` | Adım adım kurulum + geri alma, bu planın uygulanmış hâli |

Tahmini emek: D1–D5 ≈ 1 gün, D6 ≈ yarım gün, D7–D8 ≈ yarım gün, doğrulama (yerelde prod compose) ≈ yarım gün.

## 4. Ortam değişkenleri (üretim)

Zorunlu / özel değer:
`NODE_ENV=production`, `PORT=3000`, `DATABASE_URL` (güçlü parola, iç ağ), `REDIS_URL` (parola), `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (≥ 32 bayt rastgele, birbirinden farklı), `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (`pnpm --filter @duraknet/api hash-password`), `ADMIN_TOKEN_VERSION=0`, `TRUST_PROXY=1`, `CORS_ORIGINS=https://panel.<alan>`, `METRICS_TOKEN` (rastgele; `METRICS_ALLOW_ANON` TANIMSIZ), `PUSH_ENABLED=true` (API **ve** worker'da aynı), `EXPO_ACCESS_TOKEN` (worker), `LOG_LEVEL=info`.
Varsayılan kalabilir: dispatch/hatırlatma/uzlaştırıcı/sweeper süreleri, `RATE_LIMIT_*`, `WORKER_HTTP_PORT=9102`, `SHUTDOWN_DRAIN_MS=5000`, `SHUTDOWN_TIMEOUT_MS=15000` (compose `stop_grace_period: 30s` olmalı).
Panel (derleme): `VITE_API_URL=https://api.<alan>`, `VITE_GEOCODER_URL=https://geocode.<alan>`.
Mobil (EAS ortamı): `EXPO_PUBLIC_API_URL=https://api.<alan>` (preview ve production için ayrı değer).

## 5. Dağıtım ve geri alma akışı

1. `main`'e birleşir → CI yeşil → `vX.Y.Z` etiketi.
2. Release iş akışı: imajlar GHCR'ye. Sunucuda: `docker compose pull`.
3. **Migration:** `docker compose run --rm migrate` (node-pg-migrate `up`). Migration'lar ileri uyumlu yazılır (kolon ekle → kodu dağıt → eskiyi sonra sil); geri alma kodu geri alır, şemayı geri almaz.
4. `docker compose up -d api worker`: API replikaları sırayla (rolling) yeniden başlatılır; `/ready` 200 olmadan sıradaki durdurulmaz. Kapanışta istemciler diğer düğüme geçer ve `session_sync` ile devam eder (Faz 5).
5. Doğrulama: `/ready` (API + worker), admin girişi, Raporlar → tutarlılık denetimi, test çağrısı.
6. Geri alma: önceki etiketin imajına `up -d`. Veri etkileniyorsa son `pg_dump`.

## 6. Nominatim (geocoder)

- Ayrı VPS (8+ GB RAM, 30 GB disk) ya da uygulama VPS'inde sonradan; ilk içe aktarma saatler sürer, **hemen başlatın**.
- `docker-compose.nominatim.yml` kullanılır; `NOMINATIM_PASSWORD` değiştirilir, 8088 dışarı açılmaz, Caddy `geocode.<alan>` arkasında TLS + CORS (yalnız panel origin'i), istek hız sınırı.
- Kabul: 10–20 gerçek alış adresi arama ve ters geocoding; zayıfsa pilotta görevli adresi elle düzeltir.

## 7. Güvenlik kontrol listesi

- SSH yalnızca anahtar; parola girişi kapalı; `fail2ban`; otomatik güvenlik güncellemeleri.
- Docker iç ağı dışında PG/Redis erişimi yok; Redis parolalı.
- `/metrics` ve worker `:9102` dışarıya kapalı; Prometheus iç ağdan veya Bearer ile.
- Admin parolası uzun/rastgele; admin paneline yalnızca güvenilir cihazlardan girilir (refresh token localStorage'da).
- Secret'lar repoda yok; `.env` 0600. Anahtar sızıntısında: JWT secret'ları değiştirmek tüm oturumları düşürür (kabul edilebilir).
- Docker imajı tarama (Trivy) CI'da, kritik bulgu dağıtımı durdurur.
- KVKK: yedekler şifreli (`age`/`gpg`), erişim kayıtlı; silme talebi `anonymize` uçları (runbook).

## 8. İzleme ve alarm

Kazıma: API `/metrics` (Bearer) ve worker `:9102/metrics`. Alarmlar:
- `/ready` 503 > 2 dk (API veya worker), sweeper tazelik uyarısı.
- `duraknet_location_update_seconds` p95 > 50 ms (10 dk).
- `duraknet_rate_limit_errors_total` artışı (Redis sorunu), `duraknet_rate_limited_total{scope="handshake"}` ani artış (yanlış `TRUST_PROXY` belirtisi).
- `duraknet_push_total{result!="ok"}` oranı.
- `duraknet_open_rides{status="searching"}` uzun süre sabit yüksek (`max` ile topla).
- Günlük: tutarlılık raporu (`/admin/reports/consistency`) `issues > 0` ise bildirim (basit bir cron + admin token yerine, ileride metrik olarak eklenebilir).
- Disk > %80, yedek başarısız, sertifika süresi < 14 gün.
Uptime dış kontrolü (UptimeRobot vb.) `https://api.<alan>/ready`.

## 9. Pilot öncesi doğrulamalar (staging = prod'un küçük kopyası)

1. Yerelde `docker-compose.prod.yml` ile uçtan uca: kayıt → onay → çağrı → kabul → tamamlama.
2. İki API replikası: birini öldür, istemci diğerine geçip `session_sync` ile devam ediyor mu (cihazda).
3. Geri yükleme tatbikatı: `pg_dump`'dan boş sunucuya.
4. Gerçek proxy zinciri altında IP çıkarımı (`TRUST_PROXY=1`): iki farklı cihazın hız sınırı sayaçları ayrı mı (Faz 5 borcu).
5. Yük: `loadtest-presence.ts` prod benzeri sunucuya karşı (ağ dahil p95).
6. Push: gerçek EAS build ile kapalı uygulamada bildirim (Faz 5 borcu).

## 10. Sıralama önerisi

1. Kararlar (alan adı, VPS, yedek hedefi, alarm kanalı) — sizde.
2. Nominatim kurulumunu başlat (uzun süren iş).
3. D1–D5 (imajlar + prod compose + Caddy) → yerelde doğrula.
4. D6 (CI/CD), D7 (yedek), D8 (izleme).
5. Staging doğrulamaları (bölüm 9, 1–3).
6. EAS `preview`/`production` env + development build ile cihaz turu (bölüm 9, 2/4/6).
7. Pilot.

## 11. Bilinen riskler

- Tek VPS = tek arıza noktası; pilot için kabul. Mitigasyon: günlük yedek, imaj ile 1 saatte yeniden kurulum, runbook.
- Redis kalıcılığı: AOF kapalıysa yeniden başlatmada BullMQ iş kuyrukları ve çağrı hash'leri gider; uzlaştırıcı PG'den onarır ama `AOF everysec` açık kalmalı.
- Panel polling transportu sticky gerektirir (bölüm 2).
- Expo push: Expo hizmeti ve FCM/APNs credentials'ına bağımlı; kesintide push gelmez, uygulama açıkken socket çalışır (bilinen sınır).
