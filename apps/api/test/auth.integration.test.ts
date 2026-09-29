// Faz 1 (kimlik & temel veri) entegrasyon testleri — gerçek PostGIS + Redis (testcontainers).
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { issueTokens } from '../src/auth/tokens';
import { ADMIN_USERNAME, PASSWORD, startTestApp, uniquePhone, uniquePlate, type TestApp } from './helpers/app';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp();
});
afterEach(async () => {
  await t.cleanup();
});
afterAll(async () => {
  await t?.close();
});

const bearer = (token: string) => `Bearer ${token}`;

describe('Faz 1 kabul kriteri', () => {
  it('1. kayıt olan şoför pending açılır; giriş 403 ACCOUNT_PENDING', async () => {
    const d = await t.registerDriver();
    expect(d.status).toBe('pending');

    const res = await t.loginDriver(d.phone.local);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'ACCOUNT_PENDING' } });
  });

  it('2. pending şoför geçerli access token ile /driver handshake yapamaz (polling)', async () => {
    const d = await t.registerDriver();
    const { accessToken } = issueTokens(t.deps.secrets, { sub: d.id, role: 'driver', tv: 0 });

    const err = await t.connectError('/driver', accessToken); // varsayılan transport: polling
    expect(err.message).toBe('ACCOUNT_PENDING');
    expect(err.data).toMatchObject({ code: 'ACCOUNT_PENDING' });
  });

  it('2b. pending durak /stand handshake yapamaz', async () => {
    const s = await t.registerStand();
    const { accessToken } = issueTokens(t.deps.secrets, { sub: s.id, role: 'stand', tv: 0 });
    const err = await t.connectError('/stand', accessToken);
    expect(err.message).toBe('ACCOUNT_PENDING');
  });

  it('3. onay sonrası giriş başarılı ve /driver bağlanır; roller namespace\'ler arası geçemez', async () => {
    const d = await t.approvedDriver();
    const s = await t.approvedStand();

    const drv = await t.connectOk('/driver', d.tokens.accessToken);
    expect(drv.connected).toBe(true);
    const std = await t.connectOk('/stand', s.tokens.accessToken);
    expect(std.connected).toBe(true);

    const standOnDriver = await t.connectError('/driver', s.tokens.accessToken);
    expect(standOnDriver.message).toBe('FORBIDDEN');
    const driverOnStand = await t.connectError('/stand', d.tokens.accessToken);
    expect(driverOnStand.message).toBe('FORBIDDEN');
  });

  it('4. askıya alma: eski refresh 401, eski access /me 401, açık socket kesilir', async () => {
    const d = await t.approvedDriver();
    const sock = await t.connectOk('/driver', d.tokens.accessToken);
    const disconnected = new Promise<string>((r) => sock.once('disconnect', (reason) => r(reason)));

    // Askıya almadan önce token'lar çalışıyor (kontrol).
    expect((await t.http().get('/me').set('Authorization', bearer(d.tokens.accessToken))).status).toBe(200);

    const row = await t.adminAction('drivers', d.id, 'suspend');
    expect(row.status).toBe('suspended');

    expect(await disconnected).toBe('io server disconnect');

    const ref = await t.http().post('/auth/refresh').send({ refreshToken: d.tokens.refreshToken });
    expect(ref.status).toBe(401);
    expect(ref.body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });

    const me = await t.http().get('/me').set('Authorization', bearer(d.tokens.accessToken));
    expect(me.status).toBe(401);

    // Eski access token ile yeniden bağlanamaz.
    const err = await t.connectError('/driver', d.tokens.accessToken);
    expect(err.message).toBe('UNAUTHORIZED');

    // Askıdaki hesap şifreyle de giriş yapamaz.
    const login = await t.loginDriver(d.phone.e164);
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('4b. durak askıya alınınca açık /stand socket\'i kesilir ve refresh 401', async () => {
    const s = await t.approvedStand();
    const sock = await t.connectOk('/stand', s.tokens.accessToken);
    const disconnected = new Promise<string>((r) => sock.once('disconnect', (reason) => r(reason)));
    await t.adminAction('stands', s.id, 'suspend');
    expect(await disconnected).toBe('io server disconnect');
    const ref = await t.http().post('/auth/refresh').send({ refreshToken: s.tokens.refreshToken });
    expect(ref.status).toBe(401);
  });

  it('5. yeniden onay eski token\'ları geri getirmez; yeni giriş çalışır', async () => {
    const d = await t.approvedDriver();
    await t.adminAction('drivers', d.id, 'suspend');
    await t.adminAction('drivers', d.id, 'approve');

    const ref = await t.http().post('/auth/refresh').send({ refreshToken: d.tokens.refreshToken });
    expect(ref.status).toBe(401);
    const me = await t.http().get('/me').set('Authorization', bearer(d.tokens.accessToken));
    expect(me.status).toBe(401);
    expect((await t.connectError('/driver', d.tokens.accessToken)).message).toBe('UNAUTHORIZED');

    const login = await t.loginDriver(d.phone.e164);
    expect(login.status).toBe(200);
    const fresh = login.body.data as { accessToken: string; refreshToken: string };
    const me2 = await t.http().get('/me').set('Authorization', bearer(fresh.accessToken));
    expect(me2.status).toBe(200);
    expect(me2.body.data).toMatchObject({ role: 'driver', id: d.id, status: 'approved' });
    expect((await t.http().post('/auth/refresh').send({ refreshToken: fresh.refreshToken })).status).toBe(200);
    const sock = await t.connectOk('/driver', fresh.accessToken);
    expect(sock.connected).toBe(true);
  });
});

describe('giriş ve kayıt', () => {
  it('yanlış şifre ve olmayan kullanıcı aynı 401 INVALID_CREDENTIALS gövdesini döner', async () => {
    const d = await t.approvedDriver();
    const wrong = await t.loginDriver(d.phone.e164, 'yanlis-sifre-999');
    const missing = await t.loginDriver(uniquePhone().e164, 'yanlis-sifre-999');
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body).toEqual({ ok: false, error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) } });
    expect(missing.body).toEqual(wrong.body);

    const s = await t.approvedStand();
    const standWrong = await t.loginStand(s.username, 'yanlis-sifre-999');
    const standMissing = await t.loginStand('olmayan_durak_xyz', 'yanlis-sifre-999');
    const adminWrong = await t.http().post('/auth/login').send({ role: 'admin', username: ADMIN_USERNAME, password: 'yanlis' });
    for (const r of [standWrong, standMissing, adminWrong]) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual(wrong.body);
    }
  });

  it('pending hesap yanlış şifreyle INVALID_CREDENTIALS alır (durum şifreden önce sızmaz)', async () => {
    const d = await t.registerDriver();
    const res = await t.loginDriver(d.phone.e164, 'yanlis-sifre-999');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('telefon ve plaka normalize edilerek saklanır', async () => {
    const phone = uniquePhone();
    const plate = uniquePlate();
    const spaced = `${plate.slice(0, 2)} ${plate.slice(2, 5).toLowerCase()} ${plate.slice(5)}`;
    const res = await t.http().post('/auth/driver/register')
      .send({ fullName: 'Norm Test', phone: phone.local, password: PASSWORD, plate: spaced, licenseNo: 'RUHSAT-2' });
    expect(res.status).toBe(201);
    // Temizlik için hesabı kaydet: aynı telefonla helper üzerinden değil doğrudan kaydedildi.
    const row = await t.db.selectFrom('drivers').select(['phone', 'plate']).where('id', '=', res.body.data.id).executeTakeFirstOrThrow();
    await t.db.deleteFrom('drivers').where('id', '=', res.body.data.id).execute();
    expect(row).toEqual({ phone: phone.e164, plate });
  });

  it('aynı telefon / plaka / durak kullanıcı adıyla tekrar kayıt 409 CONFLICT', async () => {
    const d = await t.registerDriver();

    const samePhone = await t.http().post('/auth/driver/register').send({
      fullName: 'Kopya', phone: d.phone.e164, password: PASSWORD, plate: uniquePlate(), licenseNo: 'RUHSAT-3',
    });
    expect(samePhone.status).toBe(409);
    expect(samePhone.body).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    const samePlate = await t.http().post('/auth/driver/register').send({
      fullName: 'Kopya', phone: uniquePhone().local, password: PASSWORD, plate: d.plate.toLowerCase(), licenseNo: 'RUHSAT-3',
    });
    expect(samePlate.status).toBe(409);
    expect(samePlate.body.error.code).toBe('CONFLICT');

    const s = await t.registerStand();
    const sameUser = await t.http().post('/auth/stand/register').send({
      name: 'Kopya Durak', phone: uniquePhone().local, location: { lat: 41, lng: 29 },
      username: s.username.toUpperCase(), password: PASSWORD,
    });
    expect(sameUser.status).toBe(409);
    expect(sameUser.body.error.code).toBe('CONFLICT');
  });
});

describe('token tipleri ve yetki', () => {
  it('access token /auth/refresh\'e verilirse 401; refresh token Authorization başlığında 401', async () => {
    const d = await t.approvedDriver();
    const r1 = await t.http().post('/auth/refresh').send({ refreshToken: d.tokens.accessToken });
    expect(r1.status).toBe(401);
    expect(r1.body.error.code).toBe('UNAUTHORIZED');

    const r2 = await t.http().get('/me').set('Authorization', bearer(d.tokens.refreshToken));
    expect(r2.status).toBe(401);
    expect(r2.body.error.code).toBe('UNAUTHORIZED');

    // Refresh token socket handshake'inde de geçmez.
    expect((await t.connectError('/driver', d.tokens.refreshToken)).message).toBe('UNAUTHORIZED');
  });

  it('admin olmayan token ile /admin/* 403, token\'sız 401', async () => {
    const d = await t.approvedDriver();
    const s = await t.approvedStand();
    for (const token of [d.tokens.accessToken, s.tokens.accessToken]) {
      const r = await t.http().get('/admin/drivers').set('Authorization', bearer(token));
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN');
      const a = await t.http().post(`/admin/drivers/${d.id}/suspend`).set('Authorization', bearer(token));
      expect(a.status).toBe(403);
    }
    const none = await t.http().get('/admin/stands');
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('UNAUTHORIZED');

    // Rol değişmedi.
    const row = await t.db.selectFrom('drivers').select('status').where('id', '=', d.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('approved');
  });

  it('admin listeleri ?status=pending ile filtreler', async () => {
    const pending = await t.registerDriver();
    const approved = await t.approvedDriver();
    const r = await t.http().get('/admin/drivers?status=pending').set('Authorization', bearer(await t.adminToken()));
    expect(r.status).toBe(200);
    const ids = (r.body.data as { id: string; status: string }[]).map((x) => x.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(approved.id);
    expect((r.body.data as { status: string }[]).every((x) => x.status === 'pending')).toBe(true);
    // password_hash sızmıyor
    expect(JSON.stringify(r.body)).not.toContain('argon2');
  });

  it('olmayan hesap için approve 404', async () => {
    const r = await t.http()
      .post('/admin/drivers/00000000-0000-4000-8000-000000000000/approve')
      .set('Authorization', bearer(await t.adminToken()));
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
});

describe('durak verisi', () => {
  it('/me durak konumunu {lat, lng} olarak doğru sırayla döner (PostGIS lng/lat)', async () => {
    const s = await t.approvedStand();
    const me = await t.http().get('/me').set('Authorization', bearer(s.tokens.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.role).toBe('stand');
    expect(me.body.data.location.lat).toBeCloseTo(41.0082, 6);
    expect(me.body.data.location.lng).toBeCloseTo(28.9784, 6);
    expect(me.body.data).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(me.body)).not.toContain('argon2');

    // DB'de nokta (x=lng, y=lat) olarak saklanmış olmalı.
    const { rows } = await t.pool.query<{ x: number; y: number }>(
      'SELECT ST_X(location::geometry) AS x, ST_Y(location::geometry) AS y FROM stands WHERE id = $1',
      [s.id],
    );
    expect(rows[0]!.x).toBeCloseTo(28.9784, 6);
    expect(rows[0]!.y).toBeCloseTo(41.0082, 6);
  });

  it('PATCH /stands/me/settings geçerli değeri günceller; max < initial → 400 VALIDATION_ERROR', async () => {
    const s = await t.approvedStand();
    const auth = bearer(s.tokens.accessToken);

    const ok = await t.http().patch('/stands/me/settings').set('Authorization', auth).send({ initialRadiusM: 3000, maxRadiusM: 12000 });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, data: { initialRadiusM: 3000, maxRadiusM: 12000 } });
    const me = await t.http().get('/me').set('Authorization', auth);
    expect(me.body.data).toMatchObject({ initialRadiusM: 3000, maxRadiusM: 12000 });

    const bad = await t.http().patch('/stands/me/settings').set('Authorization', auth).send({ initialRadiusM: 5000, maxRadiusM: 4000 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const row = await t.db.selectFrom('stands').select(['initial_radius_m', 'max_radius_m']).where('id', '=', s.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ initial_radius_m: 3000, max_radius_m: 12000 });
  });

  it('PATCH /stands/me/settings şoför token\'ıyla 403', async () => {
    const d = await t.approvedDriver();
    const r = await t.http().patch('/stands/me/settings').set('Authorization', bearer(d.tokens.accessToken))
      .send({ initialRadiusM: 3000, maxRadiusM: 12000 });
    expect(r.status).toBe(403);
  });

  it('set_updated_at trigger\'ı güncellemede updated_at\'i yeniler (drivers ve stands)', async () => {
    const d = await t.registerDriver();
    const s = await t.registerStand();
    for (const table of ['drivers', 'stands'] as const) {
      const id = table === 'drivers' ? d.id : s.id;
      const before = await sql<{ created_at: Date; updated_at: Date }>`
        SELECT created_at, updated_at FROM ${sql.table(table)} WHERE id = ${id}`.execute(t.db);
      // updated_at'i elle geçmişe çekmeye çalışmak da trigger tarafından ezilmeli.
      await sql`UPDATE ${sql.table(table)} SET phone = phone, updated_at = '2000-01-01T00:00:00Z' WHERE id = ${id}`.execute(t.db);
      const after = await sql<{ updated_at: Date }>`
        SELECT updated_at FROM ${sql.table(table)} WHERE id = ${id}`.execute(t.db);
      const b = before.rows[0]!;
      const a = after.rows[0]!;
      expect(b.updated_at.getTime()).toBe(b.created_at.getTime());
      expect(a.updated_at.getTime()).toBeGreaterThan(b.updated_at.getTime());
    }
  });
});

describe('socket oturumu', () => {
  it('auth_refresh: aynı hesabın yeni access token\'ı kabul, başka hesabınki UNAUTHORIZED', async () => {
    const d = await t.approvedDriver();
    const other = await t.approvedDriver();
    const sock = await t.connectOk('/driver', d.tokens.accessToken);

    const ref = await t.http().post('/auth/refresh').send({ refreshToken: d.tokens.refreshToken });
    expect(ref.status).toBe(200);
    const okAck = await sock.timeout(5000).emitWithAck('auth_refresh', { token: ref.body.data.accessToken });
    expect(okAck).toEqual({ ok: true });

    const badAck = await sock.timeout(5000).emitWithAck('auth_refresh', { token: other.tokens.accessToken });
    expect(badAck).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });

    const invalid = await sock.timeout(5000).emitWithAck('auth_refresh', {});
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });

    expect(sock.connected).toBe(true);
  });

  it('auth_refresh askıya alınmış hesabın token\'ıyla reddedilir ve bağlantı kesilir', async () => {
    const d = await t.approvedDriver();
    const sock = await t.connectOk('/driver', d.tokens.accessToken);
    // disconnectAccount'u atlatmak için askıya almayı doğrudan DB'de yap (ör. kaçırılan yayın senaryosu).
    await t.db.updateTable('drivers').set({ status: 'suspended' }).where('id', '=', d.id).execute();
    const disconnected = new Promise<string>((r) => sock.once('disconnect', (reason) => r(reason)));
    const ack = await sock.timeout(5000).emitWithAck('auth_refresh', { token: d.tokens.accessToken });
    expect(ack).toMatchObject({ ok: false, error: { code: 'ACCOUNT_SUSPENDED' } });
    expect(await disconnected).toBe('io server disconnect');
  });

  it('token\'sız ve ana namespace bağlantısı reddedilir (gerçek DB ile)', async () => {
    expect((await t.connectError('/driver', undefined)).message).toBe('UNAUTHORIZED');
    expect((await t.connectError('/', undefined)).message).toBe('FORBIDDEN');
  });
});

describe('/ready', () => {
  it('gerçek PG + Redis ile 200 döner', async () => {
    const r = await t.http().get('/ready');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });
});
