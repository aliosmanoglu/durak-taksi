/**
 * Oturum nesil sayacı. Uçuştaki asenkron bir iş (ör. refresh) başlarken nesli alır; sonucu yazmadan önce
 * nesil hâlâ aynı mı diye bakar. Çıkış / oturum sonu / yeni giriş nesli artırır, böylece geç dönen bir
 * yanıt kapatılmış oturumu geri yazamaz (token kaydetme, zamanlayıcı kurma).
 */
export function createGeneration() {
  let gen = 0;
  return {
    current: () => gen,
    bump: () => ++gen,
    isCurrent: (g: number) => g === gen,
  };
}
