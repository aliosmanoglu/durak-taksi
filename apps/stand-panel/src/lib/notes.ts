// Hızlı not etiketleri + serbest metin → tek `notes` alanı (sunucu sınırı 280).
export const NOTE_MAX = 280;
export const QUICK_NOTES = ['Bagaj var', 'Engelli yolcu', 'Hastane girişi', 'Kapıda bekliyor'] as const;

export function composeNote(tags: readonly string[], text: string): string {
  return [...tags, text.trim()].filter((s) => s.length > 0).join(', ');
}

/** Sunucuya gidecek not; boşsa `undefined` (alan hiç gönderilmez). */
export function noteForRequest(tags: readonly string[], text: string): string | undefined {
  const n = composeNote(tags, text);
  return n.length === 0 ? undefined : n.slice(0, NOTE_MAX);
}
