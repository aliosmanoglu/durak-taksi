// Telefon / plaka / süre biçimlendirme. Ham telefon ekrana yalnızca giriş/kayıt alanında (şoförün kendi
// yazdığı) çıkar; başka her yerde `maskPhone` kullanılır (tasarım Bölüm 8).

/** Kullanıcının yazdığını "05XX XXX XX XX" biçimine getirir (yalnızca görüntü; doğrulama `phoneSchema`). */
export function formatPhoneInput(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('90') && d.length > 10) d = `0${d.slice(2)}`;
  else if (d.length > 0 && !d.startsWith('0')) d = `0${d}`;
  d = d.slice(0, 11);
  const parts = [d.slice(0, 4), d.slice(4, 7), d.slice(7, 9), d.slice(9, 11)].filter((p) => p.length > 0);
  return parts.join(' ');
}

/** "+905321234567" → "+90 5** *** ** 67". Tanınmayan biçimde yalnızca son iki hane görünür. */
export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  const last2 = d.slice(-2);
  if (d.length >= 10) return `+90 ${d.slice(-10, -9)}** *** ** ${last2}`;
  return `*** ${last2}`;
}

/** "34ABC123" → "34 ABC 123". Biçim tanınmazsa olduğu gibi döner. */
export function formatPlate(plate: string): string {
  const p = plate.replace(/\s/g, '').toUpperCase();
  const m = /^(\d{2})([A-Z]{1,3})(\d{2,4})$/.exec(p);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : p;
}

/** Kilit süresi metni: "12 dk" / "45 sn". */
export function formatWait(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.ceil(s / 60)} dk` : `${s} sn`;
}

/** Geri sayım düğmesi: "11:48". */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Araç: renk + model ("Beyaz Fiat Egea"); ikisi de yoksa null. */
export function formatVehicle(color?: string | null, model?: string | null): string | null {
  const v = [color, model].filter((x): x is string => !!x && x.trim().length > 0).join(' ');
  return v.length > 0 ? v : null;
}

/** Mesafe: < 1000 m → "850 m", ≥ 1000 → "1,2 km" (Türkçe ondalık virgülü). */
export function formatDistance(m: number): string {
  const v = Math.max(0, m);
  if (Math.round(v) < 1000) return `${Math.round(v)} m`;
  return `${(Math.round(v / 100) / 10).toFixed(1).replace('.', ',')} km`;
}

/**
 * Geçen süre (faz3 Bölüm 2): < 60 sn → "42 sn"; < 60 dk → "3 dk 05 sn"; ≥ 60 dk → "1 sa 12 dk".
 * Negatif değer 0'a sabitlenir.
 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk ${String(s % 60).padStart(2, '0')} sn`;
  return `${Math.floor(m / 60)} sa ${String(m % 60).padStart(2, '0')} dk`;
}

/** Ekran okuyucu için geçen süre: yalnızca dakika eşikleri ("2 dakika"); 1 dk altında "1 dakikadan az". */
export function formatElapsedA11y(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return '1 dakikadan az';
  if (m < 60) return `${m} dakika`;
  return `${Math.floor(m / 60)} saat ${m % 60} dakika`;
}
