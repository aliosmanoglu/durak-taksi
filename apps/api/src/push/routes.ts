// Şoför push token kaydı (Faz 5, docs/design/faz5-resilience.md Bölüm 1). Şoför başına tek token; aynı token başka
// şoförde kayıtlıysa ONDAN aynı transaction'da silinir (telefon el değiştirirse eski hesaba bildirim gitmesin).
import type { RequestHandler } from 'express';
import { Router } from 'express';
import { pushTokenSchema } from '@duraknet/shared';
import { authOf, requireAuth } from '../auth/middleware';
import type { AuthDeps } from '../auth/service';
import { isUniqueViolation } from '../db';
import { errors, parseBody } from '../http/errors';

export function pushTokenRoutes(deps: AuthDeps, putLimiter?: RequestHandler): Router {
  const r = Router();
  const auth = requireAuth(deps, 'driver');

  r.put('/me/push-token', auth, ...(putLimiter ? [putLimiter] : []), async (req, res) => {
    const { token } = parseBody(pushTokenSchema, req.body);
    const id = authOf(res).sub;
    // Eşzamanlı iki PUT aynı token'ı farklı şoförlere yazmaya çalışırsa kısmi UNIQUE indeks biri reddeder; yeniden dene.
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.db.transaction().execute(async (trx) => {
          await trx.updateTable('drivers').set({ push_token: null }).where('push_token', '=', token).where('id', '!=', id).execute();
          const row = await trx.updateTable('drivers').set({ push_token: token }).where('id', '=', id).returning('id').executeTakeFirst();
          if (!row) throw errors.notFound();
        });
        break;
      } catch (err) {
        // 23505: aynı token'ın eşzamanlı yazımı; 40P01: iki PUT'un karşılıklı token takası (deadlock). İkisi de yeniden denenir.
        const code = (err as { code?: string }).code;
        if (!(isUniqueViolation(err) || code === '40P01') || attempt >= 3) throw err;
      }
    }
    res.json({ ok: true });
  });

  r.delete('/me/push-token', auth, async (_req, res) => {
    await deps.db.updateTable('drivers').set({ push_token: null }).where('id', '=', authOf(res).sub).execute();
    res.json({ ok: true });
  });

  return r;
}
