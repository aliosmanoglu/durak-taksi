# Şoför uygulaması — gerçek cihaz testi (Faz 2)

Kapsam: PR #2 "Doğrulanmayanlar" listesi + tasarım belgesi açık soruları S5, S6 (`driver-mobile-faz2.md` Bölüm 9).

## 1. API'yi telefondan erişilebilir çalıştırma

API `httpServer.listen(PORT)` ile tüm arayüzlerde dinler; ek ayar gerekmez.

1. Servisler: `docker compose up -d` (PostGIS 5433, Redis 6380). Kökte `.env` yoksa `.env.example`'dan kopyala; `DATABASE_URL` ve `REDIS_URL` bu portlara bakmalı.
2. `pnpm migrate:up`
3. Worker (sweeper) **mutlaka** çalışmalı, yoksa "≤ 75 sn'de düşme" testleri anlamsız: `pnpm dev:worker`
4. API: `pnpm dev:api`
5. PC'nin LAN IP'si: PowerShell → `ipconfig` (Wi‑Fi "IPv4 Address", ör. `192.168.1.23`). Telefon ve PC **aynı Wi‑Fi**'de olmalı (misafir ağı / istemci izolasyonu varsa olmaz).
6. Windows güvenlik duvarı (yönetici PowerShell, bir kez):
   ```powershell
   New-NetFirewallRule -DisplayName "DurakNet API 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
   ```
   Ağ profili "Public" ise `-Profile Any` gerekir ya da ağı Private yap.
7. Telefon tarayıcısından `http://192.168.1.23:3000/health` → 200 görmeden devam etme.
8. `.env` içinde `CORS_ORIGINS=*` (geliştirme) ve `TRUST_PROXY=false` kalabilir; native uygulama CORS'a takılmaz.

Android 9+ düz HTTP'yi engeller: Expo'nun debug build'i `usesCleartextTraffic` açık gelir, ama **release/EAS preview** build'de `http://` bağlantı sessizce düşebilir. Bu yüzden aşağıda debug varyantı öneriliyor (Yol A).

## 2. Development build

Hesap ve verilen tek bir yol yeter; **Android için Yol A önerilir** (hesap/kuyruk yok, Metro ile hızlı yineleme).

### Yol A — yerel `expo run:android` (önerilen)
Gereken: Android Studio (SDK 35+, platform-tools), JDK 17, telefonda Geliştirici seçenekleri → USB hata ayıklama.
```bash
cd "apps/driver-mobile"
echo EXPO_PUBLIC_API_URL=http://192.168.1.23:3000 > .env
pnpm --filter @duraknet/driver-mobile android
```
- Komut `android/` klasörünü üretir (prebuild), debug APK'yı derler, USB'deki telefona kurar ve Metro'yu başlatır. `.env` dosyası `.gitignore`'da olmalı; commit'leme.
- `adb devices` telefonu "device" göstermeli.
- **Not:** `EXPO_PUBLIC_*` derleme/bundle zamanında gömülür; IP değişirse Metro'yu `--clear` ile yeniden başlat.
- Kapalı/kaydırılmış uygulama senaryoları için Metro'suz test gerekiyorsa: `pnpm --filter @duraknet/driver-mobile exec expo run:android --variant release` (bu durumda cleartext sorunu için `expo-build-properties` eklenmesi gerekir — bana söyle).

### Yol B — EAS (seçilen yol; iOS için zorunlu)
Repoda `apps/driver-mobile/eas.json` (`development` profili: dev client, internal dağıtım, Android APK) ve `expo-dev-client` hazır. Sende yapılacaklar (etkileşimli, bende yapılamaz):
```bash
npm i -g eas-cli
eas login
cd apps/driver-mobile
eas init                      # projeyi Expo hesabına bağlar (app.json'a projectId yazar; commit'le)
```
1. `eas.json` → `env.EXPO_PUBLIC_API_URL` içindeki `192.168.1.23`'ü PC'nin LAN IP'siyle değiştir (EAS bulutta derler; gitignore'daki `.env` yüklenmez, değer eas.json'dan gömülür).
2. **Android:** `eas build --profile development --platform android` → çıkan linki telefondan açıp APK'yı kur.
3. **iOS:** `eas device:create` (telefonda açılan linkle UDID kaydı) → `eas build --profile development --platform ios` (Apple hesabıyla giriş, sertifika/profili EAS üretir) → link/QR ile kur; iOS 16+ için Ayarlar → Gizlilik → Geliştirici Modu açık olmalı.
4. PC'de `pnpm --filter @duraknet/driver-mobile start --dev-client` → uygulamada listeden/QR'dan Metro'ya bağlan.
- iOS ATS: dev client'ta yerel ağ HTTP'sine izin var; bağlanmazsa söyle (release'te HTTPS gerekir).
- IP değişirse yeniden build **gerekmez** sadece JS gömülüyse: `EXPO_PUBLIC_API_URL` bundle zamanında Metro'dan alınır; Metro'yu `--clear` ile başlatıp PC'de `EXPO_PUBLIC_API_URL=...` ortam değişkeniyle ver.

### Hazırlık verisi
Şoför hesabı aç ve onayla (admin ortam değişkenleriyle giriş, `POST /auth/login` `{role:'admin',...}` → token; `POST /admin/drivers/:id/approve`). Uygulamadan kayıt → "onay bekliyor" ekranı → admin onayı → giriş. İkinci bir cihaz/hesap gerekmez; "başka cihazdan pasif" testi için PC'den REST ile giriş yapan sahte istemci yeterli.

## 3. Test gözlem araçları (PC)

Redis CLI (konteyner içinden; ID'yi `drivers` tablosundan al):
```bash
docker compose exec redis redis-cli
> ZRANGE dn:drivers:heartbeat 0 -1 WITHSCORES      # son konum zamanı
> GEOPOS dn:geo:drivers:available <driverId>         # GEO'da mı?
> HGETALL dn:driver:<driverId>                       # status, offlineReason, updatedAt
> GET dn:driver:<driverId>:pv                        # presenceVersion
```
Sürekli izlemek için PowerShell: `while($true){ docker compose exec -T redis redis-cli HMGET dn:driver:<id> status offlineReason updatedAt; Start-Sleep 5 }`.
Zaman ölçmek için `updatedAt` ile `Get-Date -UFormat %s` farkına bak. API logları (`pnpm dev:api`) konumu yazmaz (gizlilik kuralı).

## 4. Senaryo (sırayla)

Her adımın sonucunu tabloya yaz: ✅ / ❌ + not (süre, cihaz modeli, Android/iOS sürümü). Başlangıç: uygulama yüklü, giriş yapılmış, PASİF.

### A. Temel akış (Android + iOS)
| # | Adım | Beklenen |
|---|---|---|
| A1 | AKTİF OL, konum iznini ver ("uygulamayı kullanırken") | İzin akışı tasarıma uygun; durum AKTİF; Redis'te `available`, GEOPOS dolu |
| A2 | Yürü / konumu değiştir | `updatedAt` ~3–5 sn'de bir ilerler |
| A3 | PASİF OL | GEO'dan hemen çıkar, `offlineReason=user`, sürüm artar |
| A4 | Uçak modu aç → AKTİF OL'a bas → kapat | `offlinePending` davranışı: bağlanınca durum doğru; otomatik aktif olmaz |
| A5 | Wi‑Fi ↔ mobil veri geçişi (AKTİF iken) | Yeniden bağlanır, `session_sync` ile durum korunur, GEO'da kalır |

### B. Arka plan konumu ve bildirim (PR #2 listesi)
| # | Adım | Beklenen |
|---|---|---|
| B1 | AKTİF, ön plan+arka plan izni verilmiş; ana ekrana çık, ekranı kilitle, 5 dk bekle | Android: kalıcı "Aktifsiniz" foreground-service bildirimi; `updatedAt` güncellenmeye devam, GEO'da kalır |
| B2 | B1 sonrası uygulamaya dön | `session_sync_request` atılır; durum AKTİF, sarı/uyarı yok |
| B3 | Android: pil optimizasyonu "kısıtlanmış"a al, B1'i tekrarla (15 dk) | Not et: üretici (Xiaomi/Samsung…) servisi öldürüyor mu |
| B4 | AKTİF iken uygulamayı son uygulamalardan **kaydırıp kapat** | Kayıt: bildirim kalıyor mu, konum sürüyor mu? Sürmüyorsa ≤ 75 sn içinde GEO'dan çıkmalı (sweeper), bildirim kalmamalı (**kalırsa hata**: yalancı "Aktifsiniz") |
| B5 | B4 sonrası uygulamayı yeniden aç | `session_sync`: sweeper düşürdüyse `stale_heartbeat` → T.sync kartı; `wantsOnline` + ≤10 dk ise otomatik yeniden aktif (en çok 3/10 dk) |

### C. S6 — yalnızca ön plan izniyle arka plan
Uygulama ayarlarından konum iznini "Yalnızca kullanırken"e çek (Android 11+: "Yalnızca uygulama kullanılırken izin ver"; iOS: "Uygulamayı kullanırken").
| # | Adım | Beklenen / ölçülecek |
|---|---|---|
| C1 | AKTİF OL (sarı şerit görünmeli, tasarım Bölüm 5) | Aktif olunabiliyor |
| C2 | Ana ekrana çık, ekranı kilitle, 5 dk | **Soru:** `updatedAt` ilerliyor mu? Android: FGS ile sürmeli; iOS: mavi durum çubuğu/`UIBackgroundModes` ile sürmeli |
| C3 | Android 12+: uygulama arka plandayken (örn. navigasyon açıkken) PASİF→AKTİF otomatik yeniden aktif olmayı tetikle (B5) | "Arka plandan FGS başlatma" `ForegroundServiceStartNotAllowedException` fırlatıyor mu? `adb logcat | findstr /i "ForegroundService"` |
| C4 | `startLocationUpdatesAsync` izin hatası verirse | Hata mesajı/ekranı not et |
**Karar kuralı (belgede):** C2 geçmezse arka plan izni aktif olmanın ön koşulu yapılır.

### D. S5 — iOS'ta duran araç (yalnızca iOS)
| # | Adım | Beklenen / ölçülecek |
|---|---|---|
| D1 | AKTİF OL, "Her zaman" izni, telefonu **hareketsiz** bırak (araç/masa), ekran kilitli | 10 dk boyunca `updatedAt` ve `GEOPOS` izle |
| D2 | Kayıt | Güncellemeler arası en uzun boşluk (sn). **> 60 sn ise** sweeper düşürür → not et, kaç dk'da |
| D3 | Aynısını telefon şarjda ve şarjsızken; Düşük Güç Modu açıkken | Fark var mı |
**Kabul (belgede önerilen):** duran araç 10 dk aktif kalır. Geçmezse: konumsuz hafif heartbeat event'i (yeni sözleşme kararı, Faz 3 öncesi).

### E. Oturum/çoklu cihaz
| # | Adım | Beklenen |
|---|---|---|
| E1 | PC'den aynı şoförle `driver_go_offline` (socket.io istemci veya admin suspend) | Telefon ≤ birkaç sn'de "pasife alındınız" / askıya almada oturum kapanır |
| E2 | Redis'te `HSET dn:driver:<id> status offline offlineReason stale_heartbeat` (sweeper simülasyonu), telefon ön planda | Uygulama `session_sync` ile fark edip `wantsOnline` ise otomatik aktif olur |
| E3 | Çıkış yap (AKTİF iken) | Onay metni; çıkışta GEO'dan çıkar, bildirim kaybolur |
| E4 | Sunucu API'sini durdur 2 dk, sonra başlat | İstemci yeniden bağlanır, durum doğru |

## 5. Sonuç raporu
Bana şunları gönder: cihaz modeli + OS sürümü, yukarıdaki tablonun ✅/❌ hali, S5 için güncelleme aralığı ölçümü, S6 için C2/C3 sonucu, B4'te bildirimin kalıp kalmadığı, `adb logcat` hata satırları. Buna göre S5/S6 kararı verilip PR #2 listesi güncellenir.
