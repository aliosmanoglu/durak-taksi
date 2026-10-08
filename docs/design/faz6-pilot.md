# Faz 6 — MVP pilot: tasarım

Durum: onaylı (kullanıcı kararları: kendi Nominatim, rapor yalnızca admin, `searching_at` migration'sız).
Kapsam kısıtı: ödeme/ücret/cüzdan/komisyon yok; müşteri adı/telefonu tutulmaz.

## 1. Kararlar
| Konu | Karar |
|---|---|
| Geocoder | Kendi Nominatim (Türkiye OSM extract'ı); `VITE_GEOCODER_URL` ile panele verilir. Genel nominatim.openstreetmap.org üretimde kullanılmaz |
| Eşleşme süresi | `matched_at - searching_at` (son aramadan). İlk aramadan süre için kolon eklenmedi; rapor bunu not eder |
| Rapor erişimi | Yalnızca admin (`/admin/reports/*`); admin paneli aynı SPA |
| Gün sınırı | `Europe/Istanbul`, gün = `rides.created_at` günü |
| KVKK onayı | Kayıt gövdesinde `kvkkAccepted: true` zorunlu; sürüm ve zaman `drivers`/`stands` tablolarına yazılır (migration) |

## 2. Sözleşme (`packages/shared/src/reports.ts`, `auth.ts`)
`reportQuerySchema`, `dailyReportSchema`, `consistencyReportSchema`, `KVKK_NOTICE_VERSION`, `MATCH_TARGET_SECONDS`.
`driverRegisterSchema` / `standRegisterSchema` artık `kvkkAccepted: z.literal(true)` ister (kırıcı değişiklik: testler ve istemciler güncellenir).

## 3. Backend (`apps/api`)
- `GET /admin/reports/daily?from&to&standId` → `DailyReport`. Tek SQL: `date_trunc`/`AT TIME ZONE 'Europe/Istanbul'` ile gruplama, süre istatistikleri için `percentile_cont(0.5|0.9) WITHIN GROUP`, `avg`, `FILTER (WHERE matched_at IS NOT NULL AND matched_at >= searching_at)`. Aralık ≤ `REPORT_MAX_DAYS`; boş günler de satır olarak döner (`generate_series`). `open` = `created|searching|matched`. `totals` ride bazında yeniden hesaplanır (günlük ortalamaların ortalaması değil).
- `GET /admin/reports/consistency` → `ConsistencyReport`: PG'de açık ride'ları Redis `dn:ride:{id}` hash'iyle karşılaştırır (`pipeline`, salt okunur), son 1 saatte terminal olanlar için Redis'te hâlâ açık görünenleri de işaretler. `stale_created`: created ve > `RECONCILE_ORPHAN_AGE_S`. Onarım yapmaz.
- Migration `1791000000000_faz6_kvkk.sql`: `drivers.kvkk_accepted_at timestamptz`, `drivers.kvkk_version varchar(40)`, `stands` için aynıları. Kayıt uçları bunları doldurur. Mevcut hesaplar NULL kalır.
- Hesap silme/anonimleştirme: admin `POST /admin/{drivers|stands}/:id/anonymize` KVKK silme talebi için (ad, telefon, plaka, kullanıcı adı, push token boşaltılır; hesap `suspended`; ride kayıtları istatistik için kalır). Telefon/plaka UNIQUE olduğundan yer tutucu değerler (`deleted-<id>`) yazılır.
- Yük betiği: `loadtest-presence.ts` sonunda `METRICS_URL` + `METRICS_TOKEN` ile `/metrics`'ten `duraknet_location_update_seconds` kovalarını okur, p50/p95/p99'u (kova interpolasyonu; kova sınırı notu ile) basar.

## 4. Panel (`apps/stand-panel`)
- Admin girişi sonrası "Raporlar" sekmesi: tarih aralığı + durak filtresi, özet kartlar (çağrı, eşleşme oranı, ort./medyan/p90 süre, hedef payı), günlük tablo, tutarlılık kutusu (sorun sayısı; sıfırsa "tutarsızlık yok"), CSV indirme (istemci tarafında).
- Kayıt ekranlarında (varsa şoför kaydı mobilde, durak kaydı panelde) KVKK metni bağlantısı + zorunlu onay kutusu.
- Geocoder yalnızca yapılandırma değişir; Nominatim 1 istek/sn pacer'ı kendi sunucumuzda da kalır (ihtiyaç olursa gevşetilir).

## 5. Mobil (`apps/driver-mobile`)
Kayıt ekranına KVKK onay kutusu ve metin ekranı; `kvkkAccepted: true` gönderilir. Cihaz doğrulaması borca eklenir.

## 6. Altyapı / belgeler
- `docker-compose.nominatim.yml` (isteğe bağlı profil): `mediagis/nominatim:4.4`, `PBF_URL=https://download.geofabrik.de/europe/turkey-latest.osm.pbf`, `REPLICATION_URL` güncelleme, volume; ilk içe aktarma uzun sürer (RAM ≥ 8 GB önerilir). Panelin tarayıcıdan erişmesi için CORS/ters proxy gerekir (`docs/ops/nominatim.md`).
- `docs/legal/kvkk-aydinlatma-taslak.md`: veri envanteri, amaç, hukuki sebep, aktarım (geocoder kendi sunucumuz → yurt dışı aktarım yok; harita karoları üçüncü taraftan yüklenir, bunu not et), saklama süreleri, ilgili kişi hakları. Taslaktır; hukuk onayı gerekir.
- `docs/ops/pilot-runbook.md`: env kontrol listesi, `METRICS_TOKEN`, yedekleme, izleme sorguları, admin onay/askıya alma/anonimleştirme, geri bildirim formu.

## 7. Test
Gerçek PG + Redis (testcontainers): rapor (boş gün, gün sınırı 23:59/00:01 TR, iptal/tamamlanan/açık karışımı, durak filtresi, şoför iptali sonrası süre, yetki 401/403, aralık sınırı), tutarlılık (elle bozulmuş Redis hash'i her `kind` için), anonimleştirme, KVKK zorunluluğu (onaysız kayıt 400). Panel/mobil: saf mantık birim testleri (CSV, tarih aralığı).

## 8. Cihaza bağlı (en sona, tek seferlik cihaz turu)
EAS production profili (`eas.json`; kullanıcının commitlenmemiş EAS değişiklikleri çözülünce), Faz 2 S5/S6, Faz 3 F, Faz 4 G–H, Faz 5 push + proxy IP çıkarımı, KVKK onay ekranı, saha pilotu ve kabul ölçümü (rapordan).
