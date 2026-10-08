// Sunucu saati farkı (E-6: `serverTime` / `serverNow`). Geçen süre cihaz saatiyle değil, sunucuya göre
// düzeltilmiş saatle hesaplanır; böylece cihaz saati kaymış olsa da süre doğru çıkar.

/** Sunucu − cihaz farkı (ms). Geçersiz ISO → `null` (eski fark korunur). Gecikme (~RTT/2) ihmal edilir. */
export function clockOffset(serverIso: string | undefined, deviceNow: number): number | null {
  if (!serverIso) return null;
  const t = Date.parse(serverIso);
  return Number.isFinite(t) ? t - deviceNow : null;
}

/** Bir olaydan bu yana geçen süre (ms), sunucu saatine göre; negatif 0'a sabitlenir. */
export function elapsedSince(createdIso: string, deviceNow: number, offsetMs: number): number {
  const t = Date.parse(createdIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, deviceNow + offsetMs - t);
}
