import { Router } from 'express';
import {
  driverRegisterSchema,
  loginSchema,
  refreshSchema,
  standRegisterSchema,
} from '@duraknet/shared';
import { latOf, lngOf } from '../db';
import { errors, parseBody } from '../http/errors';
import type { AuthLimiters } from './limits';
import { authOf, requireAuth } from './middleware';
import type { Realtime } from '../realtime';
import { login, logoutAllDevices, refresh, registerDriver, registerStand, type AuthDeps } from './service';

export function authRoutes(deps: AuthDeps, limits: AuthLimiters, realtime: Realtime): Router {
  const r = Router();

  r.post('/auth/driver/register', limits.register, async (req, res) => {
    const out = await registerDriver(deps, parseBody(driverRegisterSchema, req.body));
    res.status(201).json({ ok: true, data: out });
  });

  r.post('/auth/stand/register', limits.register, async (req, res) => {
    const out = await registerStand(deps, parseBody(standRegisterSchema, req.body));
    res.status(201).json({ ok: true, data: out });
  });

  r.post('/auth/login', limits.loginByIp, limits.loginByAccount, async (req, res) => {
    res.json({ ok: true, data: await login(deps, parseBody(loginSchema, req.body)) });
  });

  r.post('/auth/refresh', limits.refresh, async (req, res) => {
    const { refreshToken } = parseBody(refreshSchema, req.body);
    res.json({ ok: true, data: await refresh(deps, refreshToken) });
  });

  // Tüm cihazlardan çıkış: token_version artar, açık socket'ler kesilir. Çağıran kendi (geçerli) token'ıyla gelir.
  r.post('/auth/logout', requireAuth(deps), async (_req, res) => {
    const claims = authOf(res);
    const role = await logoutAllDevices(deps, claims);
    realtime.disconnectAccount(role, claims.sub);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth(deps), async (_req, res) => {
    const { role, sub } = authOf(res);
    if (role === 'admin') {
      res.json({ ok: true, data: { role, id: sub } });
      return;
    }
    if (role === 'driver') {
      const d = await deps.db
        .selectFrom('drivers')
        .select([
          'id', 'full_name as fullName', 'phone', 'plate', 'license_no as licenseNo',
          'vehicle_model as vehicleModel', 'vehicle_color as vehicleColor',
          'home_stand_id as homeStandId', 'status',
        ])
        .where('id', '=', sub)
        .executeTakeFirst();
      if (!d) throw errors.notFound();
      res.json({ ok: true, data: { role, ...d } });
      return;
    }
    const s = await deps.db
      .selectFrom('stands')
      .select([
        'id', 'name', 'phone', 'address', 'username', 'status',
        'initial_radius_m as initialRadiusM', 'max_radius_m as maxRadiusM',
        latOf('location').as('lat'), lngOf('location').as('lng'),
      ])
      .where('id', '=', sub)
      .executeTakeFirst();
    if (!s) throw errors.notFound();
    const { lat, lng, ...rest } = s;
    res.json({ ok: true, data: { role, ...rest, location: { lat, lng } } });
  });

  return r;
}
