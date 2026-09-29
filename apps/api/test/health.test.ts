import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';

describe('GET /health', () => {
  it('bağımlılıklara bakmadan 200 döner', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('tüm kontroller geçerse 200 döner', async () => {
    const app = createApp({ readinessChecks: [{ name: 'postgres', check: async () => {} }] });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { postgres: 'ok' } });
  });

  it('bir kontrol başarısızsa 503 döner ve hatayı sızdırmaz', async () => {
    const app = createApp({
      readinessChecks: [
        { name: 'postgres', check: async () => {} },
        { name: 'redis', check: async () => { throw new Error('gizli bağlantı dizesi'); } },
      ],
    });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { postgres: 'ok', redis: 'fail' } });
    expect(JSON.stringify(res.body)).not.toContain('gizli');
  });
});

describe('loadConfig', () => {
  it('zorunlu değişken eksikse hata verir', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  const base = {
    DATABASE_URL: 'postgres://x',
    REDIS_URL: 'redis://x',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=19456,t=2,p=1$x$y',
  };

  it('varsayılanları uygular', () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(3000);
    expect(c.ADMIN_TOKEN_VERSION).toBe(0);
  });

  it('TRUST_PROXY ve CORS_ORIGINS değerlerini çözümler', () => {
    expect(loadConfig(base).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: 'loopback, 10.0.0.0/8' }).TRUST_PROXY).toBe('loopback, 10.0.0.0/8');
    expect(loadConfig({ ...base, CORS_ORIGINS: 'https://a.com, https://b.com' }).CORS_ORIGINS).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });

  it('üretimde CORS_ORIGINS açıkça verilmeli', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/CORS_ORIGINS/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://a.com' }).CORS_ORIGINS).toEqual([
      'https://a.com',
    ]);
  });

  it('kısa veya aynı JWT secret kabul etmez', () => {
    expect(() => loadConfig({ ...base, JWT_ACCESS_SECRET: 'kisa' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadConfig({ ...base, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET })).toThrow(/farklı/);
  });
});
