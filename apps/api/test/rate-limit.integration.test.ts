// Redis store'lu kimlik hız sınırlayıcıları (server.ts ile aynı kurulum) gerçek Redis üzerinde.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, randomIp, startTestApp, type TestApp } from './helpers/app';

let t: TestApp;
const redisKeys: string[] = [];

beforeAll(async () => {
  t = await startTestApp();
});
afterEach(async () => {
  if (redisKeys.length) await t.redis.del(...redisKeys.splice(0));
  await t.cleanup();
});
afterAll(async () => {
  await t?.close();
});

describe('hesap bazlı giriş sınırı (Redis store)', () => {
  it('aynı telefona 10 başarısız denemeden sonra 11. deneme 429 RATE_LIMITED; farklı yazımlar aynı sayaca düşer', async () => {
    const d = await t.approvedDriver();
    const key = `dn:ratelimit:login-acct:driver:${d.phone.e164}`;
    redisKeys.push(key);

    // Her deneme farklı IP'den (dağıtık kaba kuvvet): IP limiti devreye girmez, yalnızca hesap sayacı artar.
    for (let i = 0; i < 10; i++) {
      const phone = i % 2 === 0 ? d.phone.local : d.phone.e164;
      const res = await t.http(randomIp()).post('/auth/login').send({ role: 'driver', phone, password: 'yanlis-sifre-999' });
      expect(res.status, `deneme ${i + 1}`).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }

    // Sayaç gerçekten Redis'te, normalize edilmiş anahtarla.
    expect(Number(await t.redis.get(key))).toBe(10);

    const blocked = await t.http(randomIp()).post('/auth/login').send({ role: 'driver', phone: d.phone.e164, password: 'yanlis-sifre-999' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });

    // Doğru şifre de pencere dolana kadar engellenir.
    const correct = await t.http(randomIp()).post('/auth/login').send({ role: 'driver', phone: d.phone.local, password: PASSWORD });
    expect(correct.status).toBe(429);

    // Başka hesap etkilenmez.
    const other = await t.approvedDriver();
    const ok = await t.loginDriver(other.phone.local);
    expect(ok.status).toBe(200);
  });

  it('başarılı girişler hesap sayacına yazılmaz (skipSuccessfulRequests)', async () => {
    const d = await t.approvedDriver(); // 1 başarılı giriş
    const key = `dn:ratelimit:login-acct:driver:${d.phone.e164}`;
    redisKeys.push(key);
    for (let i = 0; i < 12; i++) {
      const res = await t.loginDriver(d.phone.local);
      expect(res.status, `giriş ${i + 1}`).toBe(200);
    }
    expect(Number((await t.redis.get(key)) ?? 0)).toBe(0);
  });
});
