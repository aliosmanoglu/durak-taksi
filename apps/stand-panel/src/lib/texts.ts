// Türkçe metinler (docs/design/faz3-dispatch.md Bölüm 5, `T.stand.*`). Kodda elle metin yazılmaz.
import type { ErrorCode } from '@duraknet/shared';

export const T = {
  appName: 'DurakNet',
  login: {
    title: 'Durak girişi',
    username: 'Kullanıcı adı',
    password: 'Şifre',
    show: 'Göster',
    hide: 'Gizle',
    submit: 'GİRİŞ YAP',
    submitting: 'Giriş yapılıyor…',
    forgot: 'Şifrenizi unuttuysanız yöneticiye başvurun.',
    missing: 'Kullanıcı adı ve şifreyi girin.',
    err: {
      credentials: 'Kullanıcı adı veya şifre hatalı.',
      rateLimited: (wait: string) => `Çok fazla deneme. ${wait} sonra tekrar deneyin.`,
    },
  },
  pending: {
    title: 'Onay bekleniyor',
    body: 'Durağınız onay bekliyor. Yönetici onaylayınca giriş yapabilirsiniz.',
    suspendedTitle: 'Hesabınız askıya alındı',
    suspendedBody: 'Durak hesabı askıya alındı. Yöneticiyle görüşün.',
    back: 'GİRİŞE DÖN',
  },
  session: { ended: 'Oturum sona erdi. Tekrar giriş yapın.' },
  err: {
    network: 'İnternet bağlantısı yok. Tekrar deneyin.',
    server: 'Sunucuya ulaşılamadı. Biraz sonra tekrar deneyin.',
    retry: 'TEKRAR DENE',
  },
  bar: {
    connected: 'Bağlı',
    connecting: 'Bağlanıyor…',
    disconnected: 'Bağlantı yok',
    soundOn: 'SESİ AÇ',
    nearby: (n: number) => `${n} araç yakında`,
    nearbyNone: 'Yakında araç yok',
    nearbyUnknown: '–',
    settings: 'AYARLAR',
  },
  form: {
    title: 'Yeni çağrı',
    submit: 'ÇAĞRI OLUŞTUR',
    submitting: 'Gönderiliyor…',
    needPin: 'Haritada alış noktasını seçin.',
    needAddress: 'Alış adresini yazın.',
    addressManual: 'Adres bulunamadı. Adresi yazın.',
    addressMismatch: 'Adres, haritadaki işaretle uyuşmayabilir. Adresi kontrol edin.',
    addressSearching: 'Adres aranıyor…',
    pickupLabel: 'Alış adresi',
    pickupPlaceholder: 'Adresi yazın ya da haritadan seçin',
    search: 'ARA',
    searchNone: 'Sonuç bulunamadı.',
    searchFailed: 'Adres araması yapılamadı.',
    recent: 'Son adresler',
    recentClear: 'Temizle',
    addDropoff: '+ Varış ekle',
    removeDropoff: 'Varışı kaldır',
    dropoffLabel: 'Varış adresi (isteğe bağlı)',
    dropoffFromMap: 'HARİTADAN SEÇ',
    dropoffPick: 'BU NOKTAYI VARIŞ YAP',
    dropoffCancel: 'VAZGEÇ',
    addNote: '+ Not',
    noteLabel: 'Not (isteğe bağlı)',
    myLocation: 'KONUMUM',
    offline: 'Bağlantı yok. Çağrı oluşturulamıyor.',
    timeout: 'Yanıt gelmedi. Çağrı oluşmuş olabilir; listeyi kontrol edin.',
    locked: (sec: number) => `Yinelenen çağrıyı önlemek için ${sec} sn bekleyin.`,
    created: (code: string) => `Çağrı oluşturuldu: ${code}`,
    duplicate: (code: string) => `Bu adrese açık çağrı var: ${code}`,
    err: {
      validation: 'Bilgileri kontrol edin.',
      rateLimited: 'Çok hızlı. Birkaç saniye bekleyin.',
      internal: 'Çağrı oluşturulamadı. Tekrar deneyin.',
    },
  },
  map: {
    vehicleStale: 'konum eski',
    tilesFailed: 'Harita yüklenemedi. Adresi yazın.',
    pickupPin: 'Alış noktası',
    dropoffPin: 'Varış noktası',
  },
  list: {
    title: 'AÇIK ÇAĞRILAR',
    empty: 'Açık çağrı yok. Soldan çağrı oluşturun.',
    loading: 'Yükleniyor…',
    stale: 'Bağlantı yok. Kartlar son bilinen durumu gösteriyor.',
    closedWhileAway: (n: number) => `${n} çağrı siz yokken kapandı.`,
    recent: 'Son çağrılar',
    recentCompleted: 'Tamamlandı',
    recentCancelled: 'İptal',
    recentNone: 'Bu oturumda kapanan çağrı yok.',
  },
  card: {
    created: 'BAŞLATILIYOR',
    searching: 'ARANIYOR',
    matched: 'EŞLEŞTİ',
    completed: 'TAMAMLANDI',
    cancelled: 'İPTAL EDİLDİ',
    unknownBadge: 'SONUÇ BİLİNMİYOR',
    starting: 'Şoför aranıyor…',
    startDelayed: 'Arama gecikti. Bağlantıyı kontrol edin.',
    detail: (elapsed: string, wave: number, km: string, n: number) =>
      `${elapsed} · ${wave}. tarama · ${km} · ${n} şoföre bildirildi`,
    noDrivers: 'Yakında aktif araç yok. Arama sürüyor.',
    stillOpen: (n: number) => `${n} dakikadır aranıyor.`,
    keepWaiting: 'BEKLEMEYE DEVAM',
    driverCancelled: (name: string, plate: string) => `${name} (${plate}) vazgeçti. Arama yeniden başladı.`,
    driverSuspended: (name: string, plate: string) => `${name} (${plate}) hesabı kapatıldı. Arama yeniden başladı.`,
    reasonPrefix: 'Sebep: ',
    standSuspended: 'Durak hesabı askıya alındığı için çağrı kapandı.',
    ok: 'TAMAM',
    changed: 'Çağrı durumu değişti.',
    unknown: 'Sonuç bilinmiyor. Bağlantı gelince güncellenecek.',
    complete: 'TAMAMLANDI',
    cancel: 'İPTAL ET',
    matchedDistance: (d: string) => `${d} uzakta (eşleşme anında)`,
    lastLocation: (sec: number) => (sec < 5 ? 'Son konum: şimdi' : `Son konum: ${sec} sn önce`),
    noLocation: 'Araç konumu bekleniyor',
    locationStale: 'Konum eski, araç sinyali kaybolmuş olabilir',
    matchedSince: (e: string) => `Eşleşme: ${e} önce`,
    details: 'Çağrı ayrıntıları alınıyor…',
  },
  cancel: {
    title: 'Çağrı iptal edilsin mi?',
    matchedNote: (name: string) => `${name} yola çıkmış olabilir; şoföre haber verilecek.`,
    reasonLabel: 'Sebep (isteğe bağlı):',
    reasons: ['Müşteri vazgeçti', 'Başka araç bulundu', 'Yanlış adres', 'Diğer'] as const,
    otherPlaceholder: 'Kısa sebep yazın',
    back: 'VAZGEÇ',
    confirm: 'İPTAL ET',
    working: 'İptal ediliyor…',
  },
  complete: {
    title: 'Yolculuk tamamlandı mı?',
    note: 'Şoför tamamlamadıysa siz kapatın.',
    confirm: 'TAMAMLANDI',
    back: 'VAZGEÇ',
    working: 'Kapatılıyor…',
  },
  settings: {
    title: 'Ayarlar',
    radius: 'Arama yarıçapı',
    initial: 'Başlangıç yarıçapı',
    max: 'En büyük yarıçap',
    note: 'Değişiklik yalnızca sonraki çağrılara uygulanır.',
    save: 'KAYDET',
    saving: 'Kaydediliyor…',
    saved: 'Kaydedildi.',
    sounds: 'Bu cihazda ses',
    soundsHint: 'Yalnızca bu tablette çalar.',
    logout: 'ÇIKIŞ YAP',
    close: 'KAPAT',
    version: 'Sürüm',
    err: { range: 'En büyük yarıçap, başlangıçtan küçük olamaz.' },
  },
  logout: {
    title: 'Çıkış yapılsın mı?',
    confirmOpen: 'Açık çağrılar sürer; tekrar girince görünür.',
    body: 'Hesabınız tüm cihazlarda kapanır.',
    confirm: 'ÇIKIŞ YAP',
    back: 'VAZGEÇ',
  },
  a11y: {
    matched: (code: string, name: string, plate: string) => `Çağrı ${code} eşleşti. Şoför ${name}, plaka ${plate}.`,
    driverCancelled: (code: string, name: string) => `Çağrı ${code}: şoför ${name} vazgeçti. Arama yeniden başladı.`,
    stillOpen: (code: string, n: number) => `Çağrı ${code} ${n} dakikadır aranıyor.`,
    cardName: (code: string, state: string, elapsed: string) => `${code}, ${state}, ${elapsed}`,
  },
} as const;

/** Genel ack/REST hatası -> kullanıcıya Türkçe metin. `RIDE_NOT_AVAILABLE` gibi ride kodları panelde de anlaşılır. */
export function errorText(code: ErrorCode | 'TIMEOUT' | 'NETWORK'): string {
  switch (code) {
    case 'VALIDATION_ERROR': return T.form.err.validation;
    case 'RATE_LIMITED': return T.form.err.rateLimited;
    case 'RIDE_NOT_AVAILABLE':
    case 'INVALID_TRANSITION':
    case 'VERSION_CONFLICT': return T.card.changed;
    case 'NOT_FOUND': return T.card.changed;
    case 'FORBIDDEN': return 'Bu işlem için yetkiniz yok.';
    case 'NETWORK': return T.err.network;
    case 'TIMEOUT': return T.form.timeout;
    case 'UNAUTHORIZED':
    case 'ACCOUNT_PENDING':
    case 'ACCOUNT_SUSPENDED': return T.session.ended;
    default: return T.err.server;
  }
}
