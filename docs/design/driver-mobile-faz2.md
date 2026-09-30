# Şoför Uygulaması — Faz 2 Ekran Tasarımı (varlık, konum, oturum)

- **Uygulama:** `apps/driver-mobile` (Expo SDK, Expo Router, TypeScript)
- **Kullanıcı:** Taksi şoförü. Telefon araç tutucusunda durur, ekrana sürüş sırasında bir bakışta bakılır.
- **Kapsam:** Giriş, (minimal) kayıt, onay bekleme, ana ekran (Aktif/Pasif), konum izni akışı, bağlantı ve oturum durumları, Hesap ekranı.
- **Kapsam dışı:** Çağrı ekranları (Faz 3), Kabul/Detay + Navigasyon (Faz 4), push bildirimleri (Faz 5). Bunlar için yalnızca rota ve ekran alanı ayrılmıştır.
- **Kaynak sözleşme:** `packages/shared/src/{events,schemas,types,redis,auth}.ts`, sunucu davranışı `apps/api/src/realtime.ts`, `apps/api/src/presence/service.ts`, `apps/api/src/auth/*`.
- Ücret, ödeme, müşteri adı ya da telefonu gösteren hiçbir öğe yoktur (sistemde yoktur).

---

## 1. Sunucudan çıkan, tasarımı belirleyen gerçekler

| Gerçek | Kaynak | Tasarıma etkisi |
|---|---|---|
| Access token 15 dk, refresh 30 gün; `accessExpiresIn` saniye cinsinden login/refresh yanıtında gelir | `auth/tokens.ts` | İstemci süreyi bilir; proaktif yenileme yapabilir |
| Access süresi dolunca `auth_expired`; 30 sn içinde `auth_refresh` gelmezse sunucu socket'i keser (`io server disconnect`) | `realtime.ts` | Sessiz yenileme 30 sn içinde bitmeli; kesilirse istemci **elle** yeniden bağlanmalı (socket.io-client sunucu kesmesinde otomatik bağlanmaz) |
| `auth_refresh` başarısızsa (askıya alma vb.) sunucu ack'te kodu döner ve socket'i keser | `realtime.ts` | Ack koduna göre girişe dönüş |
| Handshake reddi `connect_error`: `err.message` = kod (`UNAUTHORIZED`, `FORBIDDEN`, `ACCOUNT_PENDING`, `ACCOUNT_SUSPENDED`, `INTERNAL`) | `realtime.ts` | `UNAUTHORIZED` hem "access süresi doldu" hem "oturum iptal edildi" demektir: önce refresh denenir |
| Her bağlanmada `session_sync { driverStatus, openRequests: [] }` gelir | `realtime.ts` | Tek doğruluk kaynağı; UI buna göre düzeltilir |
| Offline şoför konum gönderirse sunucu `session_sync { driverStatus: 'offline', offlineReason, presenceVersion }` gönderir | `realtime.ts` | Sweeper düşürmesinin istemciye bildirim yolu. Sebep `offlineReason` ile gelir (`user` · `stale_heartbeat` · `forced` · `not_online`; S1 karar verildi) |
| Bağlıyken güncel durum `session_sync_request` (C→S, ack = `DriverSessionSync`) ile istenebilir | `events.ts`, `realtime.ts` | Arka plandan dönüşte ve sync gelmediğinde socket yeniden kurulmaz (S3 karar verildi) |
| Socket kopması presence'ı düşürmez; son konumdan 60 sn sonra (+ en çok 10 sn tarama) sweeper `offline` yapar | `redis.ts` `PRESENCE` | Kopukluğun ilk dakikası "tolerans"tır; sonrası "muhtemelen pasife düştünüz" |
| Konum throttle 1/sn, ack'siz; sunucu `ts`'e güvenmez, kendi saatini yazar | `realtime.ts`, `service.ts` | "Son gönderim" yalnızca istemci tahminidir. Tamponlanmış eski konum sunucuda "taze" görünür → konum `volatile` gönderilmeli |
| `driver_go_online` konum ister; ack `{ status: 'available' \| 'busy' }` | `schemas.ts`, `realtime.ts` | Aktif olmadan önce konum düzeltmesi (fix) alınmalı |
| `driver_go_offline` `busy` iken `INVALID_TRANSITION` döner | `service.ts` | Faz 3'te anlamlı; Faz 2'de metni hazır |
| Bağlantı kontrolleri başarısız olursa (`ready=false`) handler **ack çağırmadan** döner | `realtime.ts` | Her ack'li emit zaman aşımıyla gönderilir (`socket.timeout(10_000).emitWithAck`) |
| `POST /auth/logout` tüm cihazları kapatır, socket'leri keser, şoförü `forceOffline` yapar | `auth/routes.ts` | Çıkış öncesi `driver_go_offline` gerekmez |
| Giriş hız sınırı: IP başına 60/dk, hesap başına 10 başarısız / 15 dk; `ACCOUNT_PENDING` (403) de başarısız sayılır | `auth/limits.ts` | Onay bekleyen şoför sık denerse kilitlenir; bekleme ekranı bunu önler |

---

## 2. Ekran listesi ve navigasyon (Expo Router)

```
app/
  _layout.tsx                 Kök: oturum kapısı (booting → (auth) | (app)), tema (koyu varsayılan)
  (auth)/
    _layout.tsx               Oturum yoksa erişilir; oturum varsa (app)'e yönlendirir
    login.tsx                 E1 Giriş
    register.tsx              E2 Kayıt (minimal)
    pending.tsx               E3 Onay bekleniyor
  (app)/
    _layout.tsx               Oturum şart; socket + konum servisini başlatır, global uyarı şeridi
    index.tsx                 E4 Ana ekran (Aktif/Pasif)
    permissions.tsx           E5 Konum izni akışı (modal sunum)
    account.tsx               E6 Hesap (profil, izinler, çıkış)
    ride/                     Faz 3/4 yer tutucu (tasarlanmadı)
      request/[rideId].tsx    Faz 3: gelen çağrı
      [rideId].tsx            Faz 4: Kabul/Detay + Navigasyon
```

Geçişler:

```
 açılış ──► (booting: SecureStore'da refresh token var mı?)
             │ yok                         │ var
             ▼                             ▼
          E1 Giriş ◄──── oturum geçersiz ── refresh → socket → session_sync ──► E4 Ana ekran
           │   ▲                                                                 │  │
   "Kayıt ol"  │ "Girişe dön"                                     izin yok/eksik │  │ "Hesap"
           ▼   │                                                                 ▼  ▼
          E2 Kayıt ──► E3 Onay bekleniyor                                        E5  E6 ──"Çıkış yap"──► E1
           E1 ──ACCOUNT_PENDING──► E3
```

- E4 kök ekrandır; geri tuşu (Android) E4'te uygulamayı arka plana alır, **kapatmaz** (aktifken önemli).
- E5 hem ilk girişten sonra (izin `undetermined` ise) hem de E4'te "AKTİF OL"a basıldığında izin eksikse modal açılır.
- Faz 3'te `session_sync.activeRide` veya `ride_requested` geldiğinde `ride/...` rotalarına geçilecek; Faz 2'de bu alanlar yok sayılır ama `driverStatus: 'busy'` gelirse E4 "Aktif işiniz var" yer tutucu kartını gösterir (Bölüm 5, satır B1).

---

## 3. İstemci durum makinesi

### 3.1 Boyutlar (zustand store)

| Boyut | Değerler | Kaynağı |
|---|---|---|
| `auth` | `booting` · `signedOut` · `signedIn` · `refreshing` | SecureStore, `/auth/login`, `/auth/refresh` |
| `conn` | `idle` · `connecting` · `connected` · `disconnected` (+ `disconnectedAt`) | socket.io-client olayları |
| `server` (son bilinen `driverStatus`) | `unknown` · `offline` · `available` · `busy` | `session_sync`, `driver_go_online/offline` ack'leri |
| `intent` (bekleyen kullanıcı isteği) | `none` · `goingOnline` · `goingOffline` · `offlinePending` | Kullanıcı dokunuşu |
| `perm` | `undetermined` · `denied` · `deniedForever` · `foreground` · `background` | `expo-location` |
| `gps` | `on` · `off` | `hasServicesEnabledAsync` |
| `fix` | `none` · `good` (≤ 50 m) · `poor` (> 50 m) · `stale` (son fix > 30 sn) | konum görevi |
| `lastSentAt` | epoch ms | Bağlıyken yapılan son `driver_location_update` emit'i |
| `app` | `active` · `background` | `AppState` |

`server = unknown` yalnızca açılışta ilk `session_sync` gelene kadardır; kopmada son bilinen değer korunur ama "doğrulanmamış" sayılır.

### 3.2 Türetilmiş ana durum (öncelik sırasıyla ilk eşleşen kazanır)

| # | Koşul | Ana ekran durumu | Renk | Buton |
|---|---|---|---|---|
| A1 | `auth = signedOut` | → E1 Giriş | – | – |
| A2 | `server = unknown` ve `conn ≠ connected` | **Bağlanıyor** (iskelet) | gri | devre dışı |
| A3 | `intent = goingOnline` | **Aktif olunuyor…** | gri | döner gösterge, devre dışı |
| A4 | `intent = goingOffline` | **Pasif olunuyor…** | gri | döner gösterge, devre dışı |
| A5 | `intent = offlinePending` | **Pasife geçiliyor** — bağlantı gelince onaylanacak | gri | devre dışı |
| B1 | `server = busy` | **Aktif işiniz var** (Faz 3 yer tutucu) | mavi | yok |
| C1 | `server = available`, `conn = disconnected`, kopukluk ≥ 60 sn | **Durum bilinmiyor** — muhtemelen pasife düştünüz | kırmızı | "PASİF OL" (yerel) |
| C2 | `server = available`, `conn = disconnected`, 15–60 sn | **AKTİF** + "Bağlantı yok" uyarısı | sarı | "PASİF OL" |
| C3 | `server = available`, `perm` < `foreground` veya `gps = off` | **AKTİF** + "Konum alınamıyor" kritik uyarı | kırmızı | "PASİF OL" + "Konumu aç" |
| C4 | `server = available`, `fix = stale` veya `now - lastSentAt > 20 sn` | **AKTİF** + "Konum gönderilemiyor" | sarı | "PASİF OL" |
| C5 | `server = available`, `fix = poor` veya `perm = foreground` | **AKTİF** + bilgi uyarısı | yeşil + sarı şerit | "PASİF OL" |
| C6 | `server = available`, geri kalan her şey iyi (kopukluk < 15 sn dahil) | **AKTİFSİNİZ** | yeşil | "PASİF OL" |
| D1 | `server = offline`, `perm = deniedForever` | **PASİFSİNİZ** + "Konum izni kapalı" | gri | "AYARLARI AÇ" |
| D2 | `server = offline`, `conn ≠ connected` | **PASİFSİNİZ** + "Bağlantı yok" | gri | "AKTİF OL" soluk; dokununca açıklama |
| D3 | `server = offline` | **PASİFSİNİZ** | gri | "AKTİF OL" |

Kopukluğun ilk 15 sn'si bilinçli olarak sessizdir (yalnızca üstteki bağlantı çipi değişir): mobil ağda kısa kopmalar olağandır ve her birinde sarı uyarı göstermek şoförü gereksiz yere meşgul eder.

### 3.3 Geçiş diyagramı (`server` × `intent`)

```
                 dokun "AKTİF OL"                 ack ok {available}
 offline ─────────────────────────► goingOnline ─────────────────────► available
    ▲   izin/GPS/bağlantı kontrolü     │  ack hata / 10 sn zaman aşımı       │  │
    │   başarısızsa bu adıma geçilmez   ▼                                     │  │ session_sync{offline}
    │                               offline (hata mesajı)                    │  │ (sweeper/uzun kopma)
    │                                                                        │  ▼
    │         ack ok {offline}                 dokun "PASİF OL" (bağlı)      │ offline + "Pasife alındınız"
    ├──────────────────────────── goingOffline ◄─────────────────────────────┤
    │                                   │ zaman aşımı / bağlı değil           │
    │  yeniden bağlanınca session_sync  ▼                                     │
    └────────────────────────── offlinePending ◄──── dokun "PASİF OL" (bağlı değil)
         (available ise go_offline gönderilir)
```

### 3.4 Kurallar (frontend geliştirici için bağlayıcı)

1. **Konum yalnızca `server = available` (Faz 3: `busy`) iken ve `conn = connected` iken gönderilir.** Pasifken veya go_online ack'i gelmeden gönderilen konum, sunucunun `session_sync{offline}` göndermesine yol açar.
2. Konum `socket.volatile.emit('driver_location_update', …)` ile gönderilir. Normal `emit` kopukken tamponlanır ve yeniden bağlanınca eski konumlar topluca gider; sunucu `ts`'e değil kendi saatine baktığı için eski konum taze sayılır.
3. Ack'li her emit `socket.timeout(10_000).emitWithAck(...)` ile yapılır; zaman aşımı "sonuç bilinmiyor" sayılır ve son söz bir sonraki `session_sync`'indir.
4. **Aktif olma sırası:** kontroller → konum fix'i → `driver_go_online` → ack ok → konum görevini (foreground service) başlat → ilk konumu hemen gönder. Görev başlatılamazsa `driver_go_offline` gönderilir ve hata gösterilir.
5. **Pasif olma sırası:** konum görevini durdur → `driver_go_offline`. Görev önce durur; böylece ack gelmese bile sweeper şoförü en geç ~70 sn'de düşürür.
6. `session_sync` her geldiğinde `server` ona eşitlenir; `intent` ile çelişki Bölüm 4.5'teki tabloya göre çözülür.
7. Uygulama 30 sn'den uzun arka planda kaldıysa ön plana gelince socket yeniden kurulmaz; bağlıysa `session_sync_request` gönderilir ve ack'teki `DriverSessionSync` 4.5'e göre uygulanır (S3 karar verildi).
8. Ekrana ve loglara ham telefon numarası ve ham koordinat yazılmaz (Bölüm 8).
9. **session_sync bekçisi:** bağlandıktan 5 sn sonra hâlâ `session_sync` gelmemişse (`syncPending`) veya bağlıyken bekleyen pasif isteğinin sonucu bilinmiyorsa (`offlinePending`) `session_sync_request` gönderilir; yanıt gelmezse 2, 4, 8 … en çok 30 sn aralıkla tekrarlanır. `syncPending` sürdükçe konum gönderilmez. Böylece A5 durumu kalıcı kilit olmaz.
10. **Otomatik yeniden aktif olmanın ölçütü ve sınırı (S4):** 10 dk ölçütü, konum görevinden gelen son **normal** gönderime (`lastRoutineSentAt`, kalıcı) göre hesaplanır; aktif olunca yapılan zorunlu ilk gönderim ölçütü yenilemez. Ayrıca son 10 dk içinde en çok **3** otomatik yeniden aktif olma yapılır; aşılırsa otomatik olunmaz ve mavi kart T.sync.droppedRepeated gösterilir (ör. saat kayması yüzünden sweeper her taramada düşürüyorsa sonsuz döngü olmasın). Elle AKTİF OL sayacı sıfırlar.

---

## 4. Ekranlar

Genel görsel dil:
- **Koyu tema varsayılan** (gece kullanımı); açık tema sistem ayarıyla. Zemin `#0B0F14`, metin `#FFFFFF`; ana durum renkleri koyu zeminde kontrastı ≥ 7:1 olacak tonlarda (yeşil `#3DDC84`, sarı `#FFC940`, kırmızı `#FF5C5C`, gri `#9AA4AF` metin). Renk hiçbir zaman tek işaret değildir; her durumda ikon + metin vardır.
- Birincil buton: tam genişlik, en az **88 dp** yükseklik, 28 sp kalın büyük harf etiket. İkincil hedefler en az **56 dp**. Hedefler arası ≥ 16 dp.
- Durum başlığı 40 sp kalın; açıklama 20 sp; hiçbir metin 16 sp altında değil.
- Metinler kısa, emir kipi. Tüm metinler Bölüm 7'de kimlikleriyle listelenir (`T.xxx`).

### E1 — Giriş (`(auth)/login`)

**Amaç:** Şoförün telefon + şifreyle girişi. Tek seferlik; sonra oturum 30 gün hatırlanır.

```
┌──────────────────────────────────────┐
│              DurakNet                │
│             Şoför girişi             │
│                                      │
│  [ hata/uyarı şeridi (varsa) ]       │  ← T.login.err.* veya oturum sonu nedeni
│                                      │
│  Telefon                             │
│  ┌────────────────────────────────┐  │
│  │ 05__ ___ __ __                 │  │  numara klavyesi, otomatik biçim
│  └────────────────────────────────┘  │
│  Şifre                               │
│  ┌──────────────────────────┬─────┐  │
│  │ ••••••••                 │Göster│ │
│  └──────────────────────────┴─────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │           GİRİŞ YAP            │  │  birincil, 88 dp
│  └────────────────────────────────┘  │
│                                      │
│  Hesabınız yok mu?   [ KAYIT OL ]    │  ikincil
│  Şifrenizi unuttuysanız durağınıza   │
│  başvurun.                           │
└──────────────────────────────────────┘
```

| Öğe | Veri / davranış |
|---|---|
| Telefon | `phoneSchema` (shared) istemcide de çalıştırılır; `0532…`, `532…`, `+90532…` kabul. Gönderimde normalize değer. Son başarılı giriş numarası cihazda saklanabilir ve maskeli gösterilir (Bölüm 8) |
| Şifre | `min(1)`; göster/gizle düğmesi 56 dp |
| GİRİŞ YAP | `POST /auth/login { role:'driver', phone, password }` |
| Başarı | `refreshToken` → `expo-secure-store`; access token yalnızca bellekte; `GET /me` → ad, plaka önbelleğe; izin `undetermined` ise E5, değilse E4 |

**Durumlar:**
| Durum | UI |
|---|---|
| Boş / ilk açılış | Alanlar boş; buton etkin, eksik alan varsa dokununca alan altında hata |
| Gönderiliyor | Buton "Giriş yapılıyor…" + döner gösterge, alanlar kilitli |
| `INVALID_CREDENTIALS` | Şerit: T.login.err.credentials. Şifre alanı temizlenir, odak şifreye |
| `ACCOUNT_PENDING` | E3'e geçer |
| `ACCOUNT_SUSPENDED` | Kırmızı şerit: T.login.err.suspended. Buton etkin kalır |
| `RATE_LIMITED` (429) | Şerit: T.login.err.rateLimited; `Retry-After` başlığı varsa buton geri sayımla kilitlenir ("12 dk sonra deneyin"), yoksa 60 sn |
| `VALIDATION_ERROR` | İstemci şeması çoğunu yakalar; sunucudan gelirse T.login.err.phoneFormat |
| Ağ hatası / zaman aşımı (15 sn) | Şerit: T.common.err.network + "TEKRAR DENE" |
| 5xx / `INTERNAL` | Şerit: T.common.err.server |
| Oturum sonu nedeniyle gelindi | Üst şerit: T.session.ended / T.session.suspended / T.session.loggedOutElsewhere (Bölüm 4.6) |

**Erişilebilirlik:** Alanların görünür etiketleri var (placeholder'a güvenilmez); hata şeridi `accessibilityLiveRegion="polite"` / iOS'ta `AccessibilityInfo.announceForAccessibility`; klavye "İleri" → şifre, "Git" → gönder.

### E2 — Kayıt (`(auth)/register`) — minimal

**Neden var:** `POST /auth/driver/register` herkese açıktır ve şoför hesabını başka hiçbir istemci açmaz (durak paneli ve yönetici şoför oluşturmaz). Kayıt ekranı olmazsa pilot şoförleri ancak elle API çağrısıyla eklenebilir. Bu yüzden tek formluk minimal ekran öneriyorum; araç içinde değil, işe başlamadan bir kez doldurulur.

```
┌──────────────────────────────────────┐
│ < Geri             Kayıt ol          │
│ Ad soyad          [               ]  │
│ Telefon           [05__ ___ __ __ ]  │
│ Şifre (en az 8)   [               ]  │
│ Plaka             [34 ABC 123     ]  │  büyük harfe çevrilir
│ Ruhsat no         [               ]  │
│ Araç modeli (isteğe bağlı) [      ]  │
│ Araç rengi (isteğe bağlı)  [      ]  │
│  ┌────────────────────────────────┐  │
│  │           KAYDI GÖNDER         │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

- Doğrulama istemcide `driverRegisterSchema` ile (shared) — alan altı hatalar.
- `homeStandId` alanı **yok**: seçim için herkese açık durak listesi ucu yok (Açık soru S9).
- Başarı (201, `status: 'pending'`) → E3. Şifre saklanmaz, otomatik giriş yapılmaz.
- `CONFLICT` → T.register.err.conflict. `RATE_LIMITED` → T.login.err.rateLimited. Ağ/sunucu → ortak metinler.

### E3 — Onay bekleniyor (`(auth)/pending`)

```
┌──────────────────────────────────────┐
│                                      │
│        Hesabınız onay bekliyor       │
│                                      │
│  Yönetici onayladığında giriş        │
│  yapabilirsiniz. Onay için durağınız │
│  ile görüşün.                        │
│                                      │
│  ┌────────────────────────────────┐  │
│  │          GİRİŞE DÖN            │  │
│  └────────────────────────────────┘  │
│  Sık denemeyin: çok sayıda deneme    │
│  girişi 15 dakika kilitler.          │
└──────────────────────────────────────┘
```
Onay durumunu şifresiz sorgulayan uç yok; şifre cihazda saklanmadığı için otomatik yoklama yapılmaz (Açık soru S8).

### E4 — Ana ekran (`(app)/index`)

**Amaç:** Tek bakışta "çağrı alabilir miyim?" sorusunu cevaplamak ve tek dokunuşla Aktif/Pasif geçmek.

Düzen (dikey; yatay yönde başlık solda, buton sağda iki sütun):

```
┌──────────────────────────────────────┐
│ 34ABC123                  [ HESAP ]  │  üst çubuk: plaka (GET /me önbelleği)
│ (o) Bağlı   (*) Konum iyi · 3 sn önce│  durum çipleri: bağlantı, konum, son gönderim
├──────────────────────────────────────┤
│                                      │
│            AKTİFSİNİZ                │  ana durum başlığı (40 sp, renkli)
│        Çağrı almaya hazırsınız.      │  açıklama (20 sp)
│                                      │
│  ┌────────────────────────────────┐  │
│  │                                │  │
│  │           PASİF OL             │  │  birincil buton (≥ 88 dp, tam genişlik)
│  │                                │  │
│  └────────────────────────────────┘  │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ ! Bağlantı yok. 40 sn içinde     │ │  uyarı şeridi (0..1 adet, en yüksek öncelikli)
│ │   dönmezse pasife düşersiniz.    │ │  gerekirse eylem düğmesi: [KONUMU AÇ]
│ └──────────────────────────────────┘ │
│                                      │
│  ( Faz 3: açık çağrılar alanı )      │  Faz 2'de boş; hiçbir şey çizilmez
└──────────────────────────────────────┘
```

Pasif hâl:
```
│            PASİFSİNİZ                │  gri
│        Çağrı almıyorsunuz.           │
│  ┌────────────────────────────────┐  │
│  │           AKTİF OL             │  │  yeşil dolgu, siyah metin
│  └────────────────────────────────┘  │
```

**Öğeler ve beslendiği veri:**
| Öğe | Beslendiği veri |
|---|---|
| Plaka | `GET /me` → `plate` (önbellekli; çevrimdışı açılışta da görünür) |
| Bağlantı çipi | `conn`: "Bağlı" / "Bağlanıyor…" / "Bağlantı yok" |
| Konum çipi | `perm`, `gps`, `fix`: "Konum iyi" / "Konum zayıf (±120 m)" / "Konum yok" / "GPS kapalı" / "İzin yok" |
| Son gönderim | `now - lastSentAt` (yalnızca `available` iken); "3 sn önce", 20 sn üstü sarı |
| Ana başlık + açıklama + buton | Bölüm 3.2 tablosu |
| Uyarı şeridi | Bölüm 4.4 öncelik listesi |
| Bildirim kartı (geçici) | "Pasife alındınız" gibi olay bildirimleri; kapatılana kadar veya bir sonraki başarılı geçişe kadar kalır |

**Etkileşimler:**

`AKTİF OL` (D3):
1. `perm` < `foreground` → E5 açılır; dönüşte izin verildiyse akış kaldığı yerden devam eder. `deniedForever` → diyalog T.perm.deniedForever + "AYARLARI AÇ" (`Linking.openSettings()`).
2. `gps = off` → Android: `Location.enableNetworkProviderAsync()` (sistem diyaloğu); iOS: diyalog T.gps.offIos + "AYARLARI AÇ".
3. `conn ≠ connected` → işlem başlamaz; kısa bildirim T.home.err.noConnection (buton soluk görünür ama dokunulabilir; dokununca bu açıklama çıkar).
4. `intent = goingOnline`; buton "Konum alınıyor…". Son fix ≤ 30 sn ve ≤ 100 m ise o kullanılır; yoksa `getCurrentPositionAsync({ accuracy: High })`, 10 sn zaman aşımı. Fix alınamazsa T.home.err.noFix, `intent = none`.
5. Buton "Aktif olunuyor…"; `emitWithAck('driver_go_online', { location })` (10 sn).
6. Ack ok `{ status: 'available' }` → konum görevi başlar, ilk konum hemen gönderilir, haptik `success`, ekran okuyucuya T.home.a11y.nowActive. `{ status: 'busy' }` → B1.
7. Hata → Bölüm 5 tablosu.

`PASİF OL` (C*):
- Bağlıysa: konum görevi durur → `intent = goingOffline` → `emitWithAck('driver_go_offline', {})`. Ok → D3, haptik `success`.
- Bağlı değilse veya ack zaman aşımına uğrarsa: konum görevi durur, `intent = offlinePending`, şerit T.home.offlinePending. Yeniden bağlanınca `session_sync` `available` derse `driver_go_offline` gönderilir; `offline` derse bekleyen istek temizlenir.
- Onay diyaloğu yok: yanlışlıkla pasif olmak tek dokunuşla geri alınır; araçta ek diyalog dikkat dağıtır.
- Çift dokunmayı önlemek için geçiş sonrası buton 1,5 sn kilitli kalır.

`HESAP` → E6.

### 4.4 Uyarı şeridi öncelikleri (E4)

Aynı anda en fazla bir şerit; en yüksek öncelikli gösterilir. Yalnızca `server = available` iken (pasifken yalnızca 1 ve 8 gösterilir).

| Öncelik | Koşul | Renk | Metin | Eylem |
|---|---|---|---|---|
| 1 | `perm = deniedForever` / izin geri alındı | kırmızı | T.warn.permRevoked | AYARLARI AÇ |
| 2 | `gps = off` | kırmızı | T.warn.gpsOff | KONUMU AÇ |
| 3 | kopukluk ≥ 60 sn | kırmızı | T.warn.probablyOffline | – |
| 4 | kopukluk 15–60 sn | sarı | T.warn.disconnected (kalan saniye `60 − (now − lastSentAt)`, alt sınır 0) | – |
| 5 | `fix = stale` veya son gönderim > 20 sn | sarı | T.warn.locationStale | – |
| 6 | `perm = foreground` | sarı | T.warn.foregroundOnly | İZNİ DÜZELT (E5) |
| 7 | `fix = poor` | sarı | T.warn.poorAccuracy | – |
| 8 | Pil optimizasyonu açık (Android, bilinebiliyorsa) | gri | T.warn.battery | AYARLAR |

Şeritler ekranı engellemez; kapatma düğmesi yoktur (koşul düzelince kendiliğinden kalkar). Kırmızıya geçişte bir kez haptik `warning` titreşimi.

### 4.5 `session_sync` karşılaştırma tablosu

| Gelen `driverStatus` | Yerel durum | Tepki |
|---|---|---|
| `offline` | `server = offline`, `intent = none` | Hiçbir şey |
| `offline` | `intent = offlinePending` / `goingOffline` | `intent = none`, D3; bildirim yok |
| herhangi | `presenceVersion` elimdekinden küçük | Yok sayılır (S2, karar verildi) |
| `offline` | `server = available` (soğuk açılışta `unknown` + `wantsOnline`), `offlineReason = 'stale_heartbeat'`, `wantsOnline = true`, son normal konum gönderiminden ≤ 10 dk, son 10 dk'da < 3 otomatik aktif olma | **Otomatik yeniden aktif olma** (S4, karar verildi): durum "Yeniden aktif olunuyor…" → izin + GPS + fix kontrolü → `driver_go_online`. Başarı → AKTİF + yeşil bildirim kartı T.sync.reactivated. Kontrol başarısız → PASİF + kırmızı kart T.sync.reactivateFailed (neden: GPS / izin / konum yok). Uygulama arka plandaysa aynı akış çalışır; yalnızca başarısızlıkta yerel bildirim (T.notif.dropped). Akış sırasında konum görevi durdurulmaz (Android arka planda foreground service başlatamaz); başarısızlıkta durdurulur. Bağlantı akış sırasında yine koparsa kart gösterilmez, sonraki bağlantının `session_sync`'i kuralı yeniden uygular |
| `offline` | `server = available`, `offlineReason = 'stale_heartbeat'`, son normal gönderimden > 10 dk (veya hiç yok) | Otomatik aktif olunmaz (şoför araç başında olmayabilir); PASİF + mavi kart T.sync.droppedLong |
| `offline` | `server = available`, `offlineReason = 'stale_heartbeat'` / `not_online`, son 10 dk'da zaten 3 otomatik aktif olma | Otomatik aktif olunmaz; PASİF + mavi kart T.sync.droppedRepeated |
| `offline` | `server = available`, `offlineReason = 'not_online'` (ör. hash süresi doldu) | Otomatik yeniden aktif olma (üstteki satırla aynı akış) |
| `offline` | `server = available`, `offlineReason = 'forced'` | Otomatik aktif olunmaz; bu yol askıya alma / çıkışla gelir ve oturum zaten sonlanır |
| `offline` | `server = available`, `offlineReason = 'user'` (başka cihazdan pasif olundu) veya sebep yok | Otomatik aktif olunmaz; PASİF + mavi kart "Pasife alındınız" (T.sync.droppedGeneric), konum görevi durur |
| `offline` | `server = available`, `wantsOnline = false` | Otomatik aktif olunmaz; PASİF + mavi kart T.sync.droppedGeneric |
| `offline` | `server = unknown` (soğuk açılış), `wantsOnline = false` | Hiçbir şey; önceki çalışmadan kalan konum görevi varsa durdurulur |
| `available` | `intent = offlinePending` | `driver_go_offline` gönderilir |
| `available` | `server = available` | Konum görevi çalışmıyorsa başlatılır; hemen bir konum gönderilir |
| `available` | `server = offline` veya `unknown` (ör. uygulama yeniden kuruldu, başka cihaz) | İzin + GPS uygunsa görevi başlat ve `available` göster, bildirim T.sync.stillActive; uygun değilse `driver_go_offline` gönder ve T.sync.forcedOfflineNoPerm göster |
| `busy` | herhangi | B1 yer tutucu (Faz 3'te `activeRide` ile ride ekranı). Konum görevi çalışır |

`openRequests` ve `activeRide` Faz 2'de yok sayılır (sunucu hep boş gönderir).

### E5 — Konum izni akışı (`(app)/permissions`, modal)

**İlke:** Sistem izin diyaloğundan önce her zaman uygulamanın kendi açıklama ekranı gösterilir (Google Play "belirgin açıklama" şartı; iOS'ta reddedilen izin bir daha sorulamaz). İstek sırası: **1) Ön plan konumu → 2) Arka plan konumu → 3) Bildirim (Android 13+)**.

Adım 1 — Ön plan:
```
┌──────────────────────────────────────┐
│  Adım 1 / 2                          │
│  Konum izni gerekli                  │
│                                      │
│  Aktif olduğunuzda yakınınızdaki     │
│  durak çağrılarını alabilmeniz için  │
│  konumunuz paylaşılır. Pasifken      │
│  konum paylaşılmaz.                  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │          İZİN VER              │  │ → requestForegroundPermissionsAsync
│  └────────────────────────────────┘  │
│            [ Şimdi değil ]           │
└──────────────────────────────────────┘
```
- Android: sistem diyaloğunda "Uygulamayı kullanırken" + "Tam konum" seçilmeli; "Yaklaşık konum" seçilirse (`accuracy: coarse`) şerit T.perm.coarse ve tekrar isteme.
- Reddedilirse ve `canAskAgain = false` → "AYARLARI AÇ".

Adım 2 — Arka plan:
```
│  Adım 2 / 2                          │
│  Arka planda da çağrı alın           │
│                                      │
│  Navigasyon açıkken veya ekran       │
│  kilitliyken de aktif kalmanız için  │
│  "Her zaman izin ver"i seçin.        │
│                                      │
│  (Android) Açılan ayarlarda:         │
│   Konum > Her zaman izin ver         │
│                                      │
│  [ DEVAM ET ]   → requestBackgroundPermissionsAsync
│  [ Şimdi değil ] → E4 (T.warn.foregroundOnly şeridi)
```
- **Android 11+**: `requestBackgroundPermissionsAsync` diyalog değil ayar sayfası açar; metin bunu önceden söyler. Dönüşte izin tekrar okunur.
- **iOS**: Önce "Uygulamayı Kullanırken", ardından bu adımda "Her Zaman'a değiştir" sistem sorusu gelir. iOS bunu ertelerse/göstermezse "AYARLARI AÇ" alternatifi sunulur.
- Arka plan izni **zorunlu tutulmaz**: yalnızca ön plan izniyle aktif olunabilir, sürekli sarı şerit gösterilir. Gerekçe: şoförün izni reddetmesi uygulamayı tamamen işe yaramaz yapmamalı; ön planda başlatılan konum servisi platforma göre arka planda da sürebilir (doğrulama gerekir, Açık soru S6).

Adım 3 — Bildirim (yalnızca Android 13+): T.perm.notif. Gerekçe: konum servisi bildirimi görünür olsun (Faz 5 push da aynı izni kullanır). Reddedilirse akış devam eder.

**Platform yapılandırması (frontend geliştiricinin `app.json`'a ekleyeceği; metinler burada sabitlendi):**
- iOS `NSLocationWhenInUseUsageDescription`: "Aktif olduğunuzda yakınınızdaki durak çağrılarını alabilmeniz için konumunuz kullanılır. Pasifken konum paylaşılmaz."
- iOS `NSLocationAlwaysAndWhenInUseUsageDescription`: "Uygulama arka plandayken de (ör. navigasyon açıkken) çağrı alabilmeniz için konumunuz kullanılır. Pasifken konum paylaşılmaz."
- iOS `UIBackgroundModes: ["location"]`; konum görevi `showsBackgroundLocationIndicator: true`, `pausesUpdatesAutomatically: false`, `activityType: AutomotiveNavigation`.
- Android izinleri: `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` (Android 14), `POST_NOTIFICATIONS`.
- Arka plan konumu Expo Go'da çalışmaz; development build gerekir.

**Konum görevi parametreleri:** `timeInterval: 4000` ms, `distanceInterval: 0`, `accuracy: High`. Sunucu 1/sn'den fazlasını düşürür; 3–5 sn aralığı CLAUDE.md Senaryo 1 ile uyumlu.

**Android foreground service bildirimi** (yalnızca aktifken, kalıcı):
- Başlık: T.fgs.title "DurakNet: Aktifsiniz"
- Metin: T.fgs.body "Çağrı alabilmeniz için konumunuz paylaşılıyor."
- Renk yeşil; dokununca E4 açılır. Pasif olunca bildirim kalkar.

### E6 — Hesap (`(app)/account`)

```
┌──────────────────────────────────────┐
│ < Geri               Hesap           │
│ Ad Soyad        Mehmet Y.            │  GET /me fullName
│ Plaka           34ABC123             │
│ Araç            Beyaz Fiat Egea      │  vehicleColor + vehicleModel
│ Telefon         +90 5** *** ** 67    │  maskeli (Bölüm 8)
├──────────────────────────────────────┤
│ Konum izni      Her zaman     [>]    │  → E5 / sistem ayarları
│ Bildirim izni   Açık          [>]    │
│ Pil optimizasyonu (Android) [>]      │
├──────────────────────────────────────┤
│ Uygulama sürümü 1.0.0 (build 12)     │
│                                      │
│  ┌────────────────────────────────┐  │
│  │           ÇIKIŞ YAP            │  │  ikincil stil (kırmızı çerçeve)
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

**Çıkış yap:**
1. Diyalog: aktifse T.logout.confirmActive, pasifse T.logout.confirm. Düğmeler "ÇIKIŞ YAP" / "VAZGEÇ" (vazgeç varsayılan odak).
2. `loggingOut = true` bayrağı (gelen `io server disconnect` hata sayılmaz) → konum görevi durur → `POST /auth/logout` (access token ile).
3. Başarı veya `UNAUTHORIZED` → SecureStore temizlenir, socket kapatılır, store sıfırlanır, E1 (şerit yok).
4. Ağ hatası → diyalog T.logout.err.network: "TEKRAR DENE" / "YİNE DE ÇIK". "Yine de çık" yerel oturumu siler; sunucudaki refresh token süresi dolana kadar geçerli kalır (Açık soru S10). Konum gönderimi durduğu için şoför en geç ~70 sn'de pasife düşer.
5. Faz 3: `server = busy` iken çıkış düğmesi devre dışı + T.logout.busy (sunucu tarafı kararı CLAUDE.md'de açık).

### 4.6 Oturum yönetimi (ekran değil, tüm (app) rotalarını etkiler)

**Açılış (`booting`):** Açılış ekranı (logo + "Yükleniyor…"). SecureStore'da refresh token yoksa E1. Varsa `POST /auth/refresh`:
- ok → access bellekte → socket `connect` (`auth: { token }`) → E4 A2 durumu → `session_sync` ile gerçek durum.
- `UNAUTHORIZED` → token silinir → E1 + T.session.ended.
- `ACCOUNT_SUSPENDED` → token silinir → E1 + T.session.suspended. (`ACCOUNT_PENDING` → E3.)
- Ağ hatası → **önbellekteki profille E4 açılır** (A2 / D2, "Bağlantı yok"); refresh üstel geri çekilmeyle (2, 4, 8 … en çok 30 sn) yeniden denenir. Şoför internet yokken giriş ekranına atılmaz.
- Önceki çalışmadan kalan konum görevi (`hasStartedLocationUpdatesAsync`) varsa `session_sync` gelene kadar konum gönderilmez; `offline` gelirse görev durdurulur.

**Proaktif yenileme:** Access token süresinin %80'inde (≈ 12 dk) `POST /auth/refresh` → yeni access → `emitWithAck('auth_refresh', { token })`; `socket.auth.token` da güncellenir (yeniden bağlanmada yeni token gitsin). UI'de görünmez.

**`auth_expired` gelirse** (proaktif yenileme kaçtıysa): aynı akış hemen çalışır; 30 sn'lik süre içinde bitmelidir. Refresh ağ hatası verirse 5 sn aralıkla tekrar; ekran değişmez.

**Hata eşlemesi:**
| Olay | Tepki |
|---|---|
| `auth_refresh` ack ok | Hiçbir şey |
| `auth_refresh` ack `UNAUTHORIZED` / `ACCOUNT_*` | Sunucu socket'i keser → "oturum sonlandı" akışı |
| `disconnect` nedeni `io server disconnect` (ve `loggingOut` değil) | Otomatik bağlanma olmaz: `POST /auth/refresh` → ok ise yeni token'la `connect()`; hata kodu varsa aşağıdaki "oturum sonlandı" |
| `connect_error` `UNAUTHORIZED` | Bir kez refresh + yeniden bağlan; refresh de `UNAUTHORIZED` ise oturum sonlandı (T.session.loggedOutElsewhere: `token_version` arttı → başka cihazdan çıkış veya yönetici işlemi) |
| `connect_error` / refresh `ACCOUNT_SUSPENDED` | Oturum sonlandı (T.session.suspended) |
| `connect_error` `ACCOUNT_PENDING` | Oturum sonlandı → E3 |
| `connect_error` `FORBIDDEN` | Programlama hatası (yanlış namespace/rol); T.common.err.server, yeniden deneme yok, log |
| `connect_error` `INTERNAL` veya kodsuz (taşıma hatası) | socket.io-client otomatik yeniden dener (1→5 sn, sonsuz); `conn = disconnected` |

**Oturum sonlandı akışı:** konum görevi durur → socket kapanır → SecureStore temizlenir → E1 + ilgili şerit. Uygulama arka plandaysa yerel bildirim T.notif.sessionEnded. Önbellekteki profil silinir.

### 4.7 Arka plan / ön plan

| Geçiş | Davranış |
|---|---|
| Ön plan → arka plan, `available` | Socket kapatılmaz. Konum görevi (Android foreground service / iOS arka plan konum) sürer ve konumu aynı socket'ten gönderir. Arka plandaki görevin socket'e erişimi tek bir modül üzerinden (`src/lib/realtime.ts`) olur |
| Ön plan → arka plan, `offline` | Socket açık kalabilir; OS keserse sorun değil |
| Arka plan → ön plan | İzin ve GPS yeniden okunur (kullanıcı ayarlardan kapatmış olabilir → C3). Arka planda > 30 sn kaldıysa socket yeniden kurulmaz; bağlıysa `session_sync_request` gönderilir (kural 3.4-7); bu sırada son bilinen durum gösterilir, başlıkta küçük "Güncelleniyor…" |
| Uygulama kapatıldı (kaydırıldı) / süreç öldü | Socket gider, konum gönderilemez → sweeper ~70 sn'de pasife alır. Yeniden açılışta `session_sync{offline}` + T.sync.droppedDisconnect |
| Telefon yeniden başladı | Aynı; görev otomatik başlatılmaz |

Faz 4 notu: Navigasyon uygulamaya geçiş en sık arka plan senaryosudur; arka plan konum izni bu yüzden şiddetle önerilir.

---

## 5. Event / ack → UI tepki tablosu

| Event / çağrı | Yön | Sonuç | UI tepkisi |
|---|---|---|---|
| `POST /auth/login` | C→S | ok | Token sakla, `GET /me`, E5 veya E4 |
| | | `INVALID_CREDENTIALS` | T.login.err.credentials |
| | | `ACCOUNT_PENDING` | E3 |
| | | `ACCOUNT_SUSPENDED` | T.login.err.suspended |
| | | `RATE_LIMITED` | T.login.err.rateLimited + geri sayım |
| | | `VALIDATION_ERROR` | T.login.err.phoneFormat |
| | | ağ / 5xx | T.common.err.network / T.common.err.server |
| `POST /auth/driver/register` | C→S | 201 | E3 |
| | | `CONFLICT` | T.register.err.conflict |
| | | `VALIDATION_ERROR` | Alan altı hata (sunucu mesajı gösterilmez, istemci şeması eşlenir) |
| `POST /auth/refresh` | C→S | ok | Görünmez |
| | | `UNAUTHORIZED` | Oturum sonlandı (T.session.ended / loggedOutElsewhere) |
| | | `ACCOUNT_SUSPENDED` / `ACCOUNT_PENDING` | Oturum sonlandı / E3 |
| | | `RATE_LIMITED` / ağ | Geri çekilmeyle tekrar; ekran değişmez |
| `POST /auth/logout` | C→S | ok / `UNAUTHORIZED` | E1 |
| | | ağ | T.logout.err.network |
| `connect` | S→C | – | `conn = connected`, çip "Bağlı"; kopukluk ≥ 15 sn sürdüyse kısa bildirim T.conn.restored. `presenceVersion` sıfırlanır; 5 sn içinde `session_sync` gelmezse bekçi `session_sync_request` gönderir (kural 3.4-9) |
| `disconnect` | S→C | `transport close` vb. | `conn = disconnected`, `disconnectedAt` kaydı; 15 sn sonra sarı şerit |
| | | `io server disconnect` | Bölüm 4.6 |
| `connect_error` | S→C | kodlu / kodsuz | Bölüm 4.6 |
| `session_sync` | S→C | `DriverSessionSync` | Bölüm 4.5 |
| `auth_expired` | S→C | `{}` | Sessiz refresh + `auth_refresh` |
| `auth_refresh` | C→S | ok | Görünmez |
| | | hata | Oturum sonlandı |
| `driver_go_online` | C→S | ok `available` | C6, haptik, konum görevi başlar |
| | | ok `busy` | B1 (Faz 3) |
| | | `VALIDATION_ERROR` | Programlama/konum hatası: T.home.err.noFix, log |
| | | `UNAUTHORIZED` / `ACCOUNT_*` | Sunucu socket'i keser → oturum sonlandı |
| | | `INTERNAL` | T.home.err.goOnlineFailed + buton tekrar etkin |
| | | 10 sn zaman aşımı | T.home.err.goOnlineTimeout; `server` değişmez; son söz sonraki `session_sync` |
| `driver_go_offline` | C→S | ok `offline` | D3, haptik |
| | | `INVALID_TRANSITION` | T.home.err.offlineBusy; konum görevi yeniden başlar (Faz 3) |
| | | `INTERNAL` / zaman aşımı | `offlinePending` + T.home.offlinePending. Bağlıysa hemen `session_sync_request`; gelen sync `available` derse `driver_go_offline` tekrarlanır, `offline` derse kilit kalkar; yanıt yoksa bekçi geri çekilmeyle tekrar ister (kural 3.4-9) |
| `driver_location_update` | C→S | ack yok | `lastSentAt` güncellenir (yalnızca `connected` iken emit edildiyse) |
| `ride_requested`, `ride_taken`, `ride_accepted`, `ride_cancelled` | S→C | – | Faz 3/4; Faz 2'de dinlenmez |

---

## 6. Bağlantı göstergesinin zaman çizelgesi (`server = available`)

```
kopma anı        15 sn             60 sn (son konumdan)       ~70 sn
   │ çip: "Bağlantı yok" │ sarı şerit + geri sayım │ kırmızı: "Durum bilinmiyor" │
   │ ana başlık yeşil    │ ana başlık yeşil        │ başlık kırmızı              │
   └─────────────────────┴─────────────────────────┴─────────────────────────────►
                                     yeniden bağlanınca: session_sync kararı verir
```
Geri sayım `lastSentAt`'e göre hesaplanır, çünkü sweeper eşiği son alınan konumdan başlar; gerçek düşme anı sunucuda ±10 sn oynar. Metin bu yüzden "yaklaşık" dilinde yazılır ("40 sn içinde dönmezse").

Ağ yokken toggle: `AKTİF OL` işlem başlatmaz (T.home.err.noConnection); `PASİF OL` yerel olarak uygulanır (`offlinePending`). Gerekçe: aktif olmak sunucu onayı gerektirir; pasif olmak ise konum durdurulunca zaten gerçekleşir.

---

## 7. Metinler (Türkçe)

| Kimlik | Metin |
|---|---|
| T.common.err.network | İnternet bağlantısı yok. Tekrar deneyin. |
| T.common.err.server | Sunucuya ulaşılamadı. Biraz sonra tekrar deneyin. |
| T.common.retry | TEKRAR DENE |
| T.common.openSettings | AYARLARI AÇ |
| T.login.title | Şoför girişi |
| T.login.phone | Telefon |
| T.login.password | Şifre |
| T.login.submit | GİRİŞ YAP |
| T.login.submitting | Giriş yapılıyor… |
| T.login.register | KAYIT OL |
| T.login.forgot | Şifrenizi unuttuysanız durağınıza başvurun. |
| T.login.err.credentials | Telefon veya şifre hatalı. |
| T.login.err.suspended | Hesabınız askıya alındı. Durağınızla görüşün. |
| T.login.err.rateLimited | Çok fazla deneme. {süre} sonra tekrar deneyin. |
| T.login.err.phoneFormat | Telefon numarasını kontrol edin. |
| T.register.title | Kayıt ol |
| T.register.submit | KAYDI GÖNDER |
| T.register.err.conflict | Bu telefon veya plaka zaten kayıtlı. |
| T.pending.title | Hesabınız onay bekliyor |
| T.pending.body | Yönetici onayladığında giriş yapabilirsiniz. Onay için durağınızla görüşün. |
| T.pending.hint | Sık denemeyin: çok sayıda deneme girişi 15 dakika kilitler. |
| T.pending.back | GİRİŞE DÖN |
| T.home.active | AKTİFSİNİZ |
| T.home.activeSub | Çağrı almaya hazırsınız. |
| T.home.passive | PASİFSİNİZ |
| T.home.passiveSub | Çağrı almıyorsunuz. |
| T.home.goOnline | AKTİF OL |
| T.home.goOffline | PASİF OL |
| T.home.gettingFix | Konum alınıyor… |
| T.home.goingOnline | Aktif olunuyor… |
| T.home.goingOffline | Pasif olunuyor… |
| T.home.connecting | Bağlanıyor… |
| T.home.unknown | Durum bilinmiyor |
| T.home.unknownSub | Bağlantı gelince kontrol edilecek. |
| T.home.busy | Aktif işiniz var |
| T.home.offlinePending | Pasife geçiliyor. Bağlantı gelince onaylanacak. |
| T.home.err.noConnection | Bağlantı yok. Bağlanınca tekrar deneyin. |
| T.home.err.noFix | Konum alınamadı. Açık alana çıkıp tekrar deneyin. |
| T.home.err.goOnlineFailed | Aktif olunamadı. Tekrar deneyin. |
| T.home.err.goOnlineTimeout | Yanıt gelmedi. Durumunuz bağlantı gelince güncellenecek. |
| T.home.err.offlineBusy | Aktif işiniz varken pasif olamazsınız. |
| T.home.a11y.nowActive | Aktif oldunuz. Çağrı alabilirsiniz. |
| T.home.a11y.nowPassive | Pasif oldunuz. |
| T.chip.connected / connecting / disconnected | Bağlı / Bağlanıyor… / Bağlantı yok |
| T.chip.locGood / locPoor / locNone / gpsOff / noPerm | Konum iyi / Konum zayıf (±{m} m) / Konum yok / GPS kapalı / İzin yok |
| T.chip.lastSent | {n} sn önce |
| T.warn.permRevoked | Konum izni kapalı. Çağrı alamazsınız. |
| T.warn.gpsOff | GPS kapalı. Açın, yoksa pasife düşersiniz. |
| T.warn.probablyOffline | Uzun süredir bağlantı yok. Pasife düşmüş olabilirsiniz. |
| T.warn.disconnected | Bağlantı yok. {n} sn içinde dönmezse pasife düşersiniz. |
| T.warn.locationStale | Konum gönderilemiyor. |
| T.warn.foregroundOnly | Uygulama kapalıyken çağrı alamazsınız. "Her zaman" izni verin. |
| T.warn.poorAccuracy | Konum zayıf. Çağrılar gecikebilir. |
| T.warn.battery | Pil tasarrufu uygulamayı durdurabilir. |
| T.sync.droppedDisconnect | Bağlantı uzun süre koptuğu için pasife alındınız. Çağrı almak için AKTİF OL'a basın. |
| T.sync.droppedNoLocation | Konumunuz bir süre alınamadığı için pasife alındınız. |
| T.sync.droppedGeneric | Pasife alındınız. Çağrı almak için AKTİF OL'a basın. |
| T.sync.droppedRepeated | Pasife alındınız — Bağlantı tekrar tekrar koptu. Çağrı almak için AKTİF OL'a basın. |
| T.sync.stillActive | Aktif durumdasınız. Konum paylaşımı sürüyor. |
| T.sync.forcedOfflineNoPerm | Konum izni olmadığı için pasife alındınız. |
| T.conn.restored | Bağlantı geri geldi. |
| T.gps.offIos | Konum Servisleri kapalı. Ayarlar > Gizlilik > Konum Servisleri'nden açın. |
| T.perm.step1.title | Konum izni gerekli |
| T.perm.step1.body | Aktif olduğunuzda yakınınızdaki durak çağrılarını alabilmeniz için konumunuz paylaşılır. Pasifken konum paylaşılmaz. |
| T.perm.step1.cta | İZİN VER |
| T.perm.later | Şimdi değil |
| T.perm.step2.title | Arka planda da çağrı alın |
| T.perm.step2.body | Navigasyon açıkken veya ekran kilitliyken de aktif kalmanız için "Her zaman izin ver"i seçin. |
| T.perm.step2.android | Açılan ayarlarda: Konum > Her zaman izin ver. |
| T.perm.step2.cta | DEVAM ET |
| T.perm.coarse | "Tam konum"u açın. Yaklaşık konumla çağrı alamazsınız. |
| T.perm.deniedForever | Konum izni kapalı. Ayarlardan açın. |
| T.perm.notif | Aktifken bildirim çubuğunda durumunuzu görmek için bildirimlere izin verin. |
| T.fgs.title | DurakNet: Aktifsiniz |
| T.fgs.body | Çağrı alabilmeniz için konumunuz paylaşılıyor. |
| T.notif.dropped | Pasife alındınız. Çağrı almak için uygulamayı açın. |
| T.notif.sessionEnded | Oturumunuz kapandı. Tekrar giriş yapın. |
| T.session.ended | Oturumunuz sona erdi. Tekrar giriş yapın. |
| T.session.suspended | Hesabınız askıya alındı. Durağınızla görüşün. |
| T.session.loggedOutElsewhere | Oturumunuz kapatıldı. Tekrar giriş yapın. |
| T.logout.confirm | Çıkış yapılsın mı? Bu hesap tüm cihazlarda kapanır. |
| T.logout.confirmActive | Çıkış yaparsanız pasife alınırsınız ve çağrı alamazsınız. Bu hesap tüm cihazlarda kapanır. |
| T.logout.cta / cancel | ÇIKIŞ YAP / VAZGEÇ |
| T.logout.err.network | Sunucuya ulaşılamadı. Yine de çıkarsanız bu cihazdaki oturum silinir. |
| T.logout.forceCta | YİNE DE ÇIK |
| T.logout.busy | Aktif işiniz varken çıkış yapamazsınız. |

Not: Sunucunun `error.message` metinleri kullanıcıya doğrudan gösterilmez; istemci `error.code`'u yukarıdaki metinlere eşler (dil ve ton tutarlılığı).

---

## 8. Erişilebilirlik ve gizlilik

**Erişilebilirlik**
- Dokunma hedefleri: birincil ≥ 88 dp, diğerleri ≥ 56 dp (platform minimumu 48 dp'nin üstü; eldiven ve titreşimli araç ortamı).
- Kontrast: ana durum metni ve butonlar koyu temada ≥ 7:1 (WCAG AAA); açık temada ≥ 4.5:1. Durum hiçbir zaman yalnızca renkle anlatılmaz (başlık metni + ikon şekli: dolu daire = aktif, boş daire = pasif, üçgen = uyarı).
- Dinamik yazı boyutu desteklenir; 200%'e kadar düzen bozulmaz (başlık kısalır, buton yüksekliği büyür). Ana ekran dikey ve yatayda çalışır (araç tutucusu).
- Ekran okuyucu: toggle `accessibilityRole="button"`, `accessibilityState={{ busy, disabled }}`, etiket durumla birlikte ("Pasif ol. Şu an aktifsiniz."). Durum değişimleri ve uyarı şeritleri canlı bölge olarak duyurulur; geri sayım her saniye değil yalnızca eşik geçişlerinde duyurulur.
- Haptik: aktif/pasif geçişi `success`, pasife düşürülme ve kırmızı uyarı `warning`. Faz 2'de ses yok (çağrı sesi Faz 3).
- Gece: koyu tema varsayılan, parlak beyaz büyük alan yok (aktif buton yeşil zemin yerine yeşil çerçeve + yeşil metin seçeneği, Açık soru S11).
- Animasyonlar "Hareketi azalt" ayarına uyar; döner gösterge dışında hareket yok.

**Gizlilik (KVKK, CLAUDE.md "Gizlilik")**
- Telefon numarası ekranda yalnızca giriş/kayıt alanında (şoförün kendi yazdığı) tam görünür; Hesap ekranında maskeli: `+90 5** *** ** 67`. Son giriş numarası cihazda saklanırsa SecureStore'da tutulur ve maskeli önerilir.
- İstemci logları, hata raporlama (ör. Sentry breadcrumb'ları) ve analitik: telefon, ham koordinat, token yazılmaz. Konum yalnızca "fix var/yok, doğruluk kovası (≤50 / ≤100 / >100 m)" olarak loglanabilir.
- Refresh token yalnızca `expo-secure-store`'da; access token yalnızca bellekte. Şifre hiçbir yerde saklanmaz.
- Şoföre müşteri bilgisi gösterilmez (sistemde yoktur); Faz 2 ekranlarında zaten ride verisi yok.

---

## 9. Açık sorular

Yeni alan veya event gerektiren her öneri **önce `packages/shared`'a** (`types.ts` / `events.ts` / `schemas.ts`), sonra CLAUDE.md Bölüm 6'ya girmelidir; istemci sözleşmede olmayan alana güvenmez.

| # | Soru | Varsayım (bu belgede) | Öneri |
|---|---|---|---|
**Karar verilenler (2026-09-29):** S1, S2, S3 sözleşmeye eklenecek; S4 → otomatik yeniden aktif olma **evet**.
- `wantsOnline`: şoförün son bilinçli seçimi (AKTİF OL → true, PASİF OL / çıkış → false); cihazda kalıcı tutulur. Otomatik aktif olma yalnızca `wantsOnline = true` iken çalışır; şoför kopukken PASİF OL'a bastıysa (`offlinePending`) çalışmaz.
- 10 dk sınırı istemci sabitidir (`AUTO_REACTIVATE_MAX_GAP_MS`); ölçüt son başarılı konum gönderiminden yeniden bağlanmaya geçen süre. Soğuk açılışta da aynı kural uygulanır.
- Yeni metinler: T.sync.reactivated "Yeniden aktif oldunuz — Bağlantı koptuğu için pasife düşmüştünüz. Bağlantı gelince otomatik olarak aktif oldunuz." · T.sync.reactivateFailed "Pasife alındınız — … {neden} olduğu için otomatik aktif olunamadı." · T.sync.droppedLong "Pasife alındınız — 10 dakikadan uzun bağlantı yoktu. Çağrı almak için AKTİF OL'a basın." · T.warn.disconnected ve T.warn.probablyOffline'a alt satır: "Bağlantı gelince otomatik olarak yeniden aktif olursunuz."
- S3 ile kural 3.4-7 değişir: arka plandan > 30 sn sonra dönüşte socket yeniden kurulmaz, `session_sync_request` gönderilir.
- Görsel tasarım: https://claude.ai/artifact/CXRYFx5ubciRnfWmgJDkkg

| S1 | `session_sync{offline}` **sebep taşımıyor**. İstemci "sweeper düşürdü", "başka cihazdan pasif olundu", "hash süresi doldu" ayrımını yapamaz. | Sebep istemcide tahmin edilir (kopukluk süresi / bağlıyken gelme) | `DriverSessionSync`'e `offlineReason?: 'stale_heartbeat' \| 'forced' \| 'not_online'` eklenmesi; sweeper'ın düşürdüğü bilgi hash'te tutulabilir (ör. `offlineReason` alanı). |
| S2 | `session_sync` sıra/versiyon taşımıyor. Hızlı pasif→aktif geçişinde, pasiften önce gönderilmiş bir konumun ürettiği `session_sync{offline}`, yeni `go_online` ack'inden **sonra** gelip istemciyi yanlışlıkla pasife çekebilir. | Ack'ten sonraki 5 sn içinde gelen `offline` için `driver_go_online` sessizce tekrarlanır (idempotent); toggle 1,5 sn kilitli | Sunucu durumu için monoton sayaç (`presenceVersion`) veya `session_sync`'e `ts`; istemci eskisini yok sayar. |
| S3 | Bağlı socket'te istemcinin güncel durumu isteme yolu yok (`session_sync` yalnızca bağlanmada ve offline konumda gelir). | Arka planda > 30 sn kalınca socket yeniden kurulur | `session_sync_request` (C→S, ack = `DriverSessionSync`) event'i. |
| S4 | Pasife düşürülen şoför yeniden bağlanınca otomatik aktif olmalı mı? | Hayır; bildirim + tek dokunuşla "AKTİF OL" | Kısa kopmalarda (< 5 dk) otomatik geri dönüş ürün kararı; yanlışlıkla araç başında olmayan şoförü aktif yapma riski var. |
| S5 | iOS'ta araç duruyorken (durak sırası) arka planda konum güncellemesi seyrekleşebilir; 60 sn eşiği aşılırsa şoför düşer. Son konumu periyodik tekrar göndermek sunucuda "taze" sayılır (sunucu saatini yazar) ve Faz 3'te `LOCATION_FRESH_MS` anlamını bozar. | Tekrar gönderim yok; gerçek cihazda ölçülecek | Faz 2 mobil kabulüne "iOS arka planda duran araç 10 dk aktif kalır" testi eklensin; gerekirse ayrı hafif heartbeat event'i (konumsuz) değerlendirilsin. |
| S6 | Yalnızca ön plan izniyle başlatılan konum servisi arka planda sürer mi? (Android: ön planda başlatılan `location` tipli FGS; iOS: When-In-Use + `UIBackgroundModes`.) `expo-location`'ın `startLocationUpdatesAsync`'i arka plan izni isteyebilir. | Ön plan izniyle aktif olunabilir, sarı şerit gösterilir | Frontend geliştirici development build'de doğrulasın; olmuyorsa arka plan izni aktif olmanın ön koşulu yapılır. |
| S7 | Düşük doğruluk eşiği: sunucu `accuracy`'yi yok sayıyor. Kaç metrenin üstündeki konum gönderilmemeli? | Hepsi gönderilir; > 50 m sarı uyarı, go_online için ≤ 100 m aranır | Faz 3 dispatch öncesi eşik kararı; gerekirse sunucu `accuracy` > X olanı GEO'ya yazmasın. |
| S8 | Onay bekleyen şoför durumunu şifresiz öğrenemez; `ACCOUNT_PENDING` başarısız giriş sayıldığı için sık deneme 15 dk kilit getirir. | Bekleme ekranında uyarı metni | `ACCOUNT_PENDING` yanıtlarının hesap limitine sayılmaması veya onayda SMS/push (push token onaydan önce yok). |
| S9 | Kayıtta `homeStandId` seçilemiyor: herkese açık durak listesi ucu yok. | Alan gösterilmez | Yönetici onay sırasında atasın ya da `GET /stands/public` (yalnızca id + ad) ucu. |
| S10 | "Yine de çık" (ağ yokken) sunucudaki refresh token'ı iptal etmez (30 gün geçerli). | İzin verilir, uyarıyla | Kabul edilebilir mi? Alternatif: bekleyen logout'u kuyruğa alıp bağlantı gelince göndermek (token yerelde silinmişse mümkün değil; yalnızca iptal için access/refresh'i geçici tutmak gerekir). |
| S11 | Gece modunda aktif butonun dolgu rengi (büyük yeşil alan göz alabilir). | Koyu temada yeşil çerçeve + yeşil metin, pasifte yeşil dolgulu "AKTİF OL" | Sahada gece denemesiyle karar. |
| S12 | Şifre sıfırlama akışı sistemde yok. | "Durağınıza başvurun" metni | Yönetici için şifre sıfırlama ucu (Faz 1 kapsamına ek). |
| S13 | Android üretici pil optimizasyonları (Xiaomi, Huawei vb.) foreground service'i öldürebilir; `@react-native-community/netinfo` ve pil optimizasyonu kontrolü stack'te yok. | Hesap ekranında yönlendirme; ağ türü ayrımı yapılmaz ("Bağlantı yok") | Bağımlılık eklenmesi frontend geliştirici kararı. |
| S14 | Ekran açık tutma (`expo-keep-awake`) aktifken ön planda açık olmalı mı? | Hayır (pil) | Saha geri bildirimine göre Hesap'a ayar olarak eklenebilir. |
| S15 | Faz 3 bağımlılığı: `busy` şoför çıkış yaparsa/askıya alınırsa ride'ın akıbeti (CLAUDE.md açık karar). | İstemci `busy` iken çıkışı engeller | Sunucu kararıyla uyumlu hale getirilecek. |
