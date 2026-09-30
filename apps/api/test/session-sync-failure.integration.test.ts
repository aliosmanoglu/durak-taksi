// Bağlanmada `session_sync` üretilemezse (Redis hatası) socket kesilir; istemci sonsuza dek beklemez.
// Hata gerçek Redis'te tetiklenir: `dn:driver:{id}` hash yerine STRING yapılır → READ_STATE Lua'sındaki
// HMGET WRONGTYPE ile düşer. Mock yok.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { COMMON_EVENTS, redisKeys } from '@duraknet/shared';
import { startTestApp, type TestApp } from './helpers/app';
import { cleanupPresence } from './helpers/presence';

let t: TestApp;
const touched = new Set<string>();

beforeAll(async () => {
  t = await startTestApp();
});
afterEach(async () => {
  await cleanupPresence(t.redis, touched);
  touched.clear();
  await t.cleanup();
});
afterAll(async () => {
  await t?.close();
});

describe('bağlanmada session_sync hatası', () => {
  it('getState Redis hatası verirse session_sync gönderilmez ve sunucu bağlantıyı keser', async () => {
    const d = await t.approvedDriver();
    touched.add(d.id);
    await t.redis.set(redisKeys.driver(d.id), 'bozuk-veri');

    const socket = t.socket('/driver', d.tokens.accessToken);
    let synced = false;
    socket.on(COMMON_EVENTS.sessionSync, () => (synced = true));
    const reason = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bağlantı kesilmedi')), 5000);
      socket.once('connect_error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`beklenmedik connect_error: ${err.message}`));
      });
      socket.once('disconnect', (r: string) => {
        clearTimeout(timer);
        resolve(r);
      });
    });

    expect(reason).toBe('io server disconnect');
    expect(synced).toBe(false);
  });
});
