// Ses uyarıları (Web Audio, harici dosya yok). Tarayıcılar kullanıcı dokunuşu olmadan ses çalmaz:
// `unlockAudio` bir düğme tıklamasından çağrılır. Kilit kalıcı değildir (sayfa yenilenince tekrar gerekir).
// Ses yalnızca yardımcıdır; her olayın görsel karşılığı vardır.
import { useStore } from '../store';

export type SoundKind = 'matched' | 'driverCancelled' | 'stillOpen';

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  ctx.addEventListener('statechange', () => useStore.getState().set({ audioUnlocked: ctx?.state === 'running' }));
  return ctx;
}

/** Kullanıcı dokunuşunda çağrılır; başarılıysa `audioUnlocked` true olur ve kısa bir onay sesi çalar. */
export async function unlockAudio(): Promise<boolean> {
  const c = getCtx();
  if (!c) return false;
  try {
    await c.resume();
  } catch {
    return false;
  }
  const ok = c.state === 'running';
  useStore.getState().set({ audioUnlocked: ok });
  if (ok) tone(c, 880, 0, 0.12, 0.08);
  return ok;
}

function tone(c: AudioContext, freq: number, startOffset: number, dur: number, gain: number, type: OscillatorType = 'sine') {
  const t0 = c.currentTime + startOffset;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** Ayar kapalıysa veya ses kilitliyse sessizce çıkar (görsel uyarı zaten vardır). */
export function playSound(kind: SoundKind): void {
  const { soundEnabled } = useStore.getState();
  if (!soundEnabled || !ctx || ctx.state !== 'running') return;
  switch (kind) {
    case 'matched': // yükselen iki nota
      tone(ctx, 660, 0, 0.18, 0.18);
      tone(ctx, 880, 0.2, 0.3, 0.18);
      break;
    case 'driverCancelled': // güçlü: üç kısa tiz-pes darbe
      for (let i = 0; i < 3; i++) tone(ctx, i % 2 ? 520 : 760, i * 0.28, 0.22, 0.3, 'square');
      break;
    case 'stillOpen': // hafif tek bip
      tone(ctx, 600, 0, 0.2, 0.1);
      break;
  }
}
