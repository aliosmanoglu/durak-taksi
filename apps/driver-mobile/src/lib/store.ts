// Uygulama durumu (zustand). React'ten bağımsız (vanilla) store: konum görevi ve servisler de erişir.
import { createStore } from 'zustand/vanilla';
import type { SessionEndReason } from './session-policy';
import { initialPresence, type PresenceState } from './presence/state';
import { initialRides, type RidesState } from './rides/state';
import type { RideSnapshot } from '@duraknet/shared';

/** `GET /me` önbelleği (şoför). Telefon yalnızca maskeli gösterilir. */
export type Profile = {
  id: string;
  fullName: string;
  phone: string;
  plate: string;
  vehicleModel: string | null;
  vehicleColor: string | null;
};

export type AuthPhase = 'booting' | 'signedOut' | 'signedIn';

/** Giriş ekranı şeridi için oturum sonu nedeni (`suspendedWithRide`: askıya alındı ve yolculuk düştü). */
export type SessionEndedView = Exclude<SessionEndReason, 'pending'> | 'suspendedWithRide';

export type AppState = PresenceState & RidesState & {
  auth: AuthPhase;
  profile: Profile | null;
  /** Giriş ekranında gösterilecek oturum sonu nedeni (4.6). */
  sessionEnded: SessionEndedView | null;
  /** Oturum `ACCOUNT_PENDING` ile bittiyse giriş yerine E3 açılır. */
  showPending: boolean;
  toast: { id: number; text: string; ms?: number } | null;
  appActive: boolean;
};

export const initialAppState = (persisted?: {
  wantsOnline?: boolean;
  lastRoutineSentAt?: number | null;
  soundEnabled?: boolean;
  activeRide?: RideSnapshot | null;
}): AppState => ({
  ...initialPresence(persisted),
  ...initialRides(persisted),
  auth: 'booting',
  profile: null,
  sessionEnded: null,
  showPending: false,
  toast: null,
  appActive: true,
});

export const store = createStore<AppState>(() => initialAppState());

let toastSeq = 0;
export function showToast(text: string, ms?: number) {
  store.setState({ toast: { id: ++toastSeq, text, ...(ms != null ? { ms } : {}) } });
}
