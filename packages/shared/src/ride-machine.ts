// CLAUDE.md Bölüm 1 — ride durum makinesi, saf veri. Uygulama (RideStateMachine) apps/api'dedir;
// geçiş kuralları yalnızca buradan okunur.
import type { RideStatus } from './types';

export const RIDE_ACTORS = ['system', 'driver', 'stand'] as const;
export type RideActor = (typeof RIDE_ACTORS)[number];

/** Geçişin tetikleyicisi; aynı (from, to) çiftine birden çok sebep düşebilir. */
export const RIDE_TRANSITION_REASONS = [
  'dispatch_started', // created → searching (sistem)
  'driver_accepted', // searching → matched
  'driver_cancelled', // matched → searching (şoför)
  'driver_suspended', // matched → searching (yönetici askıya aldı / çıkış; sistem)
  'stand_cancelled', // searching|matched → cancelled
  'stand_suspended', // searching|matched → cancelled (yönetici durağı askıya aldı; sistem — tek istisna)
  'completed', // matched → completed
] as const;
/** `cancel_reason` ve `ride_cancelled.reason`: durak askıya alındığı için sistem iptal etti. */
export const STAND_SUSPENDED_REASON = 'stand_suspended' as const;
/** `ride_driver_cancelled.reason` ve geçiş sebebi: şoför yönetici askısıyla düştü (şoför kendi vazgeçmedi). */
export const DRIVER_SUSPENDED_REASON = 'driver_suspended' as const;
export type RideTransitionReason = (typeof RIDE_TRANSITION_REASONS)[number];

export type RideTransition = {
  from: RideStatus;
  to: RideStatus;
  reason: RideTransitionReason;
  actors: readonly RideActor[];
};

export const RIDE_TRANSITIONS: readonly RideTransition[] = [
  { from: 'created', to: 'searching', reason: 'dispatch_started', actors: ['system'] },
  { from: 'searching', to: 'matched', reason: 'driver_accepted', actors: ['driver'] },
  { from: 'matched', to: 'searching', reason: 'driver_cancelled', actors: ['driver'] },
  { from: 'matched', to: 'searching', reason: 'driver_suspended', actors: ['system'] },
  // `cancelled`'a yalnızca durak geçirir; zaman aşımı / sistem iptali yoktur.
  { from: 'searching', to: 'cancelled', reason: 'stand_cancelled', actors: ['stand'] },
  { from: 'matched', to: 'cancelled', reason: 'stand_cancelled', actors: ['stand'] },
  // Tek istisna: durak askıya alınınca açık ride'ları sistem iptal eder (başka sistem kaynaklı iptal yoktur).
  { from: 'searching', to: 'cancelled', reason: 'stand_suspended', actors: ['system'] },
  { from: 'matched', to: 'cancelled', reason: 'stand_suspended', actors: ['system'] },
  { from: 'matched', to: 'completed', reason: 'completed', actors: ['driver', 'stand'] },
];

export function findRideTransition(
  from: RideStatus,
  to: RideStatus,
  reason: RideTransitionReason,
): RideTransition | undefined {
  return RIDE_TRANSITIONS.find((t) => t.from === from && t.to === to && t.reason === reason);
}

/** Geçiş geçerli mi (durum çifti + sebep + aktör)? Geçersizse çağıran `INVALID_TRANSITION` döner. */
export function canTransition(
  from: RideStatus,
  to: RideStatus,
  reason: RideTransitionReason,
  actor: RideActor,
): boolean {
  return findRideTransition(from, to, reason)?.actors.includes(actor) ?? false;
}
