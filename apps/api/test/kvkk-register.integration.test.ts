// Faz 6: kayıtta KVKK aydınlatma onayı zorunlu (kvkkAccepted: true); sürüm ve zaman hesaba yazılır.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { KVKK_NOTICE_VERSION } from '@duraknet/shared';
import { PASSWORD, startTestApp, uniquePhone, uniquePlate, uniqueUsername, type TestApp } from './helpers/app';

let t: TestApp;
const driverIds: string[] = [];
const standIds: string[] = [];
beforeAll(async () => {
  t = await startTestApp();
});
afterEach(async () => {
  if (driverIds.length) await t.db.deleteFrom('drivers').where('id', 'in', driverIds).execute();
  if (standIds.length) await t.db.deleteFrom('stands').where('id', 'in', standIds).execute();
  driverIds.length = 0;
  standIds.length = 0;
});
afterAll(async () => {
  await t?.close();
});

const driverBody = (extra: Record<string, unknown> = {}) => ({
  fullName: 'KVKK Şoför', phone: uniquePhone().local, password: PASSWORD, plate: uniquePlate(), licenseNo: 'RUHSAT-K', ...extra,
});
const standBody = (extra: Record<string, unknown> = {}) => ({
  name: 'KVKK Durağı', phone: uniquePhone().local, location: { lat: 41, lng: 29 }, username: uniqueUsername(), password: PASSWORD, ...extra,
});

type Kvkk = { kvkk_accepted_at: Date | null; kvkk_version: string | null };
async function kvkkOf(table: 'drivers' | 'stands', id: string) {
  const res = await sql<Kvkk>`SELECT kvkk_accepted_at, kvkk_version FROM ${sql.table(table)} WHERE id = ${id}`.execute(t.db);
  return res.rows[0];
}

describe('KVKK onayı: şoför kaydı', () => {
  it.each([
    ['alan yok', {}],
    ['false', { kvkkAccepted: false }],
    ['"true" metni', { kvkkAccepted: 'true' }],
    ['1', { kvkkAccepted: 1 }],
    ['null', { kvkkAccepted: null }],
  ])('onaysız kayıt 400 VALIDATION_ERROR (%s) ve hesap oluşmaz', async (_n, extra) => {
    const body = driverBody(extra);
    const res = await t.http().post('/auth/driver/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    const found = await t.db.selectFrom('drivers').select('id').where('plate', '=', body.plate).executeTakeFirst();
    expect(found).toBeUndefined();
  });

  it('onaylı kayıt 201; kvkk_accepted_at (şimdi) ve kvkk_version yazılır', async () => {
    const before = Date.now();
    const res = await t.http().post('/auth/driver/register').send(driverBody({ kvkkAccepted: true }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.data.id as string;
    driverIds.push(id);
    const k = await kvkkOf('drivers', id);
    expect(k!.kvkk_version).toBe(KVKK_NOTICE_VERSION);
    expect(k!.kvkk_accepted_at).not.toBeNull();
    const at = new Date(k!.kvkk_accepted_at!).getTime();
    expect(at).toBeGreaterThan(before - 5000);
    expect(at).toBeLessThan(Date.now() + 5000);
  });

  it('istemci kendi sürüm/zaman değerini dayatamaz', async () => {
    const res = await t.http().post('/auth/driver/register')
      .send(driverBody({ kvkkAccepted: true, kvkkVersion: 'sahte', kvkkAcceptedAt: '2000-01-01T00:00:00Z' }));
    // Fazladan alan ya reddedilir (400) ya yok sayılır (201); hiçbir durumda sahte değer yazılmaz.
    expect([201, 400]).toContain(res.status);
    if (res.status === 201) {
      driverIds.push(res.body.data.id);
      const k = await kvkkOf('drivers', res.body.data.id);
      expect(k!.kvkk_version).toBe(KVKK_NOTICE_VERSION);
      expect(new Date(k!.kvkk_accepted_at!).getFullYear()).toBeGreaterThan(2020);
    }
  });
});

describe('KVKK onayı: durak kaydı', () => {
  it.each([
    ['alan yok', {}],
    ['false', { kvkkAccepted: false }],
    ['"true" metni', { kvkkAccepted: 'true' }],
  ])('onaysız kayıt 400 VALIDATION_ERROR (%s) ve hesap oluşmaz', async (_n, extra) => {
    const body = standBody(extra);
    const res = await t.http().post('/auth/stand/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    const found = await t.db.selectFrom('stands').select('id').where('username', '=', body.username).executeTakeFirst();
    expect(found).toBeUndefined();
  });

  it('onaylı kayıt 201; kvkk_accepted_at ve kvkk_version yazılır', async () => {
    const before = Date.now();
    const res = await t.http().post('/auth/stand/register').send(standBody({ kvkkAccepted: true }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.data.id as string;
    standIds.push(id);
    const k = await kvkkOf('stands', id);
    expect(k!.kvkk_version).toBe(KVKK_NOTICE_VERSION);
    expect(new Date(k!.kvkk_accepted_at!).getTime()).toBeGreaterThan(before - 5000);
  });
});
