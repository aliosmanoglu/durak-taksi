import { Router } from 'express';
import { sql } from 'kysely';
import pino, { type Logger } from 'pino';
import { z } from 'zod';
import { ACCOUNT_STATUSES } from '@duraknet/shared';
import { requireAuth } from '../auth/middleware';
import type { AuthDeps } from '../auth/service';
import { latOf, lngOf } from '../db';
import { errors, parseBody } from '../http/errors';
import type { PresenceService } from '../presence/service';
import type { RideService } from '../rides/service';
import type { PushNotifier } from '../push/notifier';
import type { Realtime } from '../realtime';

const listQuery = z.object({ status: z.enum(ACCOUNT_STATUSES).optional() });
const idParam = z.object({ id: z.uuid() });

export function adminRoutes(deps: AuthDeps, realtime: Realtime, presence?: PresenceService, rides?: RideService, log: Logger = pino({ level: 'silent' }), notifier?: PushNotifier): Router {
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
  async function suspendDriver(id: string) {
    // Tek UPDATE: durum + token_version artar, push token silinir; eski token `account_suspended` bildirimi için döner.
    const res1 = await sql<{ id: string; status: 'suspended'; old_token: string | null }>`
      UPDATE drivers d
         SET status = 'suspended', token_version = d.token_version + 1, push_token = NULL
        FROM (SELECT id, push_token FROM drivers WHERE id = ${id} FOR UPDATE) old
       WHERE d.id = old.id
      RETURNING d.id, d.status, old.push_token AS old_token`.execute(deps.db);
    const found = res1.rows[0];
    if (!found) throw errors.notFound();
    const row = { id: found.id, status: found.status };
    realtime.disconnectAccount('driver', id);
    // Bildirim yan etkidir ve BEKLENMEZ: Redis kesintisinde kuyruğa ekleme takılsa bile askıya alma yanıtı ve yukarıdaki
    // adımlar gecikmez (ve bu adımlar hata verse de bildirim atılır). Token UPDATE sırasında yakalanmıştır. Hata/takılma yalnızca loglanır.
    if (found.old_token && notifier) {
      const token = found.old_token;
      void Promise.resolve()
        .then(() => notifier.accountSuspended(token))
        .catch((err: unknown) =>
          log.warn({ err: err instanceof Error ? err.message : String(err), driverId: id }, 'askıya alma bildirimi kuyruğa alınamadı'),
        );
    }
    // Faz 3 kararı (b): eşleşmiş ride varsa searching'e döner (sebep driver_suspended); sonra şoför offline olur.
    // releaseDriverForSuspension hata verse de forceOffline çalışır (şoför GEO'da kalmasın); hata yine yukarı gider.
    try {
      await rides?.releaseDriverForSuspension(id);
    } finally {
      await presence?.forceOffline(id);
    }
    return row;
  }

  r.post('/admin/drivers/:id/suspend', async (req, res) => {
    const { id } = parseBody(idParam, req.params);
    res.json({ ok: true, data: await suspendDriver(id) });
  });

  async function suspendStand(id: string) {
    const row = await deps.db
      .updateTable('stands')
      .set((eb) => ({ status: 'suspended', token_version: eb('token_version', '+', 1) }))
      .where('id', '=', id)
      .returning(['id', 'status'])
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    realtime.disconnectAccount('stand', id);
    // Durak askıya alma = açık çağrıları sistem iptal eder (tek istisna; sebep `stand_suspended`). Askıya alma
    // yukarıdaki UPDATE ile commit edilmiştir: ride iptali hata verirse hesap askıda kalır, hata loglanır ve
    // istek başarılı döner; kaçan ride'ları worker uzlaştırıcısı kapatır (PG'de açık ride + askıdaki durak).
    try {
      await rides?.releaseStandForSuspension(id);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), standId: id }, 'durak askıya alma: açık çağrılar iptal edilemedi');
    }
    return row;
  }

  r.post('/admin/stands/:id/suspend', async (req, res) => {
    const { id } = parseBody(idParam, req.params);
    res.json({ ok: true, data: await suspendStand(id) });
  });

  // KVKK silme talebi (Faz 6): kişisel alanlar yer tutucuyla değiştirilir, hesap askıda kalır; ride kayıtları
  // istatistik için durur. Önce askıya alma akışı çalışır (socket kesilir, açık ride'lar bırakılır, push token silinir),
  // sonra alanlar boşaltılır. UNIQUE telefon/plaka için yer tutucu id'den türetilir (kolon uzunluklarına sığar:
  // phone varchar(20), plate varchar(15)). İdempotent: tekrar çağrı aynı sonucu verir. Durak konumu (NOT NULL)
  // işletme adresi sayıldığı için korunur. Loga kişisel veri yazılmaz.
  r.post('/admin/drivers/:id/anonymize', async (req, res) => {
    const { id } = parseBody(idParam, req.params);
    await suspendDriver(id);
    const hex = id.replace(/-/g, '');
    const row = await deps.db
      .updateTable('drivers')
      .set((eb) => ({
        full_name: 'Silinmiş kullanıcı',
        phone: `del-${hex.slice(0, 16)}`,
        plate: `DEL${hex.slice(0, 11)}`,
        license_no: 'silindi',
        vehicle_model: null,
        vehicle_color: null,
        push_token: null,
        home_stand_id: null,
        password_hash: 'anonymized',
        status: 'suspended',
        token_version: eb('token_version', '+', 1),
      }))
      .where('id', '=', id)
      .returning(['id', 'status'])
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    log.info({ driverId: id }, 'şoför anonimleştirildi');
    res.json({ ok: true, data: { id: row.id, status: row.status, anonymized: true } });
  });

  r.post('/admin/stands/:id/anonymize', async (req, res) => {
    const { id } = parseBody(idParam, req.params);
    await suspendStand(id);
    const hex = id.replace(/-/g, '');
    const row = await deps.db
      .updateTable('stands')
      .set((eb) => ({
        name: 'Silinmiş durak',
        phone: `del-${hex.slice(0, 16)}`,
        address: null,
        username: `deleted-${id}`,
        password_hash: 'anonymized',
        status: 'suspended',
        token_version: eb('token_version', '+', 1),
      }))
      .where('id', '=', id)
      .returning(['id', 'status'])
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    log.info({ standId: id }, 'durak anonimleştirildi');
    res.json({ ok: true, data: { id: row.id, status: row.status, anonymized: true } });
  });

  return r;
}
