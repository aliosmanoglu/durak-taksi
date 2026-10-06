// Ekranı uyanık tutar (Screen Wake Lock API). Desteklenmezse hiçbir şey yapılmaz (gizli video hilesi yok);
// kurulum belgesinde "ekran zaman aşımını kapatın" notu yeterlidir. Sekme görünür olunca yeniden alınır.
type Sentinel = { release(): Promise<void>; addEventListener(t: 'release', cb: () => void): void };
type WakeNav = Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } };

let sentinel: Sentinel | null = null;
let wanted = false;
let listening = false;

async function acquire() {
  const wl = (navigator as WakeNav).wakeLock;
  if (!wl || !wanted || sentinel || document.visibilityState !== 'visible') return;
  try {
    const s = await wl.request('screen');
    sentinel = s;
    s.addEventListener('release', () => {
      if (sentinel === s) sentinel = null;
    });
    if (!wanted) await release();
  } catch {
    /* pil tasarrufu vb. nedeniyle reddedilebilir; sessiz geç */
  }
}

async function release() {
  const s = sentinel;
  sentinel = null;
  try {
    await s?.release();
  } catch {
    /* yok say */
  }
}

export function keepScreenAwake(on: boolean): void {
  wanted = on;
  if (!listening) {
    listening = true;
    document.addEventListener('visibilitychange', () => void acquire());
  }
  if (on) void acquire();
  else void release();
}
