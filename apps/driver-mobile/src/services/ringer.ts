// Çağrı sesi ve titreşimi (faz3 4.4). Yalnızca ön planda çalar (Faz 5 push arka planı üstlenir).
// - İlk çağrı: "çağrı" sesi 3 kez (3 sn aralıkla), her seferinde titreşim [0, 400, 200, 400]; sonra susar.
// - Ek çağrı: tek kısa bip + tek kısa titreşim.
// - Ekrana dokunulunca (D1) veya çağrı kapanınca `stopRing` ile anında durur.
// Ses kapalıysa (Hesap anahtarı, Q6) yalnızca titreşim çalar. Cihaz sessizdeyse ses zaten çalmaz
// (`playsInSilentMode: false`); titreşim sistem tercihine bağlıdır.
import { Vibration } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { RING_PERIOD_MS, RING_REPEATS, RING_VIBRATION } from '@/lib/constants';
import { log } from '@/lib/log';
import { store } from '@/lib/store';

/* eslint-disable @typescript-eslint/no-require-imports */
const SOURCES = {
  ring: require('../../assets/sounds/ride-request.wav') as number,
  beep: require('../../assets/sounds/ride-beep.wav') as number,
};
/* eslint-enable @typescript-eslint/no-require-imports */

const players: Partial<Record<keyof typeof SOURCES, AudioPlayer>> = {};
let modeSet = false;
let timers: ReturnType<typeof setTimeout>[] = [];
/** İlk çağrı serisi sürüyor (ek çağrı yalnızca bip ekler, seriyi kesmez). */
let seriesActive = false;

async function ensureMode() {
  if (modeSet) return;
  modeSet = true;
  try {
    await setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'duckOthers', shouldPlayInBackground: false });
  } catch (e) {
    log('ringer.mode_failed', { error: e instanceof Error ? e.name : 'unknown' });
  }
}

function play(kind: keyof typeof SOURCES) {
  try {
    const p = (players[kind] ??= createAudioPlayer(SOURCES[kind]));
    void p.seekTo(0).catch(() => {});
    p.play();
  } catch (e) {
    log('ringer.play_failed', { error: e instanceof Error ? e.name : 'unknown' });
  }
}

function buzz(long: boolean) {
  try {
    if (long) Vibration.vibrate([...RING_VIBRATION]);
    else Vibration.vibrate(200);
  } catch {
    // Titreşim desteklenmiyor / izin yok: sessizce geçilir.
  }
}

export function stopRing() {
  for (const t of timers) clearTimeout(t);
  timers = [];
  seriesActive = false;
  try {
    Vibration.cancel();
    for (const p of Object.values(players)) p?.pause();
  } catch {
    // yok say
  }
}

/** `first`: liste boşken gelen ilk çağrı (3 tekrar); `extra`: liste doluyken gelen ek çağrı (tek bip). */
export function startRing(kind: 'first' | 'extra') {
  // Çalmakta olan ilk çağrı serisi ek çağrıyla kesilmez: yalnızca kısa bip eklenir.
  if (kind === 'extra' && seriesActive) {
    if (store.getState().soundEnabled) play('beep');
    return;
  }
  stopRing();
  void ensureMode();
  const soundOn = store.getState().soundEnabled;
  const repeats = kind === 'first' ? RING_REPEATS : 1;
  for (let i = 0; i < repeats; i++) {
    timers.push(
      setTimeout(
        () => {
          if (soundOn) play(kind === 'first' ? 'ring' : 'beep');
          buzz(kind === 'first');
        },
        i * RING_PERIOD_MS,
      ),
    );
  }
  seriesActive = true;
  // Son tekrar bitince seri biter (ses ~1,4 sn sürer).
  timers.push(
    setTimeout(() => {
      seriesActive = false;
    }, (repeats - 1) * RING_PERIOD_MS + 1_500),
  );
}
