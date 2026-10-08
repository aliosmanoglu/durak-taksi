// Faz 5: askıya alma push kuyruğunu BEKLEMEZ. Kuyruk/Redis bağlantısı takılsa bile hesap askıya alınır,
// soket kesilir ve şoför forceOffline olur (bildirim yan etkidir).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { uniquePushToken } from './helpers/push';
import { north, Scope, uniqueCity, waitFor } from './helpers/rides';

let t: RideApp;
let s: Scope;
let calls = 0;
beforeAll(async () => {
  t = await startRideApp({
    appExtras: {
      // Hiç çözülmeyen (askıda) bildirici: kuyruğa yazma takılmış gibi.
      pushNotifier: {
        accountSuspended: () => {
          calls++;
          return new Promise<void>(() => undefined);
        },
        close: async () => undefined,
      },
    },
  });
});
afterEach(() => s?.cleanup());
afterAll(() => t.close());

describe('askıya alma + takılan push kuyruğu', () => {
  it('istek hızlı döner, soket kesilir, şoför GEO\'dan çıkıp offline olur, hesap askıda kalır', async () => {
    s = new Scope(t);
    const d = await s.driver(north(uniqueCity(), 100));
    await t.db.updateTable('drivers').set({ push_token: uniquePushToken() }).where('id', '=', d.id).execute();
    const dropped = new Promise<string>((r) => d.socket.once('disconnect', (reason) => r(reason)));
    expect(await s.inGeo(d.id)).toBe(true);

    const t0 = Date.now();
    await t.adminAction('drivers', d.id, 'suspend');
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(calls).toBe(1);

    expect(await dropped).toBe('io server disconnect');
    await waitFor(() => s.driverHash(d.id), (h) => h.status === 'offline', 5000);
    expect(await s.inGeo(d.id)).toBe(false);
    const row = await t.db.selectFrom('drivers').select(['status', 'push_token']).where('id', '=', d.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('suspended');
    expect(row.push_token).toBeNull();
  }, 30_000);
});
