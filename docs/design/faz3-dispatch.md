# Faz 3 — Çağrı & Eşleşme Ekran Tasarımı (durak paneli + şoför uygulaması)

- **Uygulamalar:** `apps/stand-panel` (React + Vite + Tailwind, PWA, tablet) ve `apps/driver-mobile` (Expo, Expo Router).
- **Kullanıcılar:** Durak görevlisi (telaşlı, tek elle, tablet) ve taksi şoförü (araçta, bir bakışta).
- **Bağlı belgeler:** `docs/design/driver-mobile-faz2.md` (görsel dil, `T.*` metin kimlikleri, durum makinesi, oturum yönetimi). Bu belge onu **tekrar etmez, genişletir**. Faz 2'deki renkler, dokunma hedefleri (birincil ≥ 88 dp, ikincil ≥ 56 dp), koyu tema, "renk tek işaret değildir" ilkesi aynen geçerlidir.
- **Kaynak sözleşme:** CLAUDE.md Bölüm 1, 6, 7 ve "Faz 3'e açık karar". Sözleşmede olmayan her şey Bölüm 1.2'de "Sözleşme ek önerisi" olarak işaretlidir; `packages/shared`'a önce o eklenmeden istemci ona güvenmez.
- **Kapsam dışı (tasarlanmadı):** ücret, ödeme, cüzdan, fiyat (sistemde yoktur); müşteri adı/telefonu (tutulmaz). Şoföre müşteri bilgisi gösterilmez. Durak, şoförün adını/plakasını/telefonunu görür (`RideSnapshot.driver` sözleşmesi); şoför durağın adını ve telefonunu görür.

---

## 1. Tasarımı belirleyen gerçekler

### 1.1 Sözleşmeden

| Gerçek | Tasarıma etkisi |
|---|---|
| Çağrının **süre sınırı yoktur**; `ride_taken` / `ride_cancelled` gelene kadar açık. Sistem çağrıyı kendiliğinden iptal etmez | Şoför ekranında geri sayım yok; yalnızca **geçen süre** (`createdAt`'ten). Durak kartında geçen süre (`searchingSince`'ten) |
| Şoför teklif aldığında `available` kalır; birden fazla açık çağrı görebilir | Şoförde çağrı **listesi**; yalnızca kabulle `busy` |
| `ride_decline` → şoför o çağrı için `excluded`, geri alınamaz | Reddet'e kazara basılmasına karşı yerleşim kuralları (Bölüm 4.3) |
| `ride_accept` ack: `RideSnapshot` veya `RIDE_NOT_AVAILABLE` (ayrıca `NOT_A_CANDIDATE`, `DRIVER_NOT_AVAILABLE`) | Kaybeden şoför için "başka şoför aldı" durumu; hata değil, olağan sonuç |
| Her ride event'i `version` taşır; düşük sürümlü yok sayılır. `ride_driver_cancel`, `ride_complete`, `ride_cancel` `version` ister; uyuşmazlık `VERSION_CONFLICT` | İstemci ride başına son sürümü tutar; `VERSION_CONFLICT`'te durum yeniden okunur (Bölüm 3.6 / 4.7) |
| Durak → `ride_searching` her dalga/taramada; `ride_still_open` 3. dakikada, sonra 5 dk'da bir; yalnızca bildirim | Panelde uyarı kartı; "beklemeye devam" sunucuya **hiçbir şey yazmaz** |
| Şoför iptali: ride `searching`'e döner, `searching_at` sıfırlanır; durak `ride_driver_cancelled` alır | Geçen süre sayacı yeniden başlar; uyarı bandı |
| `session_sync`: durak `{ activeRides: RideSnapshot[] }`, şoför `{ …, activeRide?, openRequests }` | Yenilemede / yeniden bağlanmada tek doğruluk kaynağı |
| `stand_nearby_drivers` her 10 sn; yalnızca `available`, `max_radius_m` içinde | Harita katmanı; 10 sn'den taze değildir (Bölüm 3.4) |
| Şoför konumu `ride:{id}` odasına yayınlanır (`ride_driver_location`) | Panelde eşleşen araç canlı konumu **Faz 4** (yer ayrıldı, tasarımı Bölüm 3.4 sonunda notlandı) |
| Ack'siz/kopuk durumda handler ack çağırmayabilir | Her ack'li emit 10 sn zaman aşımıyla (`emitWithAck`); zaman aşımı "sonuç bilinmiyor" sayılır, son söz `session_sync`'tir |

### 1.2 Sözleşme ek önerileri (önce `packages/shared`, sonra CLAUDE.md Bölüm 6)

Kullanıcı isteği (durak matched ride'ı tamamlayabilir; askıya alma eşleşmeyi düşürür; çıkışta yolculuk sürer) mevcut sözleşmede karşılığı olmayan üç şey gerektirir. Bu belge onların **var olacağı varsayımıyla** yazıldı:

| # | Öneri | Gerekçe |
|---|---|---|
| E-1 | `/stand` `ride_complete` C→S `{ rideId, version }` → ack `{ ok }`. Yalnızca `matched` ride için; sonuç `ride_completed` (durak odası) + şoföre E-2 | Şoför telefonu kapalı/uygulama çökmüş olabilir; durak ride'ı kapatabilmeli. State machine `matched → completed` zaten var; yalnızca yetki genişler |
| E-2 | `/driver` `ride_completed` S→C `{ rideId, completedAt, version, by: 'stand' }` (yalnız "durak tamamladı" için; şoför kendi tamamlamasında ack yeterli) | Şoför ekranı durak tamamladığında kendiliğinden kapanmalı |
| E-3 | Askıya alma/sistem kaynaklı şoför düşmesi: durak `ride_driver_cancelled` alır, `reason: 'driver_suspended'` (mevcut event, yeni sabit değer). Şoföre ayrı event gerekmez: hesap zaten bağlantıdan atılır | Panel "şoför vazgeçti" yerine doğru metni gösterebilsin |
| E-4 | Çıkış (`/auth/logout`) ve askıya almada `busy` şoförün **eşleşmiş ride'ı korunur** (çıkış) / **düşer** (askıya alma). `session_sync` şoföre `activeRide` taşır; `driverStatus` `busy` kalır ya da `activeRide` varken `offline` gelirse istemci `activeRide`'ı esas alır | CLAUDE.md "Faz 3'e açık karar" — Bölüm 7 Açık soru Q1 |
| E-5 | `/stand` `session_sync_request` `{}` → ack `{ activeRides }` (şoför tarafındakinin eşi) | Panelde "sonuç bilinmiyor" durumlarında socket'i yeniden kurmadan durumu almak |
| E-6 | `RideRequest`/`ride_requested` ile birlikte sunucu saati (`serverNow`) veya `session_sync`'e `serverTime` | Geçen süre hesabında cihaz saati kaymasını gidermek (Q8) |

Bu belgedeki metin ve akışlar E-1…E-4 olmadan **çalışmaz**; E-5/E-6 yoksa geçici çözümler belirtilmiştir.

---

## 2. Ortak kurallar

- **Ride görünümü (ViewModel):** her iki istemci de ride başına `{ rideId, version, status, … }` tutar. Gelen event'in `version`'ı eldekinden **küçükse yok sayılır**; eşit veya büyükse uygulanır. `session_sync` tüm yerel ride listesini **değiştirir** (birleştirmez).
- **Terminal durumlar:** `completed`, `cancelled`. İstemci bu durumdaki ride için hiçbir eylem düğmesi göstermez.
- **Geçen süre biçimi:** `< 60 sn` → "42 sn"; `< 60 dk` → "3 dk 05 sn" (dakikadan sonra saniye gösterilir ama ekran okuyucuya yalnızca dakika duyurulur); `≥ 60 dk` → "1 sa 12 dk". Negatif değer 0'a sabitlenir.
- **Kısa kod (`shortCode`):** her kartın başlığında büyük ve monospace; telefonda okunabilir ("K7M2QX").
- Ses/titreşim kullanıcıyı **rahatsız edecek kadar uzun sürmez**: Bölüm 4.4.
- Tüm metinler Türkçe, emir kipi, kısa. Yeni kimlikler `T.stand.*` (panel) ve `T.ride.*` (şoför) öneki taşır (Bölüm 5).

---

# Bölüm 3 — Durak Paneli (`apps/stand-panel`)

**Amaç:** Görevli alış noktasını en az yazıyla girer, çağrıyı fırlatır ve açık çağrıların durumunu tek ekranda izler/kapatır.
**Cihaz:** Tablet, yatay (landscape) öncelikli; dikeyde tek sütuna düşer. PWA, tam ekran (kiosk). Dokunma hedefleri ≥ **56 px**, birincil eylemler ≥ **72 px**; hedefler arası ≥ 12 px. Parlak ortamda da okunur: **açık tema varsayılan** (durak içi gündüz kullanımı; şoför uygulamasının koyu temasından bilinçli farkı), sistem koyu tercihinde koyu tema. Renkler durum anlamı taşır ama yanında daima ikon + metin vardır (yeşil = eşleşti, sarı/turuncu = dikkat, kırmızı = hata/iptal, mavi = aranıyor).

## 3.1 Rotalar ve navigasyon

```
/login          P1  Giriş
/pending        P1b Onay bekleniyor / askıya alındı (giriş sonrası durum ekranı)
/               P2  Ana ekran (tek ekran: çağrı oluştur + açık çağrılar + harita)   ← oturum şart
/settings       P3  Ayarlar (yarıçap, ses, çıkış)                                   ← modal/çekmece
```
- Dizin `/` tek ekrandır; **sayfa geçişi gerektiren bir çağrı akışı yoktur**. Oluşturma formu, kartlar ve harita aynı anda görünür.
- Oturum yoksa `/login`. Tarayıcı geri tuşu `/`'te uygulamadan çıkarmaz (PWA kiosk: `history` boşaltılır).

## 3.2 P1 — Giriş (`/login`)

```
┌─────────────────────────────────────────────┐
│                  DurakNet                   │
│                Durak girişi                 │
│  [ hata/uyarı şeridi (varsa) ]              │
│  Kullanıcı adı  [_______________________]   │
│  Şifre          [_____________] [Göster]    │
│  [           GİRİŞ YAP            ]  72 px  │
│  Şifrenizi unuttuysanız yöneticiye başvurun.│
└─────────────────────────────────────────────┘
```
| Öğe | Veri/davranış |
|---|---|
| Girdi | `POST /auth/login { role:'stand', username, password }`; kullanıcı adı küçük harfe çevrilmez (sunucu kararı), boşluklar kırpılır |
| Başarı | `refreshToken` → `localStorage` (Açık soru Q11); access bellekte; `GET /me`; socket `/stand` bağlanır; `/`'a geçilir |
| Tarayıcı parola yöneticisi | Alan `autocomplete="username"` / `"current-password"`; görevli her vardiyada yazmasın |

**Durumlar:** boş → buton etkin, eksik alanda satır içi hata · gönderiliyor → "Giriş yapılıyor…", alanlar kilitli · `INVALID_CREDENTIALS` → `T.stand.login.err.credentials`, şifre temizlenir · `ACCOUNT_PENDING` → P1b (bekliyor) · `ACCOUNT_SUSPENDED` → P1b (askıda) · `RATE_LIMITED` → `T.stand.login.err.rateLimited` + geri sayım · ağ hatası/zaman aşımı (15 sn) → `T.stand.err.network` + TEKRAR DENE · 5xx → `T.stand.err.server`.
**Erişilebilirlik:** görünür etiketler; hata şeridi `role="alert"`; Enter gönderir.

**P1b — Onay bekleniyor / askıda:** tek kart, metin `T.stand.pending.body` veya `T.stand.suspended.body`, buton GİRİŞE DÖN. Otomatik yoklama yok (Faz 2 S8 ile aynı sebep).

## 3.3 Oturum yönetimi (panel)

Faz 2 Bölüm 4.6 ile aynı mantık, web'e uyarlanmış:
- Açılışta refresh token varsa `POST /auth/refresh` → socket `/stand`. Ağ yoksa son bilinen kartlar **soluk** gösterilir ve "Bağlantı yok" şeridi çıkar; girişe atılmaz.
- Access %80'inde sessiz yenileme + `auth_refresh`; `auth_expired` gelirse hemen aynı akış (30 sn içinde). `io server disconnect` → refresh → `connect()`.
- `UNAUTHORIZED`/`ACCOUNT_SUSPENDED` → `/login` + şerit (`T.stand.session.ended` / `T.stand.suspended.body`). Kiosk olduğu için **otomatik zaman aşımı/kilit yok**; oturum 30 gün sürer.
- Tarayıcı sekmesi arka plandan dönünce (`visibilitychange`) socket bağlı değilse yeniden bağlanır; bağlıysa panel durumu için E-5 (`session_sync_request`) gönderilir, yoksa `socket.disconnect().connect()` ile `session_sync` tetiklenir.
- **Ekran uyanık kalır:** `navigator.wakeLock` (desteklenmezse gizli video hilesi yok; kurulum belgesinde "ekran zaman aşımını kapatın" notu).
- **Ses kilidi:** tarayıcılar kullanıcı dokunuşu olmadan ses çalmaz. İlk giriş sonrası üst şeritte **"SESİ AÇ"** düğmesi çıkar (bir dokunuşla `AudioContext` açılır, kalıcı değil: her sayfa yüklemesinde gerekir). Açılmadıysa sesli uyarılar yerine görsel vurgu güçlenir (titreyen kart çerçevesi + sekme başlığı "(1) DurakNet").

## 3.4 P2 — Ana ekran (tek ekran)

Yatay düzen, üç bölge: **sol: çağrı oluştur**, **orta/sağ: açık çağrı kartları**, **üst çubuk**. Harita sol bölgenin içindedir (alış noktası seçimi + yakındaki araçlar aynı harita).

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Kadıköy Durağı   (o) Bağlı   [SESİ AÇ]   5 araç yakında       [ AYARLAR ]  │ üst çubuk
├───────────────────────────────┬────────────────────────────────────────────┤
│ YENİ ÇAĞRI                    │ AÇIK ÇAĞRILAR (2)                          │
│ ┌───────────────────────────┐ │ ┌────────────────────────────────────────┐ │
│ │        HARİTA             │ │ │ K7M2QX · Moda Cd. 12         ARANIYOR   │ │
│ │   (pin = alış noktası)    │ │ │ 3 dk 05 sn · 2. dalga · 4 km · 11 şoför │ │
│ │   • yakındaki araçlar     │ │ │ [! 3 dakikadır aranıyor: beklemeye devam│ │
│ │   [ KONUMUM ] [ +  − ]    │ │ │   / iptal et]                           │ │
│ └───────────────────────────┘ │ │ [ İPTAL ET ]                            │ │
│ Alış adresi                   │ └────────────────────────────────────────┘ │
│ [ Moda Cd. 12, Kadıköy   ]    │ ┌────────────────────────────────────────┐ │
│ Son adresler: [Hastane][Otel] │ │ M4PZ8C · Bahariye Cd. 5     EŞLEŞTİ     │ │
│ [ + Varış ekle ]  [ + Not ]   │ │ Ahmet Y. · 34 ABC 123 · Beyaz Egea      │ │
│ Not: [Bagaj var][Engelli]...  │ │ 0532 *** ** 67 · 1,2 km uzakta          │ │
│ ┌───────────────────────────┐ │ │ [ TAMAMLANDI ]       [ İPTAL ET ]       │ │
│ │      ÇAĞRI OLUŞTUR        │ │ └────────────────────────────────────────┘ │
│ └───────────────────────────┘ │                                            │
└───────────────────────────────┴────────────────────────────────────────────┘
```
Dikeyde: üst çubuk → açık çağrılar (daraltılabilir) → yeni çağrı formu; oluşturma düğmesi ekranın altına yapışık.
Açık çağrı yokken sağ bölgede boş durum (Bölüm 3.4.3); form her zaman tam boy kalır.

### 3.4.1 Üst çubuk

| Öğe | Beslendiği veri | Durumlar |
|---|---|---|
| Durak adı | `GET /me` | – |
| Bağlantı çipi | socket `connect`/`disconnect` | `Bağlı` (yeşil, dolu daire) · `Bağlanıyor…` (gri) · `Bağlantı yok` (kırmızı, üçgen) |
| SESİ AÇ | Yerel `AudioContext` durumu | Yalnızca kilitliyken görünür; açılınca kaybolur |
| "{n} araç yakında" | `stand_nearby_drivers.drivers.length` | veri yoksa "–"; 0 ise "Yakında araç yok" (sarı) |
| AYARLAR | P3 | – |

### 3.4.2 Çağrı oluştur bölgesi

**İlke:** Tek zorunlu bilgi **alış noktası** (pin + adres). Görevlinin en fazla iki dokunuşla çağrı oluşturması hedeflenir: haritada noktaya dokun → ÇAĞRI OLUŞTUR. Yazı girişi yalnızca adres düzeltmek içindir.

| Öğe | Davranış / veri |
|---|---|
| Harita (`react-leaflet`) | Başlangıç merkezi: durağın konumu (`GET /me`). Dokunma/sürükleme pin'i koyar (pin ortada sabit, harita kayar seçeneği de var: tabletlerde parmak pin'i örter, bu yüzden varsayılan **"ortada sabit pin + harita kayar"**). Durak konumu ayrı simge; `max_radius_m` dairesi ince çizgiyle. Yakındaki araçlar küçük taksi simgeleri (`stand_nearby_drivers`, 10 sn'de güncellenir, simge yumuşak geçiş yapmaz, "hareketi azalt" uyumlu). `KONUMUM` düğmesi (tarayıcı konumu; tablette izin ister) pin'i cihaz konumuna koyar; reddedilirse gizlenir |
| Adres alanı | Pin yerleşince **ters geocoding** ile otomatik dolar (alan "Adres aranıyor…" gösterir). Görevli dokunup düzeltebilir; elle düzeltilmiş adres sonraki pin hareketiyle **ezilmez** (yalnızca alan boşsa veya hiç düzenlenmediyse otomatik güncellenir). Geocoding başarısız/yavaş (> 4 sn) → alan boş kalır, `T.stand.form.addressManual`; çağrı yine oluşturulabilir ama **adres zorunludur** (sunucu `pickupAddress` ister) |
| Adres arama | Adres alanına yazarken öneri listesi (geocoding); öneri seçilince pin oraya gider. Yazmak isteğe bağlı yoldur |
| Son adresler | Aynı cihazda son 5 farklı alış adresi (yerel depolama, yalnızca adres metni + koordinat); tek dokunuşla pin + adres dolar. Adres metinleri zaten müşteri kimliği taşımaz; yine de "Temizle" bağlantısı vardır |
| `+ Varış ekle` | Açılınca ikinci adres alanı + "haritadan seç" (pin ikinci kez seçilir; ilk pin'in rengi değişir). Varsayılan kapalı; isteğe bağlı |
| `+ Not` ve hızlı notlar | Serbest metin (≤ 280 karakter, sayaç) **ve** tek dokunuşluk etiketler: "Bagaj var", "Engelli yolcu", "Hastane girişi", "Kapıda bekliyor". Etiket notu birleştirir; yazmak zorunlu değil |
| ÇAĞRI OLUŞTUR | ≥ 72 px, tam genişlik, birincil. Yalnızca pin + dolu adres varken etkin. **Bağlantı yokken devre dışı** + açıklama `T.stand.form.offline` |
| Aynı yere tekrar uyarısı | Açık (searching/matched) bir çağrının alış noktası pin'e ≤ 50 m ise buton üstünde sarı, **engellemeyen** uyarı `T.stand.form.duplicate` ("Bu adrese açık çağrı var: {kod}") |

**ÇAĞRI OLUŞTUR akışı**
1. Buton kilitlenir, "Gönderiliyor…" (çift dokunma yok).
2. `emitWithAck('ride_create', { pickup, pickupAddress, dropoff?, dropoffAddress?, notes? })` (10 sn).
3. Ack ok `{ rideId, shortCode }` → form sıfırlanır (pin durak konumuna döner; son adresler listesine eklenir), açık çağrılar listesinin **en üstüne** "Başlatılıyor" kartı (`status: created`) eklenir, kısa onay bildirimi `T.stand.form.created` ("Çağrı oluşturuldu: {kod}"). İlk `ride_searching` gelince kart "ARANIYOR"a geçer. **Form sıfırlanır çünkü bir sonraki çağrı genellikle farklı adrestir**; hızlı art arda çağrı için sıfırlama yıkıcı değil.
4. Ack hata → form **korunur**, hata şeridi (Bölüm 3.4.2 durum tablosu).
5. **10 sn zaman aşımı:** sonuç bilinmiyor. Form korunur, uyarı `T.stand.form.timeout` ("Yanıt gelmedi. Çağrı oluşmuş olabilir. Listeyi kontrol edin."); oluşturma düğmesi **15 sn** kilitli kalır (yinelenen çağrıyı önlemek için); bu sürede `session_sync` (E-5 ya da yeniden bağlanma) ile liste doğrulanır. Yeni çağrı listede görünüyorsa form sıfırlanır.

| Durum (form) | UI |
|---|---|
| Hazır / boş | Pin durak konumunda, adres dolu olabilir (durağın adresi); ÇAĞRI OLUŞTUR etkin |
| Harita yükleniyor | İskelet; form alanları çalışır, adres elle yazılabilir ama pin yoksa buton devre dışı: `T.stand.form.needPin` |
| Harita karosu yüklenemedi | Gri zemin + `T.stand.map.tilesFailed`; pin koordinatı yine çalışır |
| Geocoding hatası | Adres elle girilir; `T.stand.form.addressManual` |
| Gönderiliyor | Buton "Gönderiliyor…", form kilitli |
| `VALIDATION_ERROR` | `T.stand.form.err.validation`; ilgili alan vurgulanır |
| `RATE_LIMITED` | `T.stand.form.err.rateLimited` |
| `ACCOUNT_*`/`UNAUTHORIZED` | Oturum akışı (3.3) |
| `INTERNAL` | `T.stand.form.err.internal` + tekrar dene |
| Bağlantı yok | Buton devre dışı, form **düzenlenebilir** kalır (yazılan kaybolmaz) |
| Yakında araç yok | Yalnızca bilgi: üst çubukta "Yakında araç yok" (sarı). **Oluşturmayı engellemez**; arama süresiz sürer |

### 3.4.3 Açık çağrı kartları

Liste sırası: **en yeni üstte**; `matched` kartlar sabit sıralı (yeni çağrı geldiğinde kartlar kaymasın diye yeni kart üste eklenir ve **mevcut kartların düğmeleri 600 ms devre dışı** kalır: kayan listede yanlış kartı iptal etme riskine karşı). Kart başına tek durum rengi (sol kenarda kalın şerit).

**Ortak başlık:** `shortCode` (büyük) · alış adresi (2 satıra kadar) · varış adresi (varsa, "→ …") · not (varsa, ikon + metin) · durum rozeti.

| Durum | Görünüm ve veri |
|---|---|
| `created` | Rozet "BAŞLATILIYOR" (gri). "Şoför aranıyor…" satırı; eylem: İPTAL ET (etkin). Normalde < 1 sn; `ride_searching` gelmezse 10 sn sonra satır "Arama gecikti. Bağlantıyı kontrol edin." |
| `searching` | Rozet "ARANIYOR" (mavi, dönen gösterge; hareketi azalt'ta statik). Satır: **geçen süre** (`searchingSince`'ten, her saniye güncellenir) · "{wave}. tarama" · yarıçap "{radiusM/1000} km" · "{notifiedCount} şoföre bildirildi". `notifiedCount = 0` → kırmızı olmayan sarı satır `T.stand.card.noDrivers` ("Yakında aktif araç yok. Arama sürüyor.") . Sürekli taramada (wave > 3) "sürekli tarama" yerine aynı alan "{wave}. tarama" yazar; ayrıca "Arama sürüyor" ifadesi sabittir (süre dolmaz). Eylem: **İPTAL ET** |
| `searching` + `ride_still_open` | Kartın içinde sarı **hatırlatma bandı** (engellemez): `T.stand.card.stillOpen` ("{n} dakikadır aranıyor."). İki düğme: **BEKLEMEYE DEVAM** (yalnızca bandı kapatır, sunucuya bir şey göndermez; bir sonraki `ride_still_open` bandı yeniden açar) ve **İPTAL ET** (iptal akışı 3.5). Hafif ses (SESİ AÇ açıksa) ve kart çerçevesi 3 sn sarı yanıp söner (hareketi azalt'ta yalnızca sabit kalın çerçeve). Başka kartların ve formun kullanımını engellemez |
| `searching` + `ride_driver_cancelled` | Kartın üstünde turuncu **uyarı bandı**: `T.stand.card.driverCancelled` ("{ad} ({plaka}) vazgeçti. Arama yeniden başladı." + varsa sebep). Geçen süre **sıfırdan** başlar (`searchingSince` yenilenmiştir). Bant **TAMAM** ile kapanır; kapanmazsa kartta kalır (kaçırılmasın). Güçlü ses (SESİ AÇ açıksa). E-3: sebep `driver_suspended` ise metin `T.stand.card.driverSuspended` ("{ad} ({plaka}) hesabı kapatıldı. Arama yeniden başladı.") |
| `matched` | Rozet "EŞLEŞTİ" (yeşil, dolu daire). **Şoför adı (büyük), plaka (büyük, monospace), araç** (model/renk, varsa), **telefon** (ekranda tam; dokunulabilir `tel:` bağlantısı — tabletlerde çoğu zaman arama yapmaz, bu yüzden numara okunur biçimde yazılır: "0532 123 45 67"), "**{distanceM} uzakta**" (örn. "1,2 km"; `ride_matched.distanceM`, eşleşme anındaki mesafe olduğu "(eşleşme anında)" notuyla). Eşleşmeden beri geçen süre (`matchedAt`'ten). Eylemler: **TAMAMLANDI** (yeşil, birincil, ≥ 56 px) ve **İPTAL ET** (ikincil, kırmızı çerçeve). Faz 4 yer tutucu: eşleşen araç, üstteki haritada ayrı renkli simge olarak `ride_driver_location` ile gösterilir |
| `completed` | Yeşil "TAMAMLANDI" rozeti, eylem yok; **30 sn** sonra "Son çağrılar" şeridine (oturumluk, en çok 10, yalnızca kısa kod + adres + sonuç) taşınır. Şoför mü, durak mı tamamladı bilgisi yoktur; metin yalnızca "Tamamlandı" |
| `cancelled` | Gri "İPTAL EDİLDİ" rozeti (+ sebep); 30 sn sonra "Son çağrılar"a taşınır. Aynı durağın başka tabletinden iptal edildiyse de (`ride_cancelled`) aynı görünüm |

**Kart yüklenme/yenileme durumları**
| Durum | UI |
|---|---|
| İlk bağlanma (henüz `session_sync` yok) | 2 iskelet kart; `T.stand.list.loading` |
| Boş | Sağ bölgede ikon + `T.stand.list.empty` ("Açık çağrı yok. Soldan çağrı oluşturun.") |
| Bağlantı koptu | Kartlar **soluk** (opaklık %60) + üstte sarı şerit `T.stand.list.stale` ("Bağlantı yok. Kartlar son bilinen durumu gösteriyor."); İPTAL ET/TAMAMLANDI **devre dışı**; geçen süre sayacı çalışmaya devam eder (yalnızca tahmindir) |
| Yeniden bağlandı | `session_sync` listeyi değiştirir. Kaybolan kartlar (kopukken kapananlar) için toplu bildirim `T.stand.list.closedWhileAway` ("{n} çağrı siz yokken kapandı."); sonuç (tamamlandı/iptal) bilinmez |
| Yenileme (sayfa yeniden yüklendi) | Bağlanınca `session_sync.activeRides` kartları yeniden çizer; yerel "Son çağrılar" ve SESİ AÇ durumu kaybolur (kabul edilebilir); geçen süre `searchingSince`'ten yeniden hesaplanır |
| Kart güncellemesi sırasında sürüm çakışması | Düşük sürüm yok sayılır; hata görünmez |

### 3.4.4 Son çağrılar şeridi
Sağ bölgenin altında daraltılmış tek satırlık liste (kısa kod · adres · "Tamamlandı"/"İptal"); yalnızca mevcut oturum. **Geçmiş raporu yok** (Faz 6); ride geçmişi için REST ucu sözleşmede yok (Açık soru Q9).

## 3.5 Diyaloglar

**İptal diyaloğu** (kart İPTAL ET ve hatırlatma bandındaki İPTAL ET aynı diyaloğu açar)
```
┌─────────────────────────────────────┐
│ Çağrı iptal edilsin mi?             │
│ K7M2QX · Moda Cd. 12                │
│ [EŞLEŞMİŞSE] Ahmet Y. (34 ABC 123)  │
│ yola çıkmış olabilir; şoföre haber  │
│ verilecek.                          │
│ Sebep (isteğe bağlı):               │
│ [Müşteri vazgeçti] [Başka araç     │
│  bulundu] [Yanlış adres] [Diğer]    │
│ [ VAZGEÇ ]          [ İPTAL ET ]    │  ← VAZGEÇ varsayılan odak, solda
└─────────────────────────────────────┘
```
- Sebep, tek dokunuşluk etiketlerden biri (≤ 120 karakter sınırı içinde); "Diğer" serbest metin alanı açar (isteğe bağlı). Hiç seçilmezse `reason` gönderilmez.
- İPTAL ET: `ride_cancel { rideId, reason?, version }` (kart sürümü). Ack ok → kart `cancelled` (yerel iyimser güncelleme yapılmaz; ack veya `ride_cancelled` event'i beklenir; 10 sn). `VERSION_CONFLICT`/`INVALID_TRANSITION` → diyalog kapanır, `T.stand.card.changed` ("Çağrı durumu değişti.") ve `session_sync` ile kart güncellenir (ör. şoför o sırada tamamladıysa). Zaman aşımı → diyalog kapanır, kart "Sonuç bilinmiyor" rozeti + `T.stand.card.unknown`; `session_sync` ile düzelir.
- **Eşleşmiş ride** için iptal metni farklıdır (şoföre haber verilir). Diyalog dışına dokunmak kapatır (kazara iptal edilmez çünkü eylem ayrı düğmedir).

**Tamamlama diyaloğu** (yalnızca `matched`; **durak tamamlama**, E-1)
```
│ Yolculuk tamamlandı mı?             │
│ K7M2QX · Ahmet Y. (34 ABC 123)      │
│ Şoför tamamlamadıysa siz kapatın.   │
│ [ VAZGEÇ ]        [ TAMAMLANDI ]    │
```
- `ride_complete { rideId, version }` (`/stand`, E-1). Ack ok → kart `completed`. Şoför aynı anda tamamladıysa `INVALID_TRANSITION`/`VERSION_CONFLICT` → sessizce `completed` görünümüne geçer (sonuç aynı); hata gösterilmez.
- Kazara basılmaya karşı: TAMAMLANDI düğmesi kartta ikincil boyutta ve İPTAL ET'ten **görsel olarak ayrı** (aralarında ≥ 24 px); diyalog onay ister.

## 3.6 Event → UI tablosu (panel)

| Event / çağrı | Yön | UI tepkisi |
|---|---|---|
| `connect` | S→C | Çip "Bağlı"; `session_sync` beklenir (5 sn içinde gelmezse socket yeniden kurulur/E-5) |
| `disconnect` | S→C | Çip "Bağlantı yok", kartlar soluk (3.4.3); otomatik yeniden bağlanma (1→5 sn) |
| `session_sync { activeRides }` | S→C | Yerel ride listesi değiştirilir; yoksa kart silinir; toplu bildirim |
| `ride_create` | C→S | 3.4.2 |
| `ride_searching` | S→C | Kart `searching`'e geçer, dalga/yarıçap/sayı/süre güncellenir |
| `ride_matched` | S→C | Kart `matched`'e geçer (şoför bilgisi, mesafe); yeşil yanıp sönme 3 sn + "eşleşti" sesi (SESİ AÇ açıksa); ekran okuyucuya duyuru `T.stand.a11y.matched` |
| `ride_driver_cancelled` | S→C | Kart `searching`'e döner + turuncu uyarı bandı; ses |
| `ride_still_open` | S→C | Hatırlatma bandı |
| `ride_completed` | S→C | Kart `completed` |
| `ride_cancel` | C→S | 3.5 |
| `ride_cancelled` | S→C | Kart `cancelled` (başka tabletten de gelir) |
| `ride_complete` (E-1) | C→S | 3.5 |
| `stand_nearby_drivers` | S→C | Harita simgeleri ve üst çubuk sayacı; 25 sn veri gelmezse simgeler kaldırılır ve sayaç "–" olur (bayat veri gösterilmez) |
| `ride_driver_location` (Faz 4) | S→C | Eşleşen aracın simgesi |

## 3.7 P3 — Ayarlar
Çekmece: **Arama yarıçapı** (`initialRadiusM`, `maxRadiusM`; iki kaydırıcı, 500 m–20 km, `max ≥ initial`; gönder `PATCH /stands/me/settings`; `VALIDATION_ERROR` → `T.stand.settings.err.range`), **Sesler** (aç/kapat, yalnızca yerel), **Çıkış yap** (`POST /auth/logout`, onay diyaloğu; açık çağrı varsa uyarı `T.stand.logout.confirmOpen`: "Açık çağrılar sürer; tekrar girince görünür." çünkü ride'lar durağa bağlıdır, oturuma değil), sürüm. Yarıçap değişikliği **yalnızca sonraki çağrıları** etkiler (metin `T.stand.settings.note`). Durumlar: yükleniyor (mevcut değerler), kaydediliyor, kaydedildi (kısa onay), hata (ağ/sunucu).

## 3.8 Panel erişilebilirlik
- Klavye/odak: tablet dışında masaüstünde Tab sırası: üst çubuk → form → kartlar; İPTAL diyaloğunda odak tuzağı, varsayılan odak VAZGEÇ, Esc kapatır.
- Canlı bölgeler: yeni eşleşme, şoför vazgeçti ve hatırlatma `aria-live="assertive"` (yalnızca bu üçü); geçen süre sayacı **canlı bölge değildir** (her saniye okunmaz), kartın erişilebilir adı "{kod}, aranıyor, {n} dakika" şeklinde dakikada güncellenir.
- Durum renk + ikon + metin; kontrast ≥ 4.5:1 (büyük metinde ≥ 3:1).
- Dokunma hedefleri ≥ 56 px, birincil ≥ 72 px; harita kontrolleri ≥ 48 px.
- Hareketi azalt: dönen gösterge statik simge, yanıp sönme sabit çerçeve.
- Yazı: gövde ≥ 18 px, kart başlığı ≥ 24 px, kısa kod ≥ 28 px; 200% yakınlaştırmada iki sütun tek sütuna düşer.
- Harita yalnızca görsel yardımcıdır: pin seçimi her zaman adres alanıyla da tamamlanabilir (klavyeyle/ekran okuyucuyla kullanılabilir).
- Ses yalnızca yardımcıdır; hiçbir bilgi yalnızca sesle verilmez.

---

# Bölüm 4 — Şoför Uygulaması (`apps/driver-mobile`, Faz 3 + Kabul/Detay)

**Amaç:** Yakındaki durak çağrılarını görmek, tek dokunuşla kabul/ret etmek, kabul edince alış noktasına navigasyon başlatmak, müşteriyi alınca tamamlamak.
Faz 2'nin koyu teması, renkleri, `T.*` kimlikleri, oturum/bağlantı mantığı ve şeritleri geçerlidir.

## 4.1 Rotalar (Faz 2 Bölüm 2'yi tamamlar)

```
(app)/
  index.tsx                 E4 Ana ekran (Aktif/Pasif)   — "açık çağrılar" alanı artık dolu (4.2)
  requests.tsx              D1 Gelen çağrılar (tam ekran; "modal" sunum)
  ride/[rideId].tsx         D2 Kabul/Detay (eşleşmiş yolculuk)
  ride/closed.tsx           D3 Yolculuk kapandı bildirimi (durak iptal/tamamlama/aktarım)
```
- Ön planda ve `available` iken **ilk** açık çağrı geldiğinde (`ride_requested`, ya da `session_sync.openRequests` boş değil) **D1 otomatik açılır**. Halihazırda D1 açıkken yeni çağrı gelirse ekran sıçramaz (4.3). E5 (izin) ve D2 açıkken D1 **açılmaz**: üstte bildirim şeridi `T.ride.banner.newRequest` çıkar.
- `session_sync.activeRide` varsa (soğuk açılış dahil) **doğrudan D2**; geri tuşu D2'de ana ekrana döner ama **D2'ye geri dönüş** E4 üzerindeki mavi "Aktif yolculuk" kartıyla sağlanır.
- Android geri tuşu D1'de ana ekrana döner (çağrılar açık kalır); D2'de ana ekrana döner.

## 4.2 E4 Ana ekran değişiklikleri
Faz 2'deki B1 ("Aktif işiniz var" yer tutucu) kaldırılır:
- **Açık çağrılar alanı** (başlık altında): `openRequests.length > 0` → kart "**{n} açık çağrı**" + en yakınının alış adresi; dokununca D1. Sarı rozet yalnızca **okunmamış** çağrı varsa ("YENİ"). 0 çağrı → alan çizilmez.
- **Aktif yolculuk kartı** (`activeRide` var): mavi, büyük: "Aktif yolculuk · {shortCode}" + alış adresi + düğme **YOLCULUĞA GİT** (88 dp) → D2. Bu kart varken AKTİF/PASİF düğmesi gösterilmez (yerine küçük metin `T.ride.home.busyHint`: "Yolculuk sürerken durumunuz değişmez.").
- Ana durum B1 artık "busy" başlığı: **"YOLCULUKTASINIZ"** (mavi, dolu daire + araç ikonu).

## 4.3 D1 — Gelen çağrılar (`requests`)

**Amaç:** Araçta bir bakışta karar: neredeyim → çağrı nerede → kabul/ret.
Düzen: üstte **odaklı kart** (en yakın çağrı), altında **diğer çağrılar** listesi. Tek çağrı varsa liste yoktur.

```
┌──────────────────────────────────────┐
│ < Geri            2 açık çağrı       │  (o) Bağlı
├──────────────────────────────────────┤
│ K7M2QX                     YENİ      │  kısa kod
│ 1,2 km uzakta                        │  distanceM (48 sp, kalın)
│ Moda Cd. 12, Kadıköy                 │  pickupAddress (28 sp)
│ → Bahariye Cd. 5                     │  dropoffAddress (varsa)
│ "Hastane acil girişi"                │  notes (varsa)
│ Kadıköy Durağı · 2 dk 10 sn önce     │  standName · geçen süre
│                                      │
│ ┌──────────────────────────────────┐ │
│ │            KABUL ET              │ │  yeşil dolgu, ≥ 96 dp
│ └──────────────────────────────────┘ │
│           (≥ 24 dp boşluk)           │
│ ┌──────────────────────────────────┐ │
│ │             REDDET               │ │  ikincil (gri çerçeve), ≥ 64 dp
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ DİĞER ÇAĞRILAR (1)                   │
│ M4PZ8C · 3,4 km · Bahariye Cd. 5  >  │  dokun → odağa al
└──────────────────────────────────────┘
```
Yatayda iki sütun: sol bilgi, sağ butonlar.

**Öğeler ve beslendiği veri**
| Öğe | Veri |
|---|---|
| Kısa kod | `RideRequest.shortCode` |
| Mesafe | `distanceM` (<1000 m: "850 m", ≥1000: "1,2 km"); bildirim anındaki mesafedir, sonradan güncellenmez (etiket: "alış noktasına") |
| Alış/varış adresi, not | `pickupAddress`, `dropoffAddress?`, `notes?`; **müşteri adı/telefonu yoktur** |
| Durak | `standName` |
| **Geçen süre** (geri sayım değil) | `createdAt`'ten; "2 dk 10 sn önce" biçimi; sarı/kırmızıya **dönmez** (süre sınırı yok, aciliyet uydurulmaz). Cihaz saati sunucudan geride olabilir: negatif → "az önce" (E-6 yoksa) |
| Sıra | **Yakından uzağa** (`distanceM`). Odaklı kart = en yakın; şoför liste satırına dokunarak odağı değiştirir |
| YENİ rozeti | Görülmemiş çağrı; kartın odağa alınmasıyla kalkar |

**Sıçramayı önleyen kurallar (yanlış karta kabul riski)**
1. Yeni çağrı geldiğinde odaklı kart **değişmez**; yeni çağrı listeye eklenir (YENİ rozetiyle).
2. Odaklı kart kapanırsa (ride_taken vb.) odak en yakın kalan çağrıya geçer ve **yeni odaklı kartın KABUL/REDDET düğmeleri 700 ms devre dışı** kalır (soluk); kapanan çağrı için üstte 3 sn `T.ride.req.closedToast` çıkar. Kabul dokunuşu kayan içeriğe denk gelmesin.
3. Odak değiştirme (liste dokunuşu) sonrası da aynı 700 ms kilit.
4. KABUL ET ve REDDET arasında ≥ 24 dp; REDDET ikincil stildedir ve **KABUL'ün altındadır, yanında değil**. KABUL yukarıdadır: başparmak ulaşımı ve "ilk dokunuş" kabul olduğundan, yanlış reddetme riski düşük tutulur (ret geri alınamaz).
5. REDDET'te **onay diyaloğu yok** (araçta ek diyalog dikkat dağıtır); bunun yerine 4 sn'lik **"GERİ AL"** penceresi: REDDET'e basınca çağrı listeden çıkar, alt şeritte "Reddedildi. **GERİ AL**" görünür ve `ride_decline` **4 sn sonra** gönderilir (GERİ AL ile iptal edilir). Bu süre içinde çağrı başkasına giderse (`ride_taken`) şerit kendiliğinden kalkar. (Açık soru Q3: sunucu sözleşmesi değişmez; gecikme yalnızca istemcidedir.)

**KABUL ET akışı**
1. Düğme "Kabul ediliyor…" + döner gösterge, tüm çağrı düğmeleri kilitli. Bağlı değilse düğme devre dışı + `T.ride.req.offline`.
2. `emitWithAck('ride_accept', { rideId })` (10 sn).
3. Ack ok `RideSnapshot` → haptik `success` (uzun), "Kabul edildi" sesi, D2'ye geçilir (`replace`); kalan açık çağrılar temizlenir (şoför artık `busy`; sunucu diğer çağrıları da `ride_taken` ile kapatır).
4. `RIDE_NOT_AVAILABLE` → çağrı kartı "**Çağrı başka şoföre gitti**" (`T.ride.req.taken`) durumuna geçer, 3 sn sonra kalkar; haptik `warning`; hata değil, olağan yarış sonucu olarak sunulur (kırmızı değil, mavi/gri). `NOT_A_CANDIDATE` aynı metin. `DRIVER_NOT_AVAILABLE` → `T.ride.req.notAvailable` ("Şu an çağrı alamazsınız.") + `session_sync_request`.
5. `UNAUTHORIZED`/`ACCOUNT_*` → oturum akışı. `INTERNAL` → `T.ride.req.err.internal` + düğmeler yeniden etkin.
6. **Zaman aşımı:** sonuç bilinmiyor. "Sonuç bekleniyor…" durumu; hemen `session_sync_request`. `activeRide` dönerse D2; dönmezse çağrı listeden kalkar ve `T.ride.req.unknown` gösterilir. Bu süre içinde yeniden kabul denenmez.

**D1 durumları**
| Durum | UI |
|---|---|
| Yükleniyor (bağlanmış, `session_sync` yok) | İskelet kart; `T.home.connecting` |
| Boş (son çağrı kapandı) | Ekran kendiliğinden ana ekrana döner; 3 sn `T.ride.req.closedToast` |
| Bağlantı koptu | Kartlar **solgun** + sarı şerit `T.ride.req.offlineStrip` ("Bağlantı yok. Kabul için bağlantı gerekir."); KABUL/REDDET devre dışı. Elapsed sayacı sürer |
| Yeniden bağlandı | `session_sync.openRequests` listeyi değiştirir; kaybolan çağrılar sessizce kalkar, toast "{n} çağrı kapandı." (hangi nedenle kapandığı bilinmez) |
| Pasife düştü (`session_sync offline`) | D1 kapanır; liste temizlenir; Faz 2 bildirim kartı gösterilir |
| Hata (ack) | Yukarıdaki kabul hatası tablosu |
| Başka bir çağrı kabul edilmekteyken diğerine dokunma | Kilitli |

## 4.4 Ses ve titreşim

- **İlk çağrı** (liste boşken gelen): "çağrı" sesi (kısa, tiz, ~1,5 sn) **3 kez**, aralarında 1,5 sn; titreşim deseni `[0, 400, 200, 400]` eşlenik. Ardından **susar**; çağrı açık kalmaya devam eder (süre sınırı yok, sonsuz çalma yok).
- **Ek çağrı** (liste doluyken): tek kısa "bip" + tek kısa titreşim.
- Ses/titreşim şoför ekrana dokunduğunda (herhangi bir düğme, kaydırma) veya D1'den çıkıldığında **anında** durur. Çağrı `ride_taken` ile kapanınca da durur.
- Ön plandayken çalar; arka planda ses/titreşimi **Faz 5 push** üstlenir (bu belgede yok). Uygulama arka plandaysa `ride_requested` geldiğinde yalnızca yerel görsel durum güncellenir; öne gelince `session_sync_request` ile doğrulanır.
- Cihaz sessiz/titreşim modundaysa yalnızca titreşim çalışır; ses kapalıysa ekranda kısa kırmızı olmayan ipucu yok (sistem tercihine saygı). Hesap ekranında **"Çağrı sesi"** anahtarı (Açık soru Q6); varsayılan açık.
- Ekran kilitliyken/uyurken sistem ekranı kendi açmaz (Faz 5). Ön planda D1 açıkken ekran **uyanık** kalır (`expo-keep-awake`), D1 kapanınca serbest.

## 4.5 D2 — Kabul/Detay (`ride/[rideId]`)

**Amaç:** Alış noktasına gitmek ve müşteriyi alınca yolculuğu kapatmak.

```
┌──────────────────────────────────────┐
│ K7M2QX              ● EŞLEŞTİNİZ     │
│ (o) Bağlı · Konum paylaşılıyor       │
├──────────────────────────────────────┤
│ ALIŞ NOKTASI                         │
│ Moda Cd. 12, Kadıköy                 │  28 sp, kalın
│ → VARIŞ: Bahariye Cd. 5              │  (varsa)
│ NOT: Hastane acil girişi             │  (varsa)
│ Kadıköy Durağı                       │
│ ┌──────────────────────────────────┐ │
│ │           NAVİGASYON             │ │  mavi dolgu, ≥ 112 dp, en büyük öğe
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │    MÜŞTERİ ALINDI / TAMAMLA      │ │  yeşil çerçeve/dolgu, ≥ 88 dp
│ └──────────────────────────────────┘ │
│ [ DURAĞI ARA ]                       │  ikincil, ≥ 56 dp
│                                      │
│ [ Çağrıyı iptal et ]                 │  en altta, küçük metin-buton (kırmızı çerçeve yok; gri), ≥ 56 dp
└──────────────────────────────────────┘
```
Yatayda: sol sütun bilgi, sağ sütun Navigasyon + Tamamla; "Çağrıyı iptal et" sol altta.

| Öğe | Veri / davranış |
|---|---|
| Kısa kod, durum rozeti | `RideSnapshot.shortCode`, `status` (`matched` → "EŞLEŞTİNİZ") |
| Alış/varış/not/durak | `pickupAddress`, `dropoffAddress?`, `notes?`, `stand.name` |
| **NAVİGASYON** | `src/lib/navigation.ts` (Bölüm 7): `getInstalledNavApps(pickup)`; 1 uygulama → doğrudan açılır; >1 → Action Sheet ("Google Maps / Yandex Navigasyon / …"; "Varsayılan yap" seçeneği); 0 → web fallback. Koordinat `snapshot.pickup`. Açılamazsa `T.ride.detail.navFailed` ("Harita açılamadı. Adresi elle girin.") + adres metni kopyala düğmesi. Navigasyona geçince uygulama arka plana gider; konum yayını sürer; dönüşte `session_sync_request` |
| **MÜŞTERİ ALINDI / TAMAMLA** | Dokununca **onay** `T.ride.complete.confirm` ("Müşteriyi aldınız mı? Yolculuk kapanacak." — TAMAMLA / VAZGEÇ; VAZGEÇ varsayılan odak). Onay → `emitWithAck('ride_complete', { rideId, version })`. Ok → D3 (tamamlandı bildirimi, kısa) → ana ekran, şoför yeniden `available` (yerel; `session_sync_request` ile doğrulanır). `VERSION_CONFLICT`/`INVALID_TRANSITION` → `session_sync_request`; durum `completed` ise sessizce kapanır, değilse `T.ride.detail.changed` |
| DURAĞI ARA | `Linking.openURL('tel:' + stand.phone)`; yalnızca durak (müşteri değil). Telefon numarası ekranda tam yazılmaz (düğme etiketi yeterli) |
| **Çağrıyı iptal et** | İkincil/metin stili, ekranın en altında, NAVİGASYON ve TAMAMLA'dan ≥ 48 dp uzakta. Dokununca **onay diyaloğu** (aşağıda). Kazara basılmaması için düğme ilk 1 sn'de değil, **kalıcı olarak** birincil hedeflerden ayrık |
| Konum durumu çipi | Konum görevi çalışıyor mu (Faz 2 çipi); paylaşılmıyorsa sarı şerit `T.ride.detail.noLocation` + **KONUM PAYLAŞ** (yalnızca çıkış/yeniden giriş sonrası `offline` iken; Bölüm 4.8) |

**İptal diyaloğu (şoför)**
```
│ Çağrıyı iptal et?                    │
│ Çağrı yeniden aranacak, bir daha bu  │
│ çağrıyı almayacaksınız.              │
│ Sebep (isteğe bağlı):                │
│ [Araç arızası][Müşteriye ulaşamadım] │
│ [Diğer]                              │
│ [ VAZGEÇ ]          [ ÇAĞRIYI İPTAL ET ] │  VAZGEÇ: büyük, varsayılan odak; iptal: ikincil kırmızı çerçeve
```
- Onay → `emitWithAck('ride_driver_cancel', { rideId, reason?, version })`. Ok → ana ekran, `T.ride.detail.cancelledByYou` ("Çağrıyı iptal ettiniz. Yeniden aktifsiniz."). Şoför sunucuda `available` döner; UI `session_sync_request` ile doğrular. Reason etiketleri sabit; serbest yazı yok (araçta yazı girişi yok).
- `VERSION_CONFLICT`/`INVALID_TRANSITION` → `session_sync_request`; ride durak tarafından iptal edildiyse D3 (durak iptali).
- Zaman aşımı → "Sonuç bekleniyor…"; `session_sync_request` belirler.

**D2 durumları**
| Durum | UI |
|---|---|
| Yükleniyor (soğuk açılış, `session_sync` gelmedi; yalnızca önbelleğe alınmış `activeRide` var) | Önbellekteki kart **soluk** + "Güncelleniyor…"; Navigasyon **etkin** (adres yerelde var), Tamamla/İptal devre dışı |
| Hata (ack) | İlgili dokunuşun altında kırmızı olmayan satır içi mesaj; düğme yeniden etkin |
| Çevrimdışı (bağlantı yok) | Sarı şerit `T.ride.detail.offline` ("Bağlantı yok. Navigasyon kullanılabilir."); **NAVİGASYON etkin kalır** (yerel veriyle); TAMAMLA ve "Çağrıyı iptal et" devre dışı (sunucu onayı gerekir); bağlanınca otomatik etkin |
| `matched` | Yukarıdaki düzen |
| `completed` (kendi veya durak) | D3 (kısa) → ana ekran |
| `cancelled` (durak iptal) | D3 (iptal) |
| `searching` (şoför iptalinden/aktarımdan sonra) | D2'de `searching` görünmez: bu durum şoför için "yolculuk bitti" demektir → ana ekran |

## 4.6 D3 — Yolculuk kapandı (`ride/closed`)
Tam ekran, tek büyük metin, TAMAM düğmesi (88 dp); otomatik kapanmaz **iptal** için (kaçırılmasın), tamamlamada 4 sn sonra otomatik ana ekran.

| Tetik | Başlık | Gövde | Ek |
|---|---|---|---|
| `ride_cancelled` (durak iptal) | "Çağrı iptal edildi" | `T.ride.closed.cancelled` ("Durak çağrıyı iptal etti. Navigasyona gerek yok.") + varsa sebep | Haptik `warning`; ses kısa; Navigasyon uygulamasına müdahale edilemez (şoför harita uygulamasında olabilir: bu yüzden uygulama öne gelince bu ekranı görür; uygulama arka plandaysa yerel bildirim `T.ride.notif.cancelled`) |
| `ride_completed` (durak tamamladı, E-2) | "Yolculuk tamamlandı" | `T.ride.closed.completedByStand` ("Durak yolculuğu tamamladı.") | Haptik `success` |
| Kendi tamamlaması | "Yolculuk tamamlandı" | `T.ride.closed.completed` ("Teşekkürler. Yeniden aktifsiniz.") | 4 sn sonra otomatik |
| Askıya alma ile düşme | (bkz. 4.8) giriş ekranı | – | – |

Tüm durumlarda TAMAM → E4. Şoför sunucuda `available`'a döner (yerel `session_sync_request` ile doğrulanır); dönmediyse E4 AKTİF OL gösterir.

## 4.7 Ride durumlarına göre şoför ekranı özeti

| Ride durumu | Şoför ne görür |
|---|---|
| `searching` (çağrı teklifi) | D1 listesi: Kabul/Reddet. Teklif kalkınca D1'den kalkar |
| `matched` (kendi) | D2 |
| `matched` (başka şoföre) | `ride_taken`: çağrı D1'den kalkar, "başka şoföre gitti" toast'ı |
| `completed` | D3 → E4 |
| `cancelled` (durak) | D3 → E4 |
| Şoför iptal etti | E4 + bilgi kartı |

**Sürüm kuralı:** `ride_accepted`, `ride_cancelled`, `ride_completed` yerel `version`'dan küçükse yok sayılır. `ride_accepted` (diğer cihaz oturumları için de gelir) D2'yi açar/yeniler.

## 4.8 Çıkış, askıya alma ve yeniden giriş (aktif yolculukla)

**Varsayım (E-4):** çıkış yolculuğu **düşürmez**; askıya alma düşürür.

**Çıkış yap (E6) — aktif yolculuk varken**
- E6'daki çıkış düğmesi **devre dışı değil** (Faz 2 S15 varsayımı bu belgeyle değişir, Q1 onaylanırsa). Diyalog metni farklıdır:

```
│ Aktif yolculuğunuz var.              │
│ Çıkış yapsanız da yolculuk sürer;    │
│ tekrar girince devam eder. Çıkarsanız│
│ konumunuz paylaşılmaz.               │
│ [ VAZGEÇ ]            [ ÇIKIŞ YAP ]  │  VAZGEÇ varsayılan odak
```
  (`T.ride.logout.confirmBusy`). Faz 2 `T.logout.busy` artık kullanılmaz. Hesap tüm cihazlarda kapanır; yolculuk durakta açık görünmeye devam eder.
- Diğer akış (konum görevi durur, `POST /auth/logout`, ağ hatası diyaloğu) Faz 2 ile aynıdır.
- Şoför çıkarken D2'deydi → E1.

**Tekrar girişte**
- Giriş → `GET /me` → socket → `session_sync`. `activeRide` varsa E5 (izin) atlanmaz; ardından **doğrudan D2**.
- `driverStatus` `offline` ama `activeRide` var (E-4'e göre olası): D2 gösterilir, üstte sarı şerit `T.ride.detail.noLocation` ("Konumunuz paylaşılmıyor.") ve **KONUM PAYLAŞ** düğmesi → izin/GPS/fix → `driver_go_online` (sunucu `busy` döner; konum görevi başlar). Bu düğmeye basılmazsa Tamamla/iptal/Navigasyon **yine çalışır** (konum yalnızca durak haritası içindir).
- `activeRide` yoksa ve `openRequests` varsa D1.
- Ağ yoksa açılış: önbellekteki `activeRide` (adres, kısa kod) soluk gösterilir, Navigasyon etkin (D2 durumları).

**Askıya alma sırasında aktif yolculuk**
- Yönetici askıya alır → sunucu socket'i keser, `forceOffline`; eşleşme düşer (yolculuk yeniden aranır; durak E-3 ile bilgilendirilir).
- Şoför uygulaması ön plandaysa: bağlantı kopar → refresh/connect `ACCOUNT_SUSPENDED` → oturum sonlandı akışı → E1. E1 şeridi, oturum sonlandığında aktif yolculuk varsa: `T.ride.session.suspendedWithRide` ("Hesabınız askıya alındı. Yolculuk başka şoföre aktarıldı. Durağınızla görüşün."). İstemci son bilinen `activeRide`'ı oturum sonlandırmada temizler ve **navigasyon uygulamasına müdahale etmez**.
- Uygulama arka plandaysa: yerel bildirim `T.ride.notif.suspended` ("Hesabınız askıya alındı. Yolculuk iptal edildi."); ama kopukluk nedeniyle bildirim gecikebilir (Q5).
- Kopukluk/ağ sorunundan kaynaklı bir düşme (askıya alma değil) ride'ı **düşürmez**: sweeper `busy` şoförü düşürmez (CLAUDE.md Senaryo 3); şoför dönünce `session_sync.activeRide` ile D2'ye döner.

## 4.9 Event → UI tablosu (şoför, Faz 3)

| Event / çağrı | Yön | UI tepkisi |
|---|---|---|
| `ride_requested` | S→C | Listeye ekle (mesafeye göre sıralı); ilk ise D1 otomatik aç + ses/titreşim (4.4); ek ise bip + YENİ rozeti. Yinelenen `rideId` güncellenir (yüksek sürüm) |
| `ride_taken { rideId }` | S→C | Çağrıyı listeden kaldır (yerelde kabul bekleyen ise ack sonucu belirler); kalan yoksa E4; toast |
| `ride_accept` | C→S | 4.3 |
| `ride_accepted` | S→C | D2'yi aç/yenile (başka cihaz oturumu dahil) |
| `ride_decline` | C→S | 4.3 (4 sn gecikmeli, geri alınabilir); hata sessiz (ret zaten çağrıyı listeden çıkarmıştır; `INTERNAL` → çağrı yeniden görünür ve `T.ride.req.declineFailed`) |
| `ride_cancelled` | S→C | D3 (durak iptali); sürüm kontrolü |
| `ride_completed` (E-2) | S→C | D3 (durak tamamladı) |
| `ride_driver_cancel` | C→S | 4.5 |
| `ride_complete` | C→S | 4.5 |
| `session_sync` | S→C | `activeRide` → D2; `openRequests` → D1 listesi (değiştirir); `driverStatus` Faz 2 tablosu |
| `session_sync_request` | C→S | Ön plana dönüş, kabul/iptal zaman aşımı, D3 sonrası doğrulama |
| `driver_location_update` | C→S | Faz 2; `busy` iken de sürer |

## 4.10 Şoför erişilebilirlik (Faz 2 Bölüm 8'e ek)
- **Kabul/Reddet** düğme etiketleri bağlamlı: "Kabul et. Çağrı K7M2QX, 1,2 kilometre uzakta, Moda Caddesi 12". Odaklı kart değişince canlı bölge duyurusu: "Çağrı {n}/{toplam}".
- Yeni çağrı: `AccessibilityInfo.announceForAccessibility` ile "Yeni çağrı. 1,2 kilometre. Moda Caddesi 12." (yalnızca ilk çağrı; ek çağrıda "Yeni çağrı daha. Toplam {n}." ).
- Geçen süre her saniye okunmaz; yalnızca dakika eşiklerinde ("2 dakika önce") güncellenir.
- Durum yalnızca renk değil: ikon şekli + metin (Kabul = onay işareti, Reddet = çarpı, Navigasyon = ok).
- Yazı: mesafe ve adres en büyük metin (≥ 28 sp); 200% ölçekte adres 3 satıra kadar sarılır, düğmeler sabit kalır, içerik kaydırılabilir ve **KABUL/REDDET ekranın altına yapışıktır** (kaydırmaya girmez).
- Haptik: kabul `success`, başka şoföre gitti `warning`, iptal bildirimi `warning`.
- Hareketi azalt: kart geçişleri yok, YENİ rozeti sabit.
- Yatay yön desteklenir (araç tutucusu).
- Ses tek başına bilgi taşımaz (her ses olayının görsel karşılığı vardır).

---

# Bölüm 5 — Metinler (Türkçe; Faz 2 kimliklerini tamamlar)

**Panel (`T.stand.*`)**
| Kimlik | Metin |
|---|---|
| `T.stand.login.err.credentials` | Kullanıcı adı veya şifre hatalı. |
| `T.stand.login.err.rateLimited` | Çok fazla deneme. {süre} sonra tekrar deneyin. |
| `T.stand.pending.body` | Durağınız onay bekliyor. Yönetici onaylayınca giriş yapabilirsiniz. |
| `T.stand.suspended.body` | Durak hesabı askıya alındı. Yöneticiyle görüşün. |
| `T.stand.session.ended` | Oturum sona erdi. Tekrar giriş yapın. |
| `T.stand.err.network` / `server` | İnternet bağlantısı yok. Tekrar deneyin. / Sunucuya ulaşılamadı. Biraz sonra tekrar deneyin. |
| `T.stand.form.title` | Yeni çağrı |
| `T.stand.form.submit` | ÇAĞRI OLUŞTUR |
| `T.stand.form.submitting` | Gönderiliyor… |
| `T.stand.form.needPin` | Haritada alış noktasını seçin. |
| `T.stand.form.addressManual` | Adres bulunamadı. Adresi yazın. |
| `T.stand.form.offline` | Bağlantı yok. Çağrı oluşturulamıyor. |
| `T.stand.form.timeout` | Yanıt gelmedi. Çağrı oluşmuş olabilir; listeyi kontrol edin. |
| `T.stand.form.created` | Çağrı oluşturuldu: {kod} |
| `T.stand.form.duplicate` | Bu adrese açık çağrı var: {kod} |
| `T.stand.form.err.validation` | Bilgileri kontrol edin. |
| `T.stand.form.err.rateLimited` | Çok hızlı. Birkaç saniye bekleyin. |
| `T.stand.form.err.internal` | Çağrı oluşturulamadı. Tekrar deneyin. |
| `T.stand.map.tilesFailed` | Harita yüklenemedi. Adresi yazın. |
| `T.stand.list.title / empty / loading` | AÇIK ÇAĞRILAR / Açık çağrı yok. Soldan çağrı oluşturun. / Yükleniyor… |
| `T.stand.list.stale` | Bağlantı yok. Kartlar son bilinen durumu gösteriyor. |
| `T.stand.list.closedWhileAway` | {n} çağrı siz yokken kapandı. |
| `T.stand.card.searching` | ARANIYOR |
| `T.stand.card.matched` | EŞLEŞTİ |
| `T.stand.card.detail` | {süre} · {dalga}. tarama · {km} km · {n} şoföre bildirildi |
| `T.stand.card.noDrivers` | Yakında aktif araç yok. Arama sürüyor. |
| `T.stand.card.stillOpen` | {n} dakikadır aranıyor. |
| `T.stand.card.keepWaiting` | BEKLEMEYE DEVAM |
| `T.stand.card.driverCancelled` | {ad} ({plaka}) vazgeçti. Arama yeniden başladı. |
| `T.stand.card.driverSuspended` | {ad} ({plaka}) hesabı kapatıldı. Arama yeniden başladı. |
| `T.stand.card.changed` | Çağrı durumu değişti. |
| `T.stand.card.unknown` | Sonuç bilinmiyor. Bağlantı gelince güncellenecek. |
| `T.stand.card.complete` / `cancel` | TAMAMLANDI / İPTAL ET |
| `T.stand.cancel.title` | Çağrı iptal edilsin mi? |
| `T.stand.cancel.matchedNote` | {ad} yola çıkmış olabilir; şoföre haber verilecek. |
| `T.stand.complete.title` | Yolculuk tamamlandı mı? |
| `T.stand.complete.note` | Şoför tamamlamadıysa siz kapatın. |
| `T.stand.settings.note` | Değişiklik yalnızca sonraki çağrılara uygulanır. |
| `T.stand.settings.err.range` | En büyük yarıçap, başlangıçtan küçük olamaz. |
| `T.stand.logout.confirmOpen` | Açık çağrılar sürer; tekrar girince görünür. |
| `T.stand.a11y.matched` | Çağrı {kod} eşleşti. Şoför {ad}, plaka {plaka}. |

**Şoför (`T.ride.*`)**
| Kimlik | Metin |
|---|---|
| `T.ride.home.openRequests` | {n} açık çağrı |
| `T.ride.home.activeRide` | Aktif yolculuk · {kod} |
| `T.ride.home.goToRide` | YOLCULUĞA GİT |
| `T.ride.home.busyHint` | Yolculuk sürerken durumunuz değişmez. |
| `T.ride.home.busyTitle` | YOLCULUKTASINIZ |
| `T.ride.banner.newRequest` | Yeni çağrı var. GÖR |
| `T.ride.req.title` | Gelen çağrı |
| `T.ride.req.accept` / `decline` | KABUL ET / REDDET |
| `T.ride.req.accepting` | Kabul ediliyor… |
| `T.ride.req.distance` | {mesafe} uzakta |
| `T.ride.req.elapsed` | {süre} önce |
| `T.ride.req.new` | YENİ |
| `T.ride.req.others` | DİĞER ÇAĞRILAR ({n}) |
| `T.ride.req.taken` | Çağrı başka şoföre gitti. |
| `T.ride.req.notAvailable` | Şu an çağrı alamazsınız. |
| `T.ride.req.closedToast` | Çağrı kapandı. |
| `T.ride.req.declined` / `undo` | Reddedildi. / GERİ AL |
| `T.ride.req.declineFailed` | Ret gönderilemedi. Çağrı yeniden görünüyor. |
| `T.ride.req.offline` / `offlineStrip` | Bağlantı yok. / Bağlantı yok. Kabul için bağlantı gerekir. |
| `T.ride.req.waiting` | Sonuç bekleniyor… |
| `T.ride.req.unknown` | Sonuç alınamadı. Çağrı kapanmış olabilir. |
| `T.ride.req.err.internal` | Kabul edilemedi. Tekrar deneyin. |
| `T.ride.detail.matched` | EŞLEŞTİNİZ |
| `T.ride.detail.pickup` / `dropoff` / `note` | ALIŞ NOKTASI / VARIŞ / NOT |
| `T.ride.detail.navigate` | NAVİGASYON |
| `T.ride.detail.complete` | MÜŞTERİ ALINDI / TAMAMLA |
| `T.ride.detail.callStand` | DURAĞI ARA |
| `T.ride.detail.cancel` | Çağrıyı iptal et |
| `T.ride.detail.navFailed` | Harita açılamadı. Adresi elle girin. |
| `T.ride.detail.offline` | Bağlantı yok. Navigasyon kullanılabilir. |
| `T.ride.detail.noLocation` | Konumunuz paylaşılmıyor. |
| `T.ride.detail.shareLocation` | KONUM PAYLAŞ |
| `T.ride.detail.changed` | Yolculuk durumu değişti. |
| `T.ride.detail.cancelledByYou` | Çağrıyı iptal ettiniz. Yeniden aktifsiniz. |
| `T.ride.complete.confirm` | Müşteriyi aldınız mı? Yolculuk kapanacak. |
| `T.ride.cancel.title` | Çağrıyı iptal et? |
| `T.ride.cancel.body` | Çağrı yeniden aranacak. Bu çağrıyı bir daha almayacaksınız. |
| `T.ride.cancel.reasons` | Araç arızası · Müşteriye ulaşamadım · Diğer |
| `T.ride.cancel.cta` | ÇAĞRIYI İPTAL ET |
| `T.ride.closed.cancelled` | Durak çağrıyı iptal etti. Navigasyona gerek yok. |
| `T.ride.closed.completedByStand` | Durak yolculuğu tamamladı. |
| `T.ride.closed.completed` | Teşekkürler. Yeniden aktifsiniz. |
| `T.ride.closed.ok` | TAMAM |
| `T.ride.logout.confirmBusy` | Aktif yolculuğunuz var. Çıkış yapsanız da yolculuk sürer; tekrar girince devam eder. Çıkarsanız konumunuz paylaşılmaz. |
| `T.ride.session.suspendedWithRide` | Hesabınız askıya alındı. Yolculuk başka şoföre aktarıldı. Durağınızla görüşün. |
| `T.ride.notif.cancelled` | Durak çağrıyı iptal etti. |
| `T.ride.notif.suspended` | Hesabınız askıya alındı. Yolculuk iptal edildi. |
| `T.ride.a11y.newRequest` | Yeni çağrı. {mesafe}. {adres}. |

---

# Bölüm 6 — Kenar durumlar (özet)

| Durum | Davranış |
|---|---|
| İki tablet aynı anda aynı çağrıyı iptal eder | İlk olan kazanır; ikincisi `INVALID_TRANSITION` alır → sessizce `cancelled` gösterilir |
| Şoför kabul eder, aynı anda durak iptal eder | Yarışı sunucu çözer; şoför ya `RIDE_NOT_AVAILABLE` alır ya D3 (iptal) görür |
| Şoför ve durak aynı anda tamamlar | İkincisi `INVALID_TRANSITION`/`VERSION_CONFLICT`; sonuç `completed` olduğu için hata gösterilmez |
| Durak eşleşmiş şoför olmadan çağrıyı iptal eder | Şoföre `ride_cancelled` (D3) |
| Çağrı adresi çok uzun | Panelde 2 satır + "…"; şoför ekranında tam metin, 3 satıra kadar, sonra kaydırma |
| Panel iki sekmede açık | İkisi de `stand:{id}` odasına bağlanır; aynı kartlar; ses iki kez çalabilir (Q10) |
| Şoför D1'deyken pasife düşer | D1 kapanır, liste silinir, Faz 2 bildirim kartı |
| Şoför D1'de çağrıyı okurken ekranı kilitler | Kilit açılınca `session_sync_request`; kapanan çağrılar kalkar |
| Saat kayması (cihaz ≠ sunucu) | Geçen süre ≥ 0'a sabitlenir; büyük kayıp (> 5 dk fark) için E-6 |
| `ride_searching` sırası bozuk geldi (eski `version`) | Yok sayılır |
| Çok sayıda açık çağrı (panel > 6, şoför > 5) | Panelde kaydırılabilir liste; şoförde odaklı kart + liste (en çok 10 gösterilir, fazlası "+{n} çağrı daha") |
| Bildirilen şoför sayısı 0 iken eşleşme | `matched` kartı hemen görünür (sonradan aktif olan şoför kabul etmiş olabilir) |

---

# Bölüm 7 — Açık sorular

| # | Soru | Varsayım (bu belgede) | Öneri / etki |
|---|---|---|---|
| Q1 | **Faz 3 `busy` kararı:** çıkışta ve askıya almada eşleşmiş ride'ın akıbeti. CLAUDE.md'de `forceOffline` `busy` şoförü koşulsuz offline yapıyor | Çıkış: ride **korunur**, tekrar girişte D2; askıya alma: ride `searching`'e döner, şoför `excluded` (E-4). Bu belgedeki metinler buna dayanır | Sunucu tarafı: `forceOffline` `busy` şoförde hash durumunu korumalı veya `session_sync` `activeRide`'ı `offline`'da da döndürmeli. Kabul testine "çıkış + yeniden giriş → aynı ride" ve "askıya alma → searching" eklenmeli. Alternatif (çıkışı `busy`'de engellemek) daha basit ama şoförü kilitler (S15) |
| Q2 | Durağın tamamlayabilmesi için `/stand` `ride_complete` ve şoföre `ride_completed` event'leri yok | E-1, E-2 eklenir | Önce `packages/shared`, sonra CLAUDE.md Bölüm 6 |
| Q3 | Reddet için 4 sn "GERİ AL" gecikmesi (`ride_decline` geç gönderilir). Ret geri alınamıyor ve kazara dokunma riski var | Gecikme yalnızca istemcide | Alternatif: onay diyaloğu (araçta dikkat dağıtır) ya da sunucuda geri alma (`ride_undecline`) — yeni event |
| Q4 | Şoför bildirimleri `available`'ken geliyor; `session_sync.openRequests` ride başına `distanceM`'i nasıl veriyor (yeniden bağlanmada)? | Bildirim anındaki mesafe aynen döner | Doğrulanmalı; mesafe taze hesaplanırsa "uzakta" değişebilir |
| Q5 | Askıya alınan şoför arka plandaysa bildirimi nasıl alır? Socket kopar, push Faz 5 | Yerel bildirim yalnızca uygulama çalışıyorsa | Faz 5 push'a "hesap askıya alındı" türü eklenmeli |
| Q6 | Çağrı sesini kapatma izni (yalnızca titreşim) | Varsayılan açık; Hesap'ta anahtar | Ürün kararı: sessize alınırsa çağrı kaçırma riski |
| Q7 | Durak geocoding sağlayıcısı (Nominatim kullanım sınırı/ücret, ticari sağlayıcı) ve ters geocoding kalitesi | Sağlayıcı soyut; adres elle düzeltilebilir | Pilot öncesi seçim; Türkçe adres kalitesi sahada denenmeli |
| Q8 | `createdAt`/`searchingSince` cihaz saatiyle karşılaştırılıyor (saat kayması negatif/hatalı süre) | ≥ 0'a sabitleme | `serverNow` alanı (E-6) |
| Q9 | Panelde geçmiş/bitmiş çağrılar: `session_sync` yalnızca aktifleri verir; REST geçmiş ucu yok | Yalnızca oturumluk "Son çağrılar" | Faz 6 raporu için `GET /stands/me/rides` |
| Q10 | Aynı durağın birden çok tableti: sesler iki kez çalar; hangisi "birincil" | Hepsi çalar | Ayar: "Bu cihazda ses" |
| Q11 | Panelde refresh token `localStorage`'da (XSS riski); sunucu httpOnly çerez sunmuyor | `localStorage`, 30 gün | Kiosk tek amaçlı olduğundan kabul; alternatif httpOnly çerez için sunucu değişikliği |
| Q12 | Durak kaydı (`POST /auth/stand/register`): panelde kayıt ekranı yok; konum/ad girişi gerektirir | Panelde kayıt **yok**; hesaplar yönetici/kurulumla açılır | Pilot için kurulum belgesi; yönetici paneli ayrı iş |
| Q13 | Şoför iptali sebepleri ve durak iptal sebepleri sabit etiket; sunucuda serbest metin ≤ 120 | Sabit etiketler | Ürün: rapor için sebep kategorileri (Faz 6) |
| Q14 | Durak tamamlama akışında şoförün konum paylaşımı/`busy` durumu nasıl çözülür (şoför uygulaması kapalıysa) | Sunucu `busy`'yi temizler, şoför `available`'a döner | Sunucu kararı; şoförün sonraki `session_sync`'i düzeltir |
| Q15 | Mesafe gösterimi: alış noktasına kuş uçuşu (GEO) mesafe, yol mesafesi değil | Etiket "uzakta" | Yol mesafesi için harici servis gerekir; pilotta kuş uçuşu yeterli mi? |
| Q16 | Şoföre `ride_requested` geldiğinde ön plan açık olmasa da yerel bildirim Faz 5'e kadar yok | Faz 3'te yalnızca ön planda ses | Faz 3 sahada uygulama ön planda kullanılmalı; Faz 5 push bunu çözer |
