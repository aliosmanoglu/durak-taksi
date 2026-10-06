// Sınırlı yeniden deneme (üstel bekleme). Yalnızca idempotent işlemler için kullanılır.
export type RetryOptions = { attempts?: number; baseDelayMs?: number };

/** `fn` hata verirse en çok `attempts` kez dener (varsayılan 3; bekleme 50, 150, ... ms). Son hata fırlatılır. */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 50;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, base * 3 ** i));
    }
  }
  throw last;
}
