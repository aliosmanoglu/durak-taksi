// Faz 5 graceful shutdown (docs/design/faz5-resilience.md Bölüm 5): /ready 503'e döner (LB düğümü çıkarsın),
// drain süresi sonunda HTTP kabulü durur ve bağlı soketler kopar (istemciler diğer node'a geçer), tekrar giriş zararsızdır.
import { afterEach, describe, expect, it } from 'vitest';
import { DRIVER_EVENTS } from '@duraknet/shared';
import { shutdownNode, startShutdownNode, type ShutdownNode } from './helpers/shutdown';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { emitAck, Scope, sleep, uniqueCity } from './helpers/rides';

const apps: RideApp[] = [];
const scopes: Scope[] = [];
afterEach(async () => {
  for (const sc of scopes.splice(0)) await sc.cleanup().catch(() => undefined);
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
});

async function twoNodes() {
  const a = (await startShutdownNode()) satisfies ShutdownNode;
  const b = await startRideApp({ workers: false });
  apps.push(a, b);
  return { a, b };
}

describe('graceful shutdown', () => {
  it('kapanış başlayınca /ready hemen 503 olur, /health 200 kalır; drain süresince bağlantılar sürer', async () => {
    const { a } = await twoNodes();
    expect((await a.http().get('/ready')).status).toBe(200);
    const sc = new Scope(a);
    scopes.push(sc);
    const d = await sc.driver(uniqueCity());

    const done = shutdownNode(a, { drainMs: 1200, timeoutMs: 10_000 });
    await sleep(150);
    const ready = await a.http().get('/ready');
    expect(ready.status).toBe(503);
    expect((await a.http().get('/health')).status).toBe(200);
    // Drain sırasında soket hâlâ bağlı ve çalışır (LB trafiği çekmeden kesmeyiz).
    expect(d.socket.connected).toBe(true);
    expect((await emitAck(d.socket, DRIVER_EVENTS.sessionSyncRequest, {})).ok).toBe(true);

    expect(await done).toBe(0);
  }, 30_000);

  it('drain bitince soketler kopar ve HTTP sunucusu bağlantı kabul etmez; shutdown tekrar çağrılabilir', async () => {
    const { a } = await twoNodes();
    const sc = new Scope(a);
    scopes.push(sc);
    const d = await sc.driver(uniqueCity());
    const gone = new Promise<string>((r) => d.socket.once('disconnect', (reason) => r(reason)));

    const first = shutdownNode(a, { drainMs: 300, timeoutMs: 10_000 });
    const second = shutdownNode(a, { drainMs: 300, timeoutMs: 10_000 }); // tekrar giriş: hata/çift kapanış yok
    expect(await Promise.all([first, second])).toEqual([0, 0]);

    expect(['io server disconnect', 'transport close']).toContain(await gone);
    expect(d.socket.connected).toBe(false);
    await expect(fetch(`${a.url}/health`)).rejects.toThrow();
  }, 30_000);

  it('kapanan node\'daki istemci diğer node\'a bağlanınca session_sync ile devam eder; presence korunur', async () => {
    const { a, b } = await twoNodes();
    const sa = new Scope(a);
    const sb = new Scope(b);
    scopes.push(sa, sb);
    const city = uniqueCity();
    const d = await sa.driver(city);
    const gone = new Promise<void>((r) => d.socket.once('disconnect', () => r()));

    await shutdownNode(a, { drainMs: 200, timeoutMs: 10_000 });
    await gone;
    // Socket kopması presence'a dokunmaz: şoför hâlâ GEO'da (sweeper eşiği dolana kadar).
    expect(await sa.inGeo(d.id)).toBe(true);

    const again = await sb.openDriver(d.tokens.accessToken);
    expect(again.sync.driverStatus).toBe('available');
    expect(again.sync.activeRide).toBeUndefined();
  }, 30_000);

  it('açık soket varken de kapanış zaman aşımına düşmeden temiz tamamlanır (io.close soketleri keser)', async () => {
    const { a } = await twoNodes();
    const sc = new Scope(a);
    scopes.push(sc);
    await sc.driver(uniqueCity());
    const t0 = Date.now();
    expect(await shutdownNode(a, { drainMs: 100, timeoutMs: 3000 })).toBe(0);
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 30_000);
});
