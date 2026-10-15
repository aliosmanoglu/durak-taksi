// KVKK aydınlatma metni (TASLAK). Asıl kaynak: docs/legal/kvkk-aydinlatma-taslak.md; hukuk onayından sonra
// bu sabit belgeden güncellenir. Sürüm sözleşmeden gelir (KVKK_NOTICE_VERSION), sunucuda kayda yazılır.
export { KVKK_NOTICE_VERSION } from '@duraknet/shared';

export const KVKK_DRAFT_LABEL = 'TASLAK';

export const KVKK_NOTICE_TITLE = 'KVKK Aydınlatma Metni';

export const KVKK_NOTICE_PARAGRAPHS: readonly string[] = [
  'Bu metin taslaktır; hukuki inceleme sonrası güncellenecektir.',
  'DurakNet, taksi durakları ile şoförler arasındaki çağrı iletişimini ve eşleşmeyi sağlamak amacıyla kayıt sırasında verdiğiniz bilgileri (ad, telefon, plaka, ruhsat numarası veya kullanıcı adı, durak konumu) ve hizmet sırasında şoförlerin anlık konumunu işler.',
  'Müşteri adı ve telefonu tutulmaz. Şoför konumu yalnızca çağrı eşleştirme için geçici olarak işlenir, kalıcı olarak saklanmaz.',
  'Verileriniz hizmetin yürütülmesi, hesap güvenliği ve hizmet kalitesinin ölçülmesi amaçlarıyla işlenir. Harita görüntüleri üçüncü taraf bir sağlayıcıdan yüklenir.',
  'KVKK madde 11 kapsamındaki haklarınız (bilgi alma, düzeltme, silme vb.) için sistem yöneticisine başvurabilirsiniz.',
];
