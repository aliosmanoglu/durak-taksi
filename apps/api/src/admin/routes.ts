import { Router } from 'express';
import { z } from 'zod';
import { ACCOUNT_STATUSES } from '@duraknet/shared';
import { requireAuth } from '../auth/middleware';
import type { AuthDeps } from '../auth/service';
import { latOf, lngOf } from '../db';
import { errors, parseBody } from '../http/errors';
import type { PresenceService } from '../presence/service';
import type { Realtime } from '../realtime';

const listQuery = z.object({ status: z.enum(ACCOUNT_STATUSES).optional() });
const idParam = z.object({ id: z.uuid() });

export function adminRoutes(deps: AuthDeps, realtime: Realtime, presence?: PresenceService): Router {
  const r = Router();
  r.use('/admin', requireAuth(deps, 'admin'));

  r.get('/admin/drivers', async (req, res) => {
    const { status } = parseBody(listQuery, req.query);
    let q = deps.db
      .selectFrom('drivers')
      .select([
        'id', 'full_name as fullName', 'phone', 'plate', 'license_no as licenseNo',
        'vehicle_model as vehicleModel', 'vehicle_color as vehicleColor',
        'home_stand_id as homeStandId', 'status', 'created_at as createdAt', 'approved_at as approvedAt',
      ])
      .orderBy('created_at', 'desc')
      .limit(500);
    if (status) q = q.where('status', '=', status);
    res.json({ ok: true, data: await q.execute() });
  });

  r.get('/admin/stands', async (req, res) => {
    const { status } = parseBody(listQuery, req.query);
    let q = deps.db
      .selectFrom('stands')
      .select([
        'id', 'name', 'phone', 'address', 'username', 'status', 'created_at as createdAt',
        latOf('location').as('lat'), lngOf('location').as('lng'),
      ])
      .orderBy('created_at', 'desc')
      .limit(500);
    if (status) q = q.where('status', '=', status);
    res.json({ ok: true, data: await q.execute() });
  });

  // Onay: bekleyen veya askıdaki hesabı açar. token_version değişmez.
  r.post('/admin/drivers/:id/approve', async (req, res) => {
    const { id } = parseBody(idParam, req.params);
    const row = await deps.db
      .updateTable('drivers')
      .set({ status: 'approved', approved_at: new Date() })
      .where('id', '=', id)
      .returning(['id', 'status'])
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    res.json({ ok: true, data: row });
  });

  r.post('/admin/stands/:id/approve', async (req, res) => {
    const { id } = parseBody(idParam, req.params);
    const row = await deps.db
      .updateTable('stands')
      .set({ status: 'approved' })
      .where('id', '=', id)
      .returning(['id', 'status'])
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    res.json({ ok: true, data: row });
  });

  // Askıya alma: durum + token_version tek UPDATE'te değişir → tüm refresh/access token'lar anında geçersiz.
  // Ardından açık socket'ler kesilir ve şoför GEO'dan çıkarılır (sweeper'ı beklemeden aramalara girmesin).
  // Sıra: önce socket kesilir (yeni event gelmesin), sonra forceOffline. forceOffline hata verirse istek
  // 500 döner ama askıya alma PG'de commit edilmiştir; tekrar denemek idempotenttir.
  r.post('/admin/drivers/:id/suspend', async (req, res) => {
    const { id } = parseBody(idParam, req.params);
    const row = await deps.db
      .updateTable('drivers')
      .set((eb) => ({ status: 'suspended', token_version: eb('token_version', '+', 1) }))
      .where('id', '=', id)
      .returning(['id', 'status'])
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    realtime.disconnectAccount('driver', id);
    await presence?.forceOffline(id);
    res.json({ ok: true, data: row });
  });

  r.post('/admin/stands/:id/suspend', async (req, res) => {
    const { id } = parseBody(idParam, req.params);
    const row = await deps.db
      .updateTable('stands')
      .set((eb) => ({ status: 'suspended', token_version: eb('token_version', '+', 1) }))
      .where('id', '=', id)
      .returning(['id', 'status'])
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    realtime.disconnectAccount('stand', id);
    res.json({ ok: true, data: row });
  });

  return r;
}
