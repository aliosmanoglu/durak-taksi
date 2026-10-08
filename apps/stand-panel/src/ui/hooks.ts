import { useSyncExternalStore } from 'react';

// Tek global saniye sayacı: her kart kendi interval'ini kurmaz.
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const subs = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      subs.forEach((f) => f());
    }, 1000);
  }
  return () => {
    subs.delete(cb);
    if (subs.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Cihaz saati (epoch ms), saniyede bir güncellenir. Sunucu saatine çevirmek için `clockOffset` eklenir. */
export const useNow = (): number => useSyncExternalStore(subscribe, () => now);
