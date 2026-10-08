// Saf biçimlendirme yardımcıları (docs/design/faz3-dispatch.md Bölüm 2).

/** `< 60 sn` → "42 sn"; `< 60 dk` → "3 dk 05 sn"; `≥ 60 dk` → "1 sa 12 dk". Negatif 0'a sabitlenir. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  if (total < 60) return `${total} sn`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} dk ${String(total % 60).padStart(2, '0')} sn`;
  return `${Math.floor(minutes / 60)} sa ${String(minutes % 60).padStart(2, '0')} dk`;
}

/** Ekran okuyucu için: yalnızca tam dakika ("3 dakika"; 1 dakikadan azsa "1 dakikadan az"). */
export function formatElapsedA11y(ms: number): string {
  const minutes = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 60_000);
  return minutes < 1 ? '1 dakikadan az' : `${minutes} dakika`;
}

const trNumber = (n: number): string => n.toFixed(1).replace(/\.0$/, '').replace('.', ',');

/** `< 1000` → "850 m"; aksi halde "1,2 km". */
export function formatDistance(m: number): string {
  const v = Math.max(0, Number.isFinite(m) ? m : 0);
  return v < 1000 ? `${Math.round(v)} m` : `${trNumber(v / 1000)} km`;
}

/** Yarıçap: 4000 → "4 km", 2500 → "2,5 km", 500 → "0,5 km". */
export function formatRadiusKm(m: number): string {
  return `${trNumber(Math.max(0, m) / 1000)} km`;
}

/** "+905321234567" → "0532 123 45 67". Tanınmayan biçim olduğu gibi döner. */
export function formatPhone(phone: string): string {
  const m = /^\+90(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone.trim());
  return m ? `0${m[1]} ${m[2]} ${m[3]} ${m[4]}` : phone;
}

/** `tel:` bağlantısı için yalnızca rakam ve baştaki +. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}
