# Pilot runbook (1–2 durak)

## Dağıtım öncesi kontrol listesi
- [ ] Ortam: `DATABASE_URL`, `REDIS_URL` (Redis ≥ 6.2, `maxmemory-policy noeviction` veya `volatile-*`), `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` (ayrı, güçlü), `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (`pnpm --filter @duraknet/api hash-password`), `CORS_ORIGINS` (`*` değil), `TRUST_PROXY` topolojiye uygun.
- [ ] `METRICS_TOKEN` tanımlı; `METRICS_ALLOW_ANON` tanımsız. Prometheus Bearer ile API ve worker (`:9102`) `/metrics` çeker.
- [ ] Worker çalışıyor (`PUSH_ENABLED` API ve worker'da aynı); `/ready` her ikisinde 200.
- [ ] Migration'lar uygulandı (`pnpm migrate:up`). PG günlük yedek + geri yükleme denemesi yapıldı.
- [ ] Kendi Nominatim hazır (`docs/ops/nominatim.md`), panel `VITE_GEOCODER_URL` ile derlendi.
- [ ] KVKK metni hukuk onaylı (`docs/legal`), sürüm sabiti güncel.
- [ ] Cihaz turu tamamlandı (`docs/design/driver-mobile-device-test.md` A–H) ve EAS production build alındı.

## Admin işlemleri
- Onay: `POST /admin/{drivers|stands}/:id/approve`; askıya alma `/suspend` (açık çağrıları iptal eder, oturumları keser).
- KVKK silme talebi: `POST /admin/{drivers|stands}/:id/anonymize`.
- Kayıp kontrolü: `GET /admin/reports/consistency` (günde en az bir kez ve pilot sonunda; `issues` boş olmalı. Sorun varsa 2 dk sonra tekrar bak — uzlaştırıcı onarır; kalıcıysa log ve ride id ile incele).

## Pilot ölçümü
- Raporlar ekranı: günlük çağrı, eşleşme oranı, ort./medyan/p90 eşleşme süresi (hedef ort. < 60 sn), hedef payı.
- Kabul: tutarlılık raporu pilot boyunca sıfır sorun; "kayıp çağrı" = durak açtı, hiç kapanmadı ve Redis/PG uyuşmadı.
- İzleme: `duraknet_location_update_seconds` (p95), `duraknet_match_seconds`, `duraknet_rate_limited_total`, `duraknet_push_total{result}`, `duraknet_open_rides{status}` (`max` ile topla).

## Saha geri bildirimi (haftalık)
Durak görevlisi: çağrı ne kadar sürede doldu, adres bulma sorunları, panel uyarıları anlaşılır mı. Şoför: bildirim geldi mi, ses/titreşim, navigasyon açıldı mı, pil tüketimi.
