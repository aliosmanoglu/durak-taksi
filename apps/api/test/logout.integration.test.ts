import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './helpers/app';

const bearer = (t: string) => `Bearer ${t}`;

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterEach(() => t.cleanup());
afterAll(() => t.close());

describe('POST /auth/logout (tüm cihazlardan çıkış)', () => {
  it('şoför: token_version artar, eski access/refresh token geçersiz olur, açık socket kesilir', async () => {
    const d = await t.approvedDriver();
    const sock = await t.connectOk('/driver', d.tokens.accessToken);
    const disconnected = new Promise<string>((r) => sock.once('disconnect', (reason) => r(reason)));

    const before = await t.db.selectFrom('drivers').select('token_version').where('id', '=', d.id).executeTakeFirstOrThrow();

    const res = await t.http().post('/auth/logout').set('Authorization', bearer(d.tokens.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const after = await t.db.selectFrom('drivers').select('token_version').where('id', '=', d.id).executeTakeFirstOrThrow();
    expect(after.token_version).toBe(before.token_version + 1);

    expect(await disconnected).toBe('io server disconnect');
    expect((await t.http().post('/auth/refresh').send({ refreshToken: d.tokens.refreshToken })).status).toBe(401);
    expect((await t.http().get('/me').set('Authorization', bearer(d.tokens.accessToken))).status).toBe(401);
    expect((await t.connectError('/driver', d.tokens.accessToken)).message).toBe('UNAUTHORIZED');
  });

  it('çıkıştan sonra şifreyle yeniden giriş yapılabilir (hesap askıya alınmaz)', async () => {
    const d = await t.approvedDriver();
    await t.http().post('/auth/logout').set('Authorization', bearer(d.tokens.accessToken));

    const again = await t.loginDriver(d.phone.e164);
    expect(again.status).toBe(200);
    const me = await t.http().get('/me').set('Authorization', bearer(again.body.data.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.status).toBe('approved');
  });

  it('kaybolan telefon senaryosu: ikinci cihazdan girip çıkış yapmak birinci cihazın oturumunu da kapatır', async () => {
    const d = await t.approvedDriver();
    const lostPhone = d.tokens; // çalınan/kaybolan cihazdaki oturum
    const newPhone = await t.loginDriver(d.phone.e164);
    expect(newPhone.status).toBe(200);

    // Kaybolan cihazın refresh token'ı çıkıştan önce hâlâ geçerli.
    expect((await t.http().post('/auth/refresh').send({ refreshToken: lostPhone.refreshToken })).status).toBe(200);

    const out = await t.http().post('/auth/logout').set('Authorization', bearer(newPhone.body.data.accessToken));
    expect(out.status).toBe(200);

    expect((await t.http().post('/auth/refresh').send({ refreshToken: lostPhone.refreshToken })).status).toBe(401);
    expect((await t.http().post('/auth/refresh').send({ refreshToken: newPhone.body.data.refreshToken })).status).toBe(401);
  });

  it('durak: çıkış oturumu kapatır, açık socket kesilir', async () => {
    const s = await t.approvedStand();
    const sock = await t.connectOk('/stand', s.tokens.accessToken);
    const disconnected = new Promise<string>((r) => sock.once('disconnect', (reason) => r(reason)));

    const res = await t.http().post('/auth/logout').set('Authorization', bearer(s.tokens.accessToken));
    expect(res.status).toBe(200);
    expect(await disconnected).toBe('io server disconnect');
    expect((await t.http().post('/auth/refresh').send({ refreshToken: s.tokens.refreshToken })).status).toBe(401);
    expect((await t.loginStand(s.username)).status).toBe(200);
  });

  it('bir hesabın çıkışı başka hesapların oturumunu etkilemez', async () => {
    const a = await t.approvedDriver();
    const b = await t.approvedDriver();
    await t.http().post('/auth/logout').set('Authorization', bearer(a.tokens.accessToken));

    expect((await t.http().get('/me').set('Authorization', bearer(b.tokens.accessToken))).status).toBe(200);
    expect((await t.http().post('/auth/refresh').send({ refreshToken: b.tokens.refreshToken })).status).toBe(200);
  });

  it('token olmadan veya geçersiz token ile 401; refresh token access yerine kullanılamaz', async () => {
    const d = await t.approvedDriver();
    expect((await t.http().post('/auth/logout')).status).toBe(401);
    expect((await t.http().post('/auth/logout').set('Authorization', bearer('sahte'))).status).toBe(401);
    expect((await t.http().post('/auth/logout').set('Authorization', bearer(d.tokens.refreshToken))).status).toBe(401);
    // Reddedilen denemeler oturumu kapatmamış olmalı.
    expect((await t.http().get('/me').set('Authorization', bearer(d.tokens.accessToken))).status).toBe(200);
  });

  it('aynı token ile ikinci çıkış 401 döner (zaten geçersiz)', async () => {
    const d = await t.approvedDriver();
    expect((await t.http().post('/auth/logout').set('Authorization', bearer(d.tokens.accessToken))).status).toBe(200);
    expect((await t.http().post('/auth/logout').set('Authorization', bearer(d.tokens.accessToken))).status).toBe(401);
  });

  it('yönetici çıkışı desteklenmez (400): oturum ADMIN_TOKEN_VERSION ile iptal edilir', async () => {
    const res = await t.http().post('/auth/logout').set('Authorization', bearer(await t.adminToken()));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    // Yönetici oturumu etkilenmemiş olmalı.
    expect((await t.http().get('/admin/drivers').set('Authorization', bearer(await t.adminToken()))).status).toBe(200);
  });
});
