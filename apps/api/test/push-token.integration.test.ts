// Faz 5 (docs/design/faz5-resilience.md Bölüm 1): PUT/DELETE /me/push-token yaşam döngüsü.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './helpers/app';
import { withLimits, perMin } from './helpers/limits';
import { uniquePushToken } from './helpers/push';

const bearer = (t: string) => `Bearer ${t}`;

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({ ...withLimits({ pushTokenPut: perMin(6) }) });
});
afterEach(() => t.cleanup());
afterAll(() => t.close());

const tokenOf = async (driverId: string) =>
  (await t.db.selectFrom('drivers').select('push_token').where('id', '=', driverId).executeTakeFirstOrThrow()).push_token;
const put = (access: string, body: unknown) =>
  t.http().put('/me/push-token').set('Authorization', bearer(access)).send(body as object);
const del = (access: string) => t.http().delete('/me/push-token').set('Authorization', bearer(access));

describe('PUT/DELETE /me/push-token', () => {
  it('şoför token kaydeder (PG\'de görünür), ikinci PUT değiştirir, DELETE siler', async () => {
    const d = await t.approvedDriver();
    expect(await tokenOf(d.id)).toBeNull();

    const a = uniquePushToken();
    const r1 = await put(d.tokens.accessToken, { token: a });
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    expect(await tokenOf(d.id)).toBe(a);

    const b = uniquePushToken();
    expect((await put(d.tokens.accessToken, { token: b })).status).toBe(200);
    expect(await tokenOf(d.id)).toBe(b); // şoför başına tek token

    // Aynı token tekrar gönderilebilir (idempotent).
    expect((await put(d.tokens.accessToken, { token: b })).status).toBe(200);
    expect(await tokenOf(d.id)).toBe(b);

    const r2 = await del(d.tokens.accessToken);
    expect(r2.status).toBe(200);
    expect(await tokenOf(d.id)).toBeNull();
    // Token yokken DELETE de hata vermez.
    expect((await del(d.tokens.accessToken)).status).toBe(200);
  });

  it('aynı token başka şoförde kayıtlıysa devralınır: eski şoförün token\'ı NULL olur', async () => {
    const oldOwner = await t.approvedDriver();
    const newOwner = await t.approvedDriver();
    const tok = uniquePushToken();
    expect((await put(oldOwner.tokens.accessToken, { token: tok })).status).toBe(200);
    expect(await tokenOf(oldOwner.id)).toBe(tok);

    const res = await put(newOwner.tokens.accessToken, { token: tok });
    expect(res.status).toBe(200);
    expect(await tokenOf(newOwner.id)).toBe(tok);
    expect(await tokenOf(oldOwner.id)).toBeNull();

    // Tek satırda kayıtlı (kısmi UNIQUE indeks ihlali yok).
    const rows = await t.db.selectFrom('drivers').select('id').where('push_token', '=', tok).execute();
    expect(rows.map((r) => r.id)).toEqual([newOwner.id]);
  });

  it('eşzamanlı iki şoför aynı token\'ı kaydederse tam biri sahip kalır, 500 dönmez', async () => {
    const a = await t.approvedDriver();
    const b = await t.approvedDriver();
    const tok = uniquePushToken();
    const [ra, rb] = await Promise.all([put(a.tokens.accessToken, { token: tok }), put(b.tokens.accessToken, { token: tok })]);
    expect(ra.status).not.toBe(500);
    expect(rb.status).not.toBe(500);
    const owners = await t.db.selectFrom('drivers').select('id').where('push_token', '=', tok).execute();
    expect(owners).toHaveLength(1);
  });

  it('yalnızca driver: durak, admin ve kimliksiz istek reddedilir', async () => {
    const stand = await t.approvedStand();
    const tok = uniquePushToken();
    const asStand = await put(stand.tokens.accessToken, { token: tok });
    expect(asStand.status).toBe(403);
    expect(asStand.body.error.code).toBe('FORBIDDEN');
    expect((await del(stand.tokens.accessToken)).status).toBe(403);

    const admin = await t.adminToken();
    expect((await put(admin, { token: tok })).status).toBe(403);

    const anon = await t.http().put('/me/push-token').send({ token: tok });
    expect(anon.status).toBe(401);
    expect((await t.http().delete('/me/push-token')).status).toBe(401);
  });

  it('biçim doğrulaması: Expo biçimi dışı, boş ve eksik gövde VALIDATION_ERROR', async () => {
    const d = await t.approvedDriver();
    for (const body of [{ token: 'fcm:abc' }, { token: 'ExponentPushToken[]' }, { token: 123 }, {}, { token: 'ExponentPushToken[a b]' }]) {
      const res = await put(d.tokens.accessToken, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await tokenOf(d.id)).toBeNull();
  });

  it('logout token\'ı temizler', async () => {
    const d = await t.approvedDriver();
    await put(d.tokens.accessToken, { token: uniquePushToken() });
    expect((await t.http().post('/auth/logout').set('Authorization', bearer(d.tokens.accessToken))).status).toBe(200);
    expect(await tokenOf(d.id)).toBeNull();
  });

  it('askıya alma token\'ı temizler', async () => {
    const d = await t.approvedDriver();
    await put(d.tokens.accessToken, { token: uniquePushToken() });
    await t.adminAction('drivers', d.id, 'suspend');
    expect(await tokenOf(d.id)).toBeNull();
  });

  it('hesap başına PUT sınırı: sınır aşılınca 429 RATE_LIMITED; başka şoför etkilenmez', async () => {
    const d = await t.approvedDriver();
    for (let i = 0; i < 6; i++) {
      expect((await put(d.tokens.accessToken, { token: uniquePushToken() })).status, `PUT ${i + 1}`).toBe(200);
    }
    const blocked = await put(d.tokens.accessToken, { token: uniquePushToken() });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });

    const other = await t.approvedDriver();
    expect((await put(other.tokens.accessToken, { token: uniquePushToken() })).status).toBe(200);
  });
});
