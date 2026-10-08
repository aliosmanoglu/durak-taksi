// Cihaz saati ile sunucu saati farkı (Q8 / E-6): `session_sync.serverTime` ile ölçülür.

/** Sunucu - cihaz farkı (ms). Geçersiz tarih → 0 (düzeltme yapılmaz). */
export function computeClockOffset(serverTimeIso: string, deviceNowMs: number): number {
  const t = Date.parse(serverTimeIso);
  return Number.isFinite(t) ? t - deviceNowMs : 0;
}

/** Cihaz saatinden düzeltilmiş "sunucu şimdi". */
export function serverNowMs(deviceNowMs: number, offsetMs: number): number {
  return deviceNowMs + offsetMs;
}

/** `sinceIso`'dan beri geçen süre (ms); sunucu saatine göre, negatif 0'a sabitlenir. */
export function elapsedSince(sinceIso: string | undefined, deviceNowMs: number, offsetMs: number): number {
  if (!sinceIso) return 0;
  const t = Date.parse(sinceIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, serverNowMs(deviceNowMs, offsetMs) - t);
}
