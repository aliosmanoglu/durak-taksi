// Worker'ın küçük HTTP sunucusu (Faz 5): /health (süreç ayakta), /ready (PG + Redis + sweeper tazeliği; kapanışta 503),
// /metrics (API ile aynı token kuralı: token varsa Bearer zorunlu; yoksa 404; METRICS_ALLOW_ANON=true ile açılır). Başka uç yoktur.
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Registry } from 'prom-client';

export type ReadinessResult = { ok: boolean; checks: Record<string, 'ok' | 'fail'> };

export type WorkerHttpOptions = {
  port: number;
  registry: Registry;
  readiness: () => Promise<ReadinessResult>;
  isShuttingDown: () => boolean;
  metricsToken?: string;
  allowAnon: boolean;
};

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export type WorkerHttp = { port: number; server: Server; close(): Promise<void> };

export async function startWorkerHttp(opts: WorkerHttpOptions): Promise<WorkerHttp> {
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const path = (req.url ?? '/').split('?')[0];
        if (req.method !== 'GET') return json(res, 404, { ok: false });
        if (path === '/health') return json(res, 200, { status: 'ok' });
        if (path === '/ready') {
          if (opts.isShuttingDown()) return json(res, 503, { status: 'shutting_down', checks: {} });
          const r = await opts.readiness();
          return json(res, r.ok ? 200 : 503, { status: r.ok ? 'ready' : 'not_ready', checks: r.checks });
        }
        if (path === '/metrics') {
          if (opts.metricsToken) {
            const h = req.headers.authorization;
            const given = h?.startsWith('Bearer ') ? h.slice(7) : '';
            if (!safeEqual(given, opts.metricsToken)) return json(res, 401, { ok: false });
          } else if (!opts.allowAnon) {
            return json(res, 404, { ok: false });
          }
          res.writeHead(200, { 'Content-Type': opts.registry.contentType });
          res.end(await opts.registry.metrics());
          return;
        }
        json(res, 404, { ok: false });
      } catch {
        if (!res.headersSent) json(res, 500, { ok: false });
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
