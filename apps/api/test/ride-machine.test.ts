// Ride durum makinesi geçiş matrisi (saf veri; Docker gerektirmez). Uygulama testi: ride-lifecycle.integration.test.ts.
import { describe, expect, it } from 'vitest';
import {
  canTransition, RIDE_ACTORS, RIDE_STATUSES, RIDE_TRANSITIONS, RIDE_TRANSITION_REASONS, TERMINAL_RIDE_STATUSES,
} from '@duraknet/shared';

describe('ride durum makinesi matrisi', () => {
  it('terminal durumlardan (completed, cancelled) çıkış yoktur', () => {
    for (const t of RIDE_TRANSITIONS) expect(TERMINAL_RIDE_STATUSES).not.toContain(t.from);
  });

  it('cancelled\'a yalnızca durak geçirir (zaman aşımı/sistem iptali yok)', () => {
    for (const t of RIDE_TRANSITIONS.filter((x) => x.to === 'cancelled')) expect(t.actors).toEqual(['stand']);
    for (const from of RIDE_STATUSES) {
      for (const reason of RIDE_TRANSITION_REASONS) {
        for (const actor of RIDE_ACTORS.filter((a) => a !== 'stand')) {
          expect(canTransition(from, 'cancelled', reason, actor)).toBe(false);
        }
      }
    }
    expect(canTransition('searching', 'cancelled', 'stand_cancelled', 'stand')).toBe(true);
    expect(canTransition('matched', 'cancelled', 'stand_cancelled', 'stand')).toBe(true);
    // created iptal edilemez (dispatch_started ile hemen searching'e geçer).
    expect(canTransition('created', 'cancelled', 'stand_cancelled', 'stand')).toBe(false);
  });

  it('matched → searching yalnızca şoför iptali (driver) ya da askıya alma (system); durak değil', () => {
    expect(canTransition('matched', 'searching', 'driver_cancelled', 'driver')).toBe(true);
    expect(canTransition('matched', 'searching', 'driver_suspended', 'system')).toBe(true);
    expect(canTransition('matched', 'searching', 'driver_cancelled', 'stand')).toBe(false);
    expect(canTransition('matched', 'searching', 'driver_suspended', 'driver')).toBe(false);
  });

  it('completed yalnızca matched\'tan; şoför ve durak tamamlayabilir, sistem tamamlayamaz', () => {
    expect(canTransition('matched', 'completed', 'completed', 'driver')).toBe(true);
    expect(canTransition('matched', 'completed', 'completed', 'stand')).toBe(true);
    expect(canTransition('matched', 'completed', 'completed', 'system')).toBe(false);
    for (const from of RIDE_STATUSES.filter((s) => s !== 'matched')) {
      expect(canTransition(from, 'completed', 'completed', 'driver')).toBe(false);
      expect(canTransition(from, 'completed', 'completed', 'stand')).toBe(false);
    }
  });

  it('kabul yalnızca searching → matched ve yalnızca şoför', () => {
    expect(canTransition('searching', 'matched', 'driver_accepted', 'driver')).toBe(true);
    expect(canTransition('searching', 'matched', 'driver_accepted', 'stand')).toBe(false);
    expect(canTransition('created', 'matched', 'driver_accepted', 'driver')).toBe(false);
    expect(canTransition('completed', 'matched', 'driver_accepted', 'driver')).toBe(false);
  });

  it('created → searching yalnızca sistem; created\'dan başka çıkış yok', () => {
    expect(canTransition('created', 'searching', 'dispatch_started', 'system')).toBe(true);
    expect(canTransition('created', 'searching', 'dispatch_started', 'stand')).toBe(false);
    expect(RIDE_TRANSITIONS.filter((t) => t.from === 'created')).toHaveLength(1);
  });
});
