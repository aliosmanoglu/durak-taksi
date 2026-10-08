# KVKK Aydınlatma Metni — TASLAK (sürüm 2026-10-taslak-1)

> Bu metin teknik ekip tarafından hazırlanmış taslaktır; yayımlanmadan önce hukuk danışmanı tarafından incelenmeli, veri sorumlusu bilgileri tamamlanmalıdır. Sürüm değişirse `KVKK_NOTICE_VERSION` (`packages/shared/src/reports.ts`) güncellenir.

## 1. Veri sorumlusu
[Ünvan, adres, KEP/e-posta, iletişim — doldurulacak]

## 2. İşlenen kişisel veriler ve amaçları
| Veri | Kimden | Amaç | Saklama yeri / süre |
|---|---|---|---|
| Şoför: ad soyad, telefon, plaka, ruhsat no, araç modeli/rengi | Şoför | Hesap, onay, çağrı eşleştirme, durağın aracı tanıması | Veritabanı; hesap süresince, silme talebinde anonimleştirilir |
| Şoför: anlık konum | Şoför (yalnızca "Aktif" iken) | Yakındaki çağrıları iletme, eşleşen aracı durağa gösterme | Yalnızca bellekte (Redis), veritabanına yazılmaz; en geç 24 saat |
| Şoför: bildirim (push) belirteci | Şoför | Uygulama kapalıyken çağrı bildirimi | Veritabanı; çıkışta/silmede temizlenir |
| Durak: ad, telefon, adres, konum, kullanıcı adı | Durak yetkilisi | Hesap, çağrı oluşturma | Veritabanı; hesap süresince |
| Çağrı: alış adresi/konumu, varış adresi, kısa not, zaman damgaları | Durak görevlisi | Çağrıyı iletme, eşleşme süresi raporları | Veritabanı; [saklama süresi — ör. 2 yıl — karara bağlanacak] |
| Kimlik doğrulama günlükleri, IP adresi | Otomatik | Güvenlik, kötüye kullanım önleme | Sunucu günlükleri; [süre] |

Müşterinin adı ve telefonu sistemde **tutulmaz**; durak müşteriyle kendi kanalından iletişim kurar. Çağrı notuna kişisel veri yazılmaması durak görevlilerine bildirilir. Sistemde ödeme, ücret veya finansal kayıt yoktur.

## 3. Hukuki sebep
Sözleşmenin kurulması/ifası (m.5/2-c), veri sorumlusunun meşru menfaati (m.5/2-f); konum için ayrıca uygulama içi izin. [Hukuk onayı]

## 4. Aktarım
- Adres arama (geocoding) **kendi işlettiğimiz** sunucuda yapılır; adresler üçüncü taraf geocoder'a gönderilmez.
- Harita karoları üçüncü taraf sunucudan (OpenStreetMap karo sunucusu, ya da yapılandırılan) yüklenir; karo isteği görüntülenen bölgeyi ve IP adresini içerir.
- Push bildirimleri Expo/Apple/Google üzerinden iletilir (belirteç ve bildirim içeriği: çağrı kimliği). [Yurt dışı aktarım değerlendirmesi — hukuk]

## 5. İlgili kişi hakları (m.11)
Bilgi talep etme, düzeltme, silme/anonimleştirme, itiraz. Başvuru: [kanal]. Silme talebi yönetici tarafından hesabın anonimleştirilmesiyle yerine getirilir; istatistik amaçlı çağrı kayıtları kişisel veri içermeden kalır.

## 6. Onay
Kayıt sırasında bu metnin okunduğu onay kutusuyla kaydedilir; onay zamanı ve metin sürümü hesapla birlikte saklanır.
