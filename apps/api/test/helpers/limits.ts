// Faz 5 hız sınırı override'ı: testler düşük limitle koşar (gerçek 600/dk'yı doldurmak yerine).
// Backend'in seçenek adı değişirse yalnızca burası güncellenir. Biçim `RATE_LIMITS` (packages/shared) ile aynıdır.
import type { RATE_LIMITS } from '@duraknet/shared';
import type { StartTestAppOptions } from './app';

type Limit = { limit: number; windowMs: number };
export type LimitOverride = {
  restIp?: Limit;
  restAccount?: Limit;
  pushTokenPut?: Limit;
  socketHandshakeIp?: Limit;
  events?: Partial<Record<keyof typeof RATE_LIMITS.events, Limit>>;
};

export const perMin = (limit: number): Limit => ({ limit, windowMs: 60_000 });

/** createApp + createRealtime'a aynı override'ı verir. */
export function withLimits(over: LimitOverride): Pick<StartTestAppOptions, 'appExtras' | 'realtimeExtras'> {
  return { appExtras: { rateLimits: over }, realtimeExtras: { rateLimits: over } };
}
