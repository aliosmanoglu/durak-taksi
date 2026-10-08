// Worker Prometheus metrikleri (Faz 5, docs/design/faz5-resilience.md Bölüm 4).
// Küme geneli gauge'lar (aktif şoför, açık ride) YALNIZCA burada üretilir: API node'larında üretilse çoklu replikada
// çift sayılırdı. Gauge'lar scrape sırasında hesaplanır (`collect`); PG sayımı 10 sn önbelleklenir.
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';
import { redisKeys } from '@duraknet/shared';

export type WorkerMetrics = ReturnType<typeof buildMetrics>;

const OPEN_RIDES_CACHE_MS = 10_000;

function buildMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const source: { redis?: Redis; pool?: Pool } = {};
  let openRidesCache: { at: number; counts: Record<string, number> } | undefined;

  const pushTotal = new Counter({
    name: 'duraknet_push_total',
    help: 'Push gönderim sonuçları',
    // sent | error | device_not_registered | failed | timeout | receipt_error
    labelNames: ['result'] as const,
    registers: [registry],
  });
  new Gauge({
    name: 'duraknet_drivers_active',
    help: 'Şoför sayıları (küme geneli): available = GEO, online = heartbeat, busy = fark',
    labelNames: ['status'] as const,
    registers: [registry],
    async collect() {
      const redis = source.redis;
      if (!redis) return;
      try {
        const [available, online] = await Promise.all([redis.zcard(redisKeys.geoAvailable), redis.zcard(redisKeys.heartbeat)]);
        this.set({ status: 'available' }, available);
        this.set({ status: 'online' }, online);
        this.set({ status: 'busy' }, Math.max(0, online - available));
      } catch {
        // Redis erişilemiyorsa gauge son değerinde kalır; /metrics 500 vermesin.
      }
    },
  });
  new Gauge({
    name: 'duraknet_open_rides',
    help: 'Açık ride sayıları (PG, 10 sn önbellek)',
    labelNames: ['status'] as const,
    registers: [registry],
    async collect() {
      const pool = source.pool;
      if (!pool) return;
      try {
        if (!openRidesCache || Date.now() - openRidesCache.at > OPEN_RIDES_CACHE_MS) {
          const r = await pool.query<{ status: string; n: string }>(
            `SELECT status, count(*) AS n FROM rides WHERE status IN ('searching', 'matched') GROUP BY status`,
          );
          const counts: Record<string, number> = { searching: 0, matched: 0 };
          for (const row of r.rows) counts[row.status] = Number(row.n);
          openRidesCache = { at: Date.now(), counts };
        }
        for (const [status, n] of Object.entries(openRidesCache.counts)) this.set({ status }, n);
      } catch {
        // PG erişilemiyorsa gauge son değerinde kalır; /metrics 500 vermesin.
      }
    },
  });

  return {
    registry,
    pushTotal,
    /** Küme gauge'larının okuyacağı bağlantılar. */
    bind(deps: { redis: Redis; pool: Pool }) {
      source.redis = deps.redis;
      source.pool = deps.pool;
      openRidesCache = undefined;
    },
  };
}

let singleton: WorkerMetrics | undefined;
/** Süreç başına tek örnek (sayaçlar; kullanıcı/ride state'i değil). */
export function workerMetrics(): WorkerMetrics {
  return (singleton ??= buildMetrics());
}
