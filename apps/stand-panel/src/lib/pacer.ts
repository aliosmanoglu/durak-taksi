// Nominatim: saniyede en çok 1 istek. Saf zamanlayıcı: her çağrı bir sonraki serbest an için bekleme süresi verir.
export function createPacer(gapMs: number) {
  let nextFree = 0;
  return {
    /** Bu istek için kaç ms beklenmeli; yuva ayrılır (ardışık çağrılar `gapMs` aralıkla sıralanır). */
    reserve(nowMs: number): number {
      const start = Math.max(nowMs, nextFree);
      nextFree = start + gapMs;
      return start - nowMs;
    },
  };
}

/** Elle yazılmış adres varken pin hareket ettiyse adres pin'le uyuşmayabilir. */
export function addressMismatch(addressEdited: boolean, pinMoved: boolean): boolean {
  return addressEdited && pinMoved;
}
