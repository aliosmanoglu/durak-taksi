// Prometheus metrikleri (Faz 5, docs/design/faz5-resilience.md Bölüm 4).
// Süreç başına tek `Registry` (prom-client'ın standart kalıbı): bu kullanıcı/ride/socket state'i değil, yalnızca sayaçlardır.
// Küme geneli gauge'lar (aktif şoför, açık ride) burada YOK: çoklu replikada çift sayılmasın diye yalnızca worker üretir.
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export type ApiMetrics = ReturnType<typeof buildMetrics>;

function buildMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    /** `driver_location_update` handler süresi (Faz 2'den açık p95 ölçümü). */
    locationUpdateSeconds: new Histogram({
      name: 'duraknet_location_update_seconds',
      help: 'driver_location_update handler süresi',
      buckets: [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [registry],
    }),
    ridesTotal: new Counter({
      name: 'duraknet_rides_total',
      help: 'Ride yaşam döngüsü olayları',
      labelNames: ['event'] as const, // created | matched | completed | cancelled
      registers: [registry],
    }),
    matchSeconds: new Histogram({
      name: 'duraknet_match_seconds',
      help: 'Eşleşme süresi (matched_at - searching_at)',
      buckets: [1, 2, 5, 10, 20, 30, 45, 60, 90, 120, 300, 600],
      registers: [registry],
    }),
    socketConnections: new Gauge({
      name: 'duraknet_socket_connections',
      help: 'Bu node\'daki açık socket bağlantıları',
      labelNames: ['namespace'] as const,
      registers: [registry],
    }),
    rateLimitedTotal: new Counter({
      name: 'duraknet_rate_limited_total',
      help: 'Hız sınırına takılan istekler',
      labelNames: ['scope'] as const,
      registers: [registry],
    }),
    rateLimitErrorsTotal: new Counter({
      name: 'duraknet_rate_limit_errors_total',
      help: 'Hız sınırlayıcının Redis hataları (fail-open)',
      registers: [registry],
    }),
  };
}

let singleton: ApiMetrics | undefined;
/** Süreç başına tek örnek (aynı süreçteki birden fazla app/test örneği aynı sayaçları paylaşır). */
export function apiMetrics(): ApiMetrics {
  return (singleton ??= buildMetrics());
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * `/metrics` işleyicisi. Token tanımlıysa `Authorization: Bearer <token>` zorunludur (401);
 * tanımsızsa uç HER ORTAMDA kapalıdır (404); yalnızca açık `allowAnon` (METRICS_ALLOW_ANON=true) tokensız açar.
 */
export function metricsHandler(registry: Registry, opts: { token?: string; allowAnon: boolean }): RequestHandler {
  return async (req, res) => {
    if (opts.token) {
      const h = req.headers.authorization;
      const given = h?.startsWith('Bearer ') ? h.slice(7) : '';
      if (!safeEqual(given, opts.token)) {
        res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Kimlik doğrulanamadı' } });
        return;
      }
    } else if (!opts.allowAnon) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Bulunamadı' } });
      return;
    }
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  };
}
