import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { store, type AppState } from '@/lib/store';

/** Store seçici kancası. Nesne döndüren seçicilerde `useShallow` kullanın. */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(store, selector);
}

/** Saniyelik saat: geri sayım ve "n sn önce" çipleri için. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
