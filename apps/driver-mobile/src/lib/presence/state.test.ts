import { describe, expect, it } from 'vitest';
import {
  accuracyBucket,
  canSendLocation,
  fixQuality,
  fixUsableForGoOnline,
  initialPresence,
  type PresenceState,
} from './state';

const NOW = 1_800_000_000_000;
const s = (p: Partial<PresenceState> = {}): PresenceState => ({
  ...initialPresence(),
  conn: 'connected',
  server: 'available',
  lastSentAt: NOW - 5000,
  ...p,
});

describe('konum gönderim kapısı (3.4-1)', () => {
  it('yalnızca available/busy, bağlı ve session_sync alınmışken', () => {
    expect(canSendLocation(s(), NOW)).toBe(true);
    expect(canSendLocation(s({ server: 'busy' }), NOW)).toBe(true);
    expect(canSendLocation(s({ server: 'offline' }), NOW)).toBe(false);
    expect(canSendLocation(s({ server: 'unknown' }), NOW)).toBe(false);
    expect(canSendLocation(s({ conn: 'disconnected' }), NOW)).toBe(false);
    expect(canSendLocation(s({ syncPending: true }), NOW)).toBe(false);
  });
  it('go_online ack gelmeden (server offline) ve pasif olunurken gönderilmez', () => {
    expect(canSendLocation(s({ server: 'offline', intent: 'goingOnline' }), NOW)).toBe(false);
    expect(canSendLocation(s({ intent: 'goingOffline' }), NOW)).toBe(false);
    expect(canSendLocation(s({ intent: 'offlinePending' }), NOW)).toBe(false);
  });
  it('3 sn alt sınır; zorunlu gönderim (ilk konum) sınırı aşar', () => {
    expect(canSendLocation(s({ lastSentAt: NOW - 1000 }), NOW)).toBe(false);
    expect(canSendLocation(s({ lastSentAt: NOW - 1000 }), NOW, true)).toBe(true);
  });
});

describe('fix', () => {
  const fix = { at: NOW - 1000, lat: 0, lng: 0, accuracy: 20 };
  it('kalite: iyi ≤ 50 m, zayıf > 50 m, bayat > 30 sn', () => {
    expect(fixQuality(null, NOW)).toBe('none');
    expect(fixQuality(fix, NOW)).toBe('good');
    expect(fixQuality({ ...fix, accuracy: 51 }, NOW)).toBe('poor');
    expect(fixQuality({ ...fix, accuracy: null }, NOW)).toBe('poor');
    expect(fixQuality({ ...fix, at: NOW - 31_000 }, NOW)).toBe('stale');
    expect(fixQuality({ ...fix, at: NOW - 31_000 }, NOW, true)).toBe('good');
  });
  it('go_online için ≤ 30 sn ve ≤ 100 m', () => {
    expect(fixUsableForGoOnline(fix, NOW)).toBe(true);
    expect(fixUsableForGoOnline({ ...fix, accuracy: 101 }, NOW)).toBe(false);
    expect(fixUsableForGoOnline({ ...fix, at: NOW - 31_000 }, NOW)).toBe(false);
  });
  it('log için yalnızca doğruluk kovası', () => {
    expect([accuracyBucket(10), accuracyBucket(80), accuracyBucket(300), accuracyBucket(null)]).toEqual(['≤50', '≤100', '>100', 'yok']);
  });
});
