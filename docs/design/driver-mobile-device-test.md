# Şoför uygulaması — gerçek cihaz testi (Faz 2 + Faz 3 + Faz 4)

Kapsam: Faz 2: PR #2 "Doğrulanmayanlar" listesi + tasarım belgesi açık soruları S5, S6 (`driver-mobile-faz2.md` Bölüm 9) — Bölüm 4 A–E. Faz 3: çağrı akışı — Bölüm 4 F. Faz 4 kabul kriteri: navigasyon ve yaşam döngüsü — Bölüm 4 G, H.

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

### F. Faz 3 — çağrı akışı (Android + iOS)
Ön koşul: PC'de worker + API + durak paneli (`pnpm --filter @duraknet/stand-panel dev`, `VITE_API_URL=http://<LAN-IP>:3000`) çalışıyor; onaylı bir durak hesabıyla panele giriş yapılmış; şoför AKTİF ve durağın `max_radius_m` içinde (gerekirse durak konumunu telefonun yakınına koy).
| # | Adım | Beklenen |
|---|---|---|
| F1 | Panelden çağrı oluştur (alış adresi/pin) | Telefonda çağrı ekranı: ses + titreşim, çağrı süre sınırı olmadan açık kalır (tasarımdaki geri sayım/yaşlanma göstergesini not et); mesafe ve adres doğru |
| F2 | Uygulama arka plandayken çağrı oluştur | Not et: bildirim/ses geliyor mu (**push Faz 5'te; gelmemesi beklenir**), uygulamayı açınca `session_sync` ile çağrı görünüyor mu |
| F3 | KABUL ET | Kabul/Detay ekranı: alış adresi, durak adı, not, "Navigasyon" butonu; panelde kart EŞLEŞTİ |
| F4 | İkinci bir çağrıyı başka şoför/sahte istemciyle önce kabul ettir | Telefonda çağrı kaybolur (`ride_taken`), hata ekranı yok |
| F5 | Eşleşmişken panelden İPTAL ET | Telefonda "çağrı iptal edildi" ekranı, durum tekrar AKTİF/available |
| F6 | Eşleşmişken şoför "Çağrıyı iptal et" (onay diyaloğuyla) | Panelde uyarı, çağrı yeniden aranıyor; bu şoför aynı çağrıyı tekrar görmez |
| F7 | Eşleşmişken uygulamayı kapat/aç, giriş açık | `session_sync.activeRide` ile Kabul/Detay ekranı geri gelir |

### G. Faz 4 — navigasyon (kabul kriteri; Android + iOS)
Ön koşul: F3 ile eşleşmiş bir çağrı. Telefonda hangi harita uygulamalarının yüklü olduğunu not et.
| # | Adım | Beklenen |
|---|---|---|
| G1 | Yalnızca Google Maps yüklüyken "Navigasyon" | Doğrudan Google Maps açılır, hedef = alış noktası, mod = sürüş (Android `google.navigation:`, iOS `comgooglemaps://`) |
| G2 | Yandex Navigasyon yüklüyken | Seçim sayfası (birden fazla uygulama) → Yandex Navigasyon alış noktasına rota kurar |
| G3 | Yandex Haritalar yüklüyken | Alış noktasına rota kurar |
| G4 | iOS: Apple Haritalar | Alış noktasına sürüş rotası |
| G5 | Birden fazla uygulama + "varsayılan yap" işaretli seçim | Sonraki "Navigasyon" doğrudan o uygulamayı açar; Hesap → "Harita uygulaması" satırı seçimi gösterir; SIFIRLA sonrası tekrar sorar |
| G6 | Hiçbiri yüklü değil (ya da yüklü olanları gizle/kaldır) veya varsayılan uygulama silindi | Web fallback (`google.com/maps/dir/?api=1&destination=...`) tarayıcıda açılır, rota alış noktasına |
| G7 | Koordinat doğruluğu (Türkçe dil/bölge ayarlı cihaz) | Hedef doğru nokta; virgül/ondalık hatası yok (nokta ayracı) |
| G8 | **Android 11+:** `canOpenURL` yüklü uygulamaları görüyor mu | Seçim sayfasında yüklü uygulamalar listeleniyor. Görünmüyorsa `AndroidManifest.xml` `<queries>` bloğunu kontrol et (`with-nav-queries` plugin'i prebuild çıktısına işlemiş mi) |
| G9 | iOS: ilk açılışta "… uygulamasında açılsın mı?" sistem uyarısı çıkarsa | Not et: uyarı sonrası/dönüşte ride ekranı ve konum yayını normal mi (navigasyon bayrağı `inactive`→`active` ile erken tüketilmemeli) |

### H. Faz 4 — yaşam döngüsü ve panel (uçtan uca)
| # | Adım | Beklenen |
|---|---|---|
| H1 | Navigasyon açıkken (uygulama arka planda) panelde eşleşen aracı izle | Araç simgesi (plaka etiketli) hareket eder, "Son konum: X sn önce" güncellenir. Durursa 20 sn sonra simge soluklaşır, "!" çıkar (S6 sonucuna bağlı) |
| H2 | Navigasyondan uygulamaya dön (kısa ve > 30 sn süre ile ayrı ayrı) | Ride ekranı güncel durumla geri yüklenir (iptal/tamamlama olduysa yansır); Android ve iOS'ta sırayla dene |
| H3 | Panel sayfasını yenile (F5) | Eşleşen kart ve araç simgesi (son konumuyla) geri gelir |
| H4 | Müşteri alındı: şoför "Tamamla" | Panelde kart kapanır, araç simgesi kalkar; telefon AKTİF/available |
| H5 | Aynısını panelden TAMAMLANDI ile | Telefona `ride_completed`; ekran kapanır |
| H6 | Eşleşmişken PC'den durağı askıya al (admin) | Telefona `stand_suspended` iptali; panel oturumu kapanır |
| H7 | Eşleşmişken şoför uygulamasından çıkış yap, tekrar giriş | Ride `matched` kalır, giriş sonrası `session_sync.activeRide` ile devam |

## 5. Sonuç raporu
Bana şunları gönder: cihaz modeli + OS sürümü, yukarıdaki tablonun ✅/❌ hali, S5 için güncelleme aralığı ölçümü, S6 için C2/C3 sonucu, G1–G9 (hangi harita uygulamaları yüklüydü), H2 (dönüşte ekran), B4'te bildirimin kalıp kalmadığı, `adb logcat` hata satırları. Buna göre S5/S6 kararı verilip PR #2 listesi güncellenir.
