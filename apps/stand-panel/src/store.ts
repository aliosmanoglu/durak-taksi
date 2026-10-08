// Panelin tek zustand store'u: yalnızca durum ve saf güncelleyiciler. Ağ/ses gibi yan etkiler
// `src/services/**` altındadır (store'u onlar çağırır; tersi yok).
import { create } from 'zustand';
import type { LatLng } from '@duraknet/shared';
import { initialDriverLocs, pruneLocations, type DriverLocs } from './lib/driver-locations';
import { initialRidesState, type RidesState } from './lib/rides';
import type { RecentAddress } from './lib/recent-addresses';
import { loadRecent, loadSoundEnabled } from './services/storage';
import type { Me } from './services/types';

export type AuthStatus = 'booting' | 'bootFailed' | 'anon' | 'authed' | 'blocked';
export type ConnState = 'connecting' | 'connected' | 'disconnected';
export type Toast = { id: number; text: string; tone: 'info' | 'warn' | 'error' };
export type PendingCreate = {
  pickupAddress: string;
  pickup: LatLng;
  knownIds: string[];
  sentAtMs: number;
  /** Zaman aşımına uğrayan gönderimin idempotency kimliği ve içerik imzası (aynı içerikte yeniden kullanılır). */
  clientRequestId: string;
  signature: string;
};

export type PanelState = {
  auth: AuthStatus;
  blockedKind: 'pending' | 'suspended' | null;
  /** Giriş ekranında gösterilecek bilgi şeridi (oturum sona erdi vb.). */
  loginNotice: string | null;
  me: Me | null;
  /** Oturumun rolü; yönetici panelde yalnızca rapor ekranını görür (socket bağlanmaz). */
  role: 'stand' | 'admin' | null;
  conn: ConnState;
  ridesState: RidesState;
  /** Eşleşmiş ride'ların araç konumu (rideId → konum); ride matched'tan çıkınca silinir. */
  driverLocs: DriverLocs;
  /** Sunucu - cihaz saati farkı (ms); her `session_sync.serverTime` ile güncellenir. */
  clockOffset: number;
  nearby: { drivers: { id: string; location: LatLng }[]; atMs: number } | null;
  audioUnlocked: boolean;
  soundEnabled: boolean;
  toasts: Toast[];
  /** Yalnızca ekran okuyucu için (aria-live assertive). */
  announcement: { id: number; text: string } | null;
  /** Ses kilitliyken / sekme gizliyken görülmemiş uyarı sayısı (sekme başlığı). */
  alerts: number;
  /** Yeni kart eklendikten sonraki 600 ms: mevcut kartların düğmeleri devre dışı. */
  shiftLocked: boolean;
  /** `ride_create` zaman aşımından sonra 15 sn kilit (epoch ms). */
  createLockUntil: number;
  pendingCreate: PendingCreate | null;
  /** Artınca oluşturma formu sıfırlanır (key ile yeniden kurulur). */
  formNonce: number;
  recent: RecentAddress[];
  set: (p: Partial<PanelState>) => void;
};

export const useStore = create<PanelState>((set) => ({
  auth: 'booting',
  blockedKind: null,
  loginNotice: null,
  me: null,
  role: null,
  conn: 'connecting',
  ridesState: initialRidesState(),
  driverLocs: initialDriverLocs(),
  clockOffset: 0,
  nearby: null,
  audioUnlocked: false,
  soundEnabled: loadSoundEnabled(),
  toasts: [],
  announcement: null,
  alerts: 0,
  shiftLocked: false,
  createLockUntil: 0,
  pendingCreate: null,
  formNonce: 0,
  recent: loadRecent(),
  set: (p) => set(p),
}));

let seq = 1;
let shiftTimer: ReturnType<typeof setTimeout> | undefined;

/** Ride durumunu günceller; listeye yeni kart girdiyse 600 ms düğme kilidi başlatır. */
export function updateRides(fn: (s: RidesState) => RidesState): void {
  const st = useStore.getState();
  const next = fn(st.ridesState);
  if (next === st.ridesState) return;
  const prevIds = new Set(Object.keys(st.ridesState.rides));
  const gotNew = Object.keys(next.rides).some((id) => !prevIds.has(id));
  const locs = pruneLocations(st.driverLocs, next);
  st.set({ ridesState: next, ...(locs !== st.driverLocs ? { driverLocs: locs } : {}), ...(gotNew && prevIds.size > 0 ? { shiftLocked: true } : {}) });
  if (gotNew && prevIds.size > 0) {
    clearTimeout(shiftTimer);
    shiftTimer = setTimeout(() => useStore.getState().set({ shiftLocked: false }), 600);
  }
}

export function pushToast(text: string, tone: Toast['tone'] = 'info', ttlMs = 5000): void {
  const id = seq++;
  const st = useStore.getState();
  st.set({ toasts: [...st.toasts, { id, text, tone }].slice(-4) });
  setTimeout(() => {
    const cur = useStore.getState();
    cur.set({ toasts: cur.toasts.filter((t) => t.id !== id) });
  }, ttlMs);
}

export function announce(text: string): void {
  useStore.getState().set({ announcement: { id: seq++, text } });
}

/** Ses kilitliyken ya da sekme gizliyken görsel vurguyu güçlendirmek için sayaç artırır. */
export function noteAlert(): void {
  const st = useStore.getState();
  if (!st.audioUnlocked || document.visibilityState !== 'visible') st.set({ alerts: st.alerts + 1 });
}

/** Oturum kapanınca (çıkış / sona erme) oturuma bağlı bütün durumu sıfırlar. */
export function resetSessionState(): void {
  useStore.getState().set({
    me: null,
    role: null,
    conn: 'connecting',
    ridesState: initialRidesState(),
    driverLocs: initialDriverLocs(),
    nearby: null,
    alerts: 0,
    shiftLocked: false,
    createLockUntil: 0,
    pendingCreate: null,
    toasts: [],
    announcement: null,
  });
}
