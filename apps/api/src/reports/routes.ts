import { Router } from 'express';
import type { Redis } from 'ioredis';
import { reportQuerySchema } from '@duraknet/shared';
import { requireAuth } from '../auth/middleware';
import type { AuthDeps } from '../auth/service';
import { parseBody } from '../http/errors';
import { consistencyReport, dailyReport } from './service';

/** Faz 6 raporları: yalnızca admin. `redis` yoksa tutarlılık ucu eklenmez (404). */
export function reportRoutes(deps: AuthDeps, redis: Redis | undefined, staleCreatedAgeS: number): Router {
  const r = Router();
  r.use('/admin/reports', requireAuth(deps, 'admin'));

  r.get('/admin/reports/daily', async (req, res) => {
    const q = parseBody(reportQuerySchema, req.query);
    res.json({ ok: true, data: await dailyReport(deps.db, q) });
  });

  if (redis) {
    r.get('/admin/reports/consistency', async (_req, res) => {
      res.json({ ok: true, data: await consistencyReport(deps.db, redis, staleCreatedAgeS) });
    });
  }
  return r;
}
