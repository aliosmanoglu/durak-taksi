// Faz 6: KVKK silme talebi için admin anonimleştirme (POST /admin/{drivers|stands}/:id/anonymize).
// Kişisel alanlar boşaltılır, hesap suspended olur, oturumlar kesilir, ride kayıtları istatistik için kalır;
// UNIQUE alanlar yer tutucuyla değiştiği için aynı telefon/plaka/kullanıcı adı yeniden kullanılabilir.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, startTestApp, uniquePhone, type TestApp } from './helpers/app';
import { deleteRidesOf, seedRide } from './helpers/pg-rides';
import { waitFor } from './helpers/presence';

let t: TestApp;
const standIds: string[] = [];
beforeAll(async () => {
  t = await startTestApp();
});
afterEach(async () => {
  await deleteRidesOf(t, standIds);
  standIds.length = 0;
  await t.cleanup();
});
afterAll(async () => {
  await t?.close();
});

async function anonymize(kind: 'drivers' | 'stands', id: string, token?: string) {
  const tok = token ?? (await t.adminToken());
  return t.http().post(`/admin/${kind}/${id}/anonymize`).set('Authorization', `Bearer ${tok}`);
}
const driverRow = (id: string) => t.db.selectFrom('drivers').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const standRow = (id: string) => t.db.selectFrom('stands').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

describe('şoför anonimleştirme', () => {
  it('kişisel alanlar boşalır, hesap suspended olur, oturum ve push token gider, ride kayıtları kalır', async () => {
    const stand = await t.registerStand();
    standIds.push(stand.id);
    const d = await t.approvedDriver();
    const put = await t.http().put('/me/push-token').set('Authorization', `Bearer ${d.tokens.accessToken}`)
      .send({ token: `ExponentPushToken[anon-${randomUUID()}]` });
    expect(put.status).toBe(200);
    const ride = await seedRide(t, {
      standId: stand.id, status: 'completed', driverId: d.id,
      createdAt: new Date().toISOString(), searchingAt: new Date().toISOString(), matchedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    });
    const before = await driverRow(d.id);
    const sock = await t.connectOk('/driver', d.tokens.accessToken);

    const res = await anonymize('drivers', d.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);

    const after = await driverRow(d.id);
    expect(after.status).toBe('suspended');
    expect(after.push_token).toBeNull();
    expect(after.token_version).toBeGreaterThan(before.token_version);
    for (const [field, original] of [
      ['full_name', 'Test Şoför'], ['phone', d.phone.e164], ['plate', d.plate], ['license_no', 'RUHSAT-1'],
    ] as const) {
      expect(after[field], field).not.toBe(original);
      expect(after[field], field).toBeTruthy(); // NOT NULL: yer tutucu
    }
    expect(after.password_hash).not.toBe(before.password_hash);

    // Açık socket kesilir; eski token'larla girilemez.
    await waitFor(async () => sock.connected, (c) => !c, 5000);
    expect((await t.loginDriver(d.phone.e164)).status).toBe(401);
    const refresh = await t.http().post('/auth/refresh').send({ refreshToken: d.tokens.refreshToken });
    expect(refresh.status).toBe(401);
    expect((await t.connectError('/driver', d.tokens.accessToken)).message).toMatch(/UNAUTHORIZED|ACCOUNT_SUSPENDED/);

    // Ride kaydı istatistik için yerinde (şoför referansı korunur).
    const kept = await t.db.selectFrom('rides').select(['id', 'driver_id', 'status']).where('id', '=', ride.id).executeTakeFirstOrThrow();
    expect(kept).toMatchObject({ driver_id: d.id, status: 'completed' });

    // Yer tutucular benzersizdir ve eski telefon/plaka yeniden kaydedilebilir.
    const re = await t.http().post('/auth/driver/register').send({
      fullName: 'Yeni Şoför', phone: d.phone.e164, password: PASSWORD, plate: d.plate, licenseNo: 'RUHSAT-9', kvkkAccepted: true,
    });
    expect(re.status, JSON.stringify(re.body)).toBe(201);
    await t.db.deleteFrom('drivers').where('id', '=', re.body.data.id).execute();
  });

  it('iki şoförü anonimleştirmek UNIQUE çakışması üretmez', async () => {
    const a = await t.registerDriver();
    const b = await t.registerDriver();
    expect((await anonymize('drivers', a.id)).status).toBe(200);
    expect((await anonymize('drivers', b.id)).status).toBe(200);
    const [ra, rb] = [await driverRow(a.id), await driverRow(b.id)];
    expect(ra.phone).not.toBe(rb.phone);
    expect(ra.plate).not.toBe(rb.plate);
  });

  it('tekrar çağrı sunucu hatası vermez; var olmayan id 404; geçersiz id 400', async () => {
    const d = await t.registerDriver();
    expect((await anonymize('drivers', d.id)).status).toBe(200);
    const again = await anonymize('drivers', d.id);
    expect(again.status).toBeLessThan(500);
    const missing = await anonymize('drivers', randomUUID());
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect((await anonymize('drivers', 'degil-uuid')).status).toBe(400);
  });

  it('eşleşmiş (busy) şoförün anonimleştirilmesi 5xx üretmez ve hesabı suspended yapar', async () => {
    const stand = await t.registerStand();
    standIds.push(stand.id);
    const d = await t.registerDriver();
    await t.adminAction('drivers', d.id, 'approve');
    await seedRide(t, { standId: stand.id, status: 'matched', driverId: d.id, createdAt: new Date().toISOString(), searchingAt: new Date().toISOString(), matchedAt: new Date().toISOString() });
    const res = await anonymize('drivers', d.id);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    expect((await driverRow(d.id)).status).toBe('suspended');
  });

  it('yetki: token yok 401, durak/şoför 403 ve hesap değişmez', async () => {
    const d = await t.registerDriver();
    expect((await t.http().post(`/admin/drivers/${d.id}/anonymize`)).status).toBe(401);
    const st = await t.approvedStand();
    expect((await anonymize('drivers', d.id, st.tokens.accessToken)).status).toBe(403);
    const dr = await t.approvedDriver();
    expect((await anonymize('drivers', d.id, dr.tokens.accessToken)).status).toBe(403);
    expect((await driverRow(d.id)).phone).toBe(d.phone.e164);
  });
});

describe('durak anonimleştirme', () => {
  it('ad/telefon/adres/kullanıcı adı boşalır, hesap suspended olur, soket kesilir, ride kayıtları kalır', async () => {
    const s = await t.approvedStand();
    standIds.push(s.id);
    const ride = await seedRide(t, { standId: s.id, status: 'cancelled', createdAt: new Date().toISOString(), searchingAt: new Date().toISOString(), cancelledAt: new Date().toISOString() });
    const before = await standRow(s.id);
    const sock = await t.connectOk('/stand', s.tokens.accessToken);

    const res = await anonymize('stands', s.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await standRow(s.id);
    expect(after.status).toBe('suspended');
    expect(after.token_version).toBeGreaterThan(before.token_version);
    expect(after.name).not.toBe('Test Durağı');
    expect(after.username).not.toBe(s.username);
    expect(after.phone).not.toBe(before.phone);
    expect(after.address ?? '').toBe('');
    expect(after.password_hash).not.toBe(before.password_hash);

    await waitFor(async () => sock.connected, (c) => !c, 5000);
    expect((await t.loginStand(s.username)).status).toBe(401);
    expect((await t.http().post('/auth/refresh').send({ refreshToken: s.tokens.refreshToken })).status).toBe(401);

    const kept = await t.db.selectFrom('rides').select(['id', 'stand_id']).where('id', '=', ride.id).executeTakeFirstOrThrow();
    expect(kept.stand_id).toBe(s.id);

    // Kullanıcı adı yeniden kullanılabilir.
    const re = await t.http().post('/auth/stand/register').send({
      name: 'Yeni Durak', phone: uniquePhone().local, location: { lat: 41, lng: 29 }, username: s.username, password: PASSWORD, kvkkAccepted: true,
    });
    expect(re.status, JSON.stringify(re.body)).toBe(201);
    await t.db.deleteFrom('stands').where('id', '=', re.body.data.id).execute();
  });

  it('yetki ve 404', async () => {
    const s = await t.registerStand();
    expect((await t.http().post(`/admin/stands/${s.id}/anonymize`)).status).toBe(401);
    const st = await t.approvedStand();
    expect((await anonymize('stands', s.id, st.tokens.accessToken)).status).toBe(403);
    expect((await anonymize('stands', randomUUID())).status).toBe(404);
    expect((await standRow(s.id)).username).toBe(s.username);
  });
});

