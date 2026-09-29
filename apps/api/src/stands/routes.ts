import { Router } from 'express';
import { standSettingsSchema } from '@duraknet/shared';
import { authOf, requireAuth } from '../auth/middleware';
import type { AuthDeps } from '../auth/service';
import { errors, parseBody } from '../http/errors';

export function standRoutes(deps: AuthDeps): Router {
  const r = Router();

  // Durak kendi arama yarıçaplarını ayarlar (CLAUDE.md Senaryo 4, dalga stratejisi).
  r.patch('/stands/me/settings', requireAuth(deps, 'stand'), async (req, res) => {
    const input = parseBody(standSettingsSchema, req.body);
    const row = await deps.db
      .updateTable('stands')
      .set({ initial_radius_m: input.initialRadiusM, max_radius_m: input.maxRadiusM })
      .where('id', '=', authOf(res).sub)
      .returning(['initial_radius_m as initialRadiusM', 'max_radius_m as maxRadiusM'])
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    res.json({ ok: true, data: row });
  });

  return r;
}
