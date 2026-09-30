// Heartbeat sweeper (CLAUDE.md Bölüm 5, Senaryo 3) — gerçek Redis (testcontainers).
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, inject } from 'vitest';
import { DRIVER_HASH, PRESENCE, redisKeys } from '@duraknet/shared';
import { sweepStaleDrivers } from '../src/sweeper';

let redis: Redis;
/** Refresher gibi eşzamanlı istemciler ayrı bağlantı kullanır (gerçek API node'u gibi). */
let other: Redis;
const touched = new Set<string>();

beforeAll(() => {
  redis = new Redis(inject('redisUrl'), { maxRetriesPerRequest: 1 });
  other = new Redis(inject('redisUrl'), { maxRetriesPerRequest: 1 });
});
afterEach(async () => {
  const ids = [...touched];
  touched.clear();
  if (!ids.length) return;
  const m = redis.multi();
  m.zrem(redisKeys.geoAvailable, ...ids);
  m.zrem(redisKeys.heartbeat, ...ids);
  for (const id of ids) m.del(redisKeys.driver(id), redisKeys.driverPresenceVersion(id));
  await m.exec();
});
afterAll(async () => {
  await Promise.allSettled([redis?.quit(), other?.quit()]);
});

const LNG = 28.9784;
const LAT = 41.0082;

type Seed = { status: 'available' | 'busy' | 'offline'; lastSeen: number };

/** Presence servisinin yazacağı durumu doğrudan kurar (Senaryo 1–2). busy şoför GEO'ya yazılmaz. */
async function seed(s: Seed, client: Redis = redis) {
  const id = randomUUID();
  touched.add(id);
  const m = client.multi();
  if (s.status === 'available') m.geoadd(redisKeys.geoAvailable, LNG, LAT, id);
  m.hset(redisKeys.driver(id), { status: s.status, lat: String(LAT), lng: String(LNG), updatedAt: String(s.lastSeen) });
  m.zadd(redisKeys.heartbeat, s.lastSeen, id);
  await m.exec();
  return id;
}

async function stateOf(id: string) {
  const [[, pos], [, status], [, score]] = (await redis
    .multi()
    .geopos(redisKeys.geoAvailable, id)
    .hget(redisKeys.driver(id), 'status')
    .zscore(redisKeys.heartbeat, id)
    .exec()) as [[null, ([string, string] | null)[]], [null, string | null], [null, string | null]];
  return { inGeo: pos[0] != null, status, score: score === null ? null : Number(score) };
}

/**
 * Gerçek konum güncellemesinin (updateLocation, available şoför) heartbeat kısmını taklit eder:
 * şoför hâlâ available ise skor + GEO + updatedAt tek atomik adımda yenilenir. 1 = uygulandı.
 */
const REFRESH_LUA = `
if redis.call('HGET', KEYS[1], 'status') ~= 'available' then return 0 end
redis.call('GEOADD', KEYS[2], ARGV[2], ARGV[3], ARGV[4])
redis.call('HSET', KEYS[1], 'updatedAt', ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[1], ARGV[4])
return 1`;
async function refresh(id: string, now: number, client: Redis = other): Promise<boolean> {
  const r = await client.eval(REFRESH_LUA, 3, redisKeys.driver(id), redisKeys.geoAvailable, redisKeys.heartbeat, String(now), String(LNG), String(LAT), id);
  return r === 1;
}

const STALE = PRESENCE.HEARTBEAT_STALE_MS;

describe('sweepStaleDrivers', () => {
  it('8. eşikten eski available şoför GEO/heartbeat\'ten çıkar ve offline olur; taze ve busy şoföre dokunulmaz', async () => {
    const now = Date.now();
    const stale = await seed({ status: 'available', lastSeen: now - STALE - 1_000 });
    const fresh = await seed({ status: 'available', lastSeen: now - STALE + 1_000 });
    const busyStale = await seed({ status: 'busy', lastSeen: now - STALE - 60_000 });

    const swept = await sweepStaleDrivers(redis, { staleMs: STALE, now });

    expect(swept).toContain(stale);
    expect(swept).not.toContain(fresh);
    expect(swept).not.toContain(busyStale);

    expect(await stateOf(stale)).toEqual({ inGeo: false, status: 'offline', score: null });
    expect(await stateOf(fresh)).toEqual({ inGeo: true, status: 'available', score: now - STALE + 1_000 });
    // busy: aktif işi olan şoför düşürülmez; heartbeat kaydı da korunur (iş bitince yeniden değerlendirilir).
    expect(await stateOf(busyStale)).toEqual({ inGeo: false, status: 'busy', score: now - STALE - 60_000 });
  });

  it('8b. eşik sınırı: tam now-staleMs skorlu şoför düşürülmez (ZRANGEBYSCORE -inf (now-staleMs, dışlayıcı)', async () => {
    const now = Date.now();
    const edge = await seed({ status: 'available', lastSeen: now - STALE });
    const swept = await sweepStaleDrivers(redis, { staleMs: STALE, now });
    expect(swept).not.toContain(edge);
    expect((await stateOf(edge)).status).toBe('available');
  });

  it('8c. hash\'i olmayan (TTL ile düşmüş) stale heartbeat kaydı temizlenir, şoför GEO\'dan çıkar', async () => {
    const now = Date.now();
    const id = randomUUID();
    touched.add(id);
    await redis.multi().geoadd(redisKeys.geoAvailable, LNG, LAT, id).zadd(redisKeys.heartbeat, now - STALE - 5_000, id).exec();
    await sweepStaleDrivers(redis, { staleMs: STALE, now });
    const s = await stateOf(id);
    expect(s.inGeo).toBe(false);
    expect(s.score).toBeNull();
  });

  it('8d. tekrar çalıştırmak idempotenttir: ikinci tarama aynı şoförü tekrar döndürmez', async () => {
    const now = Date.now();
    const stale = await seed({ status: 'available', lastSeen: now - STALE - 1_000 });
    expect(await sweepStaleDrivers(redis, { staleMs: STALE, now })).toContain(stale);
    expect(await sweepStaleDrivers(redis, { staleMs: STALE, now })).not.toContain(stale);
    expect((await stateOf(stale)).status).toBe('offline');
  });

  it('9a. yarış (deterministik): stale listesi okunduktan sonra ama ZREM\'den önce skoru yenilenen şoför düşürülmez', async () => {
    const now = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(await seed({ status: 'available', lastSeen: now - STALE - 10_000 }));
    const ours = new Set(ids);

    // Enstrümantasyon (mock değil; komutlar gerçek Redis'e gider): sweeper'ın bizim şoförlerimizi içeren
    // ilk dizi sonucunu aldığı an (stale listesinin okunması) şoförlerin yarısının skorunu yeniliyoruz.
    // Sweeper tamamen tek bir Lua script'iyse bu an taramanın sonudur; yenileme uygulanmaz ve test yine geçer.
    const refreshed = new Set<string>();
    let hooked = false;
    const instrumented = new Proxy(redis, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          const out = (v as (...a: unknown[]) => unknown).apply(target, args);
          if (!(out instanceof Promise)) return out;
          return out.then(async (res: unknown) => {
            if (!hooked && Array.isArray(res) && res.some((x) => typeof x === 'string' && ours.has(x))) {
              hooked = true;
              const refreshAt = Date.now();
              for (const [i, id] of ids.entries()) {
                if (i % 2 === 0 && (await refresh(id, refreshAt))) refreshed.add(id);
              }
            }
            return res;
          });
        };
      },
    });

    const swept = await sweepStaleDrivers(instrumented, { staleMs: STALE, now: Date.now() });
    expect(hooked, 'sweeper hiçbir komutta stale listesini döndürmedi').toBe(true);

    for (const id of ids) {
      const s = await stateOf(id);
      if (refreshed.has(id)) {
        expect(swept, `yenilenen ${id} düşürülmemeliydi`).not.toContain(id);
        expect(s.status).toBe('available');
        expect(s.inGeo).toBe(true);
        expect(s.score).not.toBeNull();
        expect(s.score!).toBeGreaterThan(now - STALE);
      } else {
        expect(swept).toContain(id);
        expect(s).toEqual({ inGeo: false, status: 'offline', score: null });
      }
    }
  });

  it('9b. yarış (eşzamanlı yük): 500 stale şoför, tarama ile paralel skor yenileme; yenilenen hiçbir şoför offline değil', async () => {
    const N = 500;
    const oldScore = Date.now() - STALE - 10_000;
    const ids: string[] = [];
    // Toplu kurulum (tek pipeline).
    const m = redis.multi();
    for (let i = 0; i < N; i++) {
      const id = randomUUID();
      ids.push(id);
      touched.add(id);
      m.geoadd(redisKeys.geoAvailable, LNG, LAT, id);
      m.hset(redisKeys.driver(id), { status: 'available', updatedAt: String(oldScore) });
      m.zadd(redisKeys.heartbeat, oldScore, id);
    }
    await m.exec();

    // Ters sırada yenile: sweeper'ın iş sırasıyla (skor/ekleme sırası) çakışma olasılığı artar.
    const order = [...ids].reverse();
    const refreshed = new Map<string, number>();
    const refresher = (async () => {
      for (const id of order) {
        const at = Date.now();
        if (await refresh(id, at)) refreshed.set(id, at);
      }
    })();
    const swept = await sweepStaleDrivers(redis, { staleMs: STALE, now: Date.now() });
    await refresher;

    const sweptSet = new Set(swept);
    const violations: string[] = [];
    for (const id of ids) {
      const s = await stateOf(id);
      // Tutarlılık: available ⇔ GEO'da.
      if ((s.status === 'available') !== s.inGeo) violations.push(`${id}: status=${s.status} inGeo=${s.inGeo}`);
      if (refreshed.has(id)) {
        // Yenileme uygulandıysa (şoför o an available'dı) sonraki tarama kontrolü taze skoru görmeliydi.
        if (s.status !== 'available' || s.score === null || sweptSet.has(id)) {
          violations.push(`${id}: yenilendi ama düşürüldü (status=${s.status}, score=${s.score})`);
        }
      } else if (s.status !== 'offline' || !sweptSet.has(id)) {
        violations.push(`${id}: yenilenmedi ama düşürülmedi (status=${s.status})`);
      }
    }
    expect(violations).toEqual([]);
    // Hem yenilenen hem düşürülen şoför olmalı; yoksa yarış hiç yaşanmamıştır (bilgi amaçlı, zorunlu değil).
    console.info(`9b: yenilenen=${refreshed.size} düşürülen=${sweptSet.size} / ${N}`);
  });

  it('10a. kabul kriteri (üretim eşikleriyle, simüle saat): son konumdan ≤ STALE+SWEEP (≤ 70 sn) içinde GEO\'dan çıkar', async () => {
    // Sweeper'ın her SWEEP_EVERY_MS'de çalıştığını `now` ile simüle ediyoruz; son konumun tarama fazına göre
    // en kötü durumları (faz 0, 1 ms, yarım aralık, aralık-1 ms) dener. Değerler sabitten okunur.
    expect(STALE + PRESENCE.SWEEP_EVERY_MS).toBeLessThanOrEqual(70_000);
    const base = Date.now();
    for (const phase of [0, 1, PRESENCE.SWEEP_EVERY_MS / 2, PRESENCE.SWEEP_EVERY_MS - 1]) {
      const lastSeen = base;
      const id = await seed({ status: 'available', lastSeen });
      let removedAt: number | null = null;
      for (let k = 0; k <= 10 && removedAt === null; k++) {
        const now = lastSeen + phase + k * PRESENCE.SWEEP_EVERY_MS;
        const swept = await sweepStaleDrivers(redis, { staleMs: STALE, now });
        if (swept.includes(id)) removedAt = now;
        else expect((await stateOf(id)).inGeo).toBe(true);
      }
      expect(removedAt, `faz ${phase}: hiç düşürülmedi`).not.toBeNull();
      const elapsed = removedAt! - lastSeen;
      expect(elapsed).toBeGreaterThan(STALE);
      expect(elapsed).toBeLessThanOrEqual(STALE + PRESENCE.SWEEP_EVERY_MS);
      // Faz 2 kabul kriteri (CLAUDE.md: ≤ 75 sn); denetim sonrası sözleşme: STALE 60 sn + SWEEP 10 sn = 70 sn.
      expect(elapsed).toBeLessThanOrEqual(70_000);
      expect((await stateOf(id)).inGeo).toBe(false);
    }
  });

  it('10b. kabul kriteri (gerçek zaman, kısaltılmış eşik: stale=600 ms, tarama 150 ms): ≤ stale+aralık içinde çıkar; konum gönderen şoför kalır', async () => {
    const staleMs = 600;
    const everyMs = 150;
    const lastSeen = Date.now();
    const quiet = await seed({ status: 'available', lastSeen });
    const alive = await seed({ status: 'available', lastSeen });

    let running = true;
    let removedAt: number | null = null;
    let aliveDropped = false;
    const sweeper = (async () => {
      while (running) {
        const started = Date.now();
        const swept = await sweepStaleDrivers(redis, { staleMs });
        if (swept.includes(alive)) aliveDropped = true;
        if (removedAt === null && swept.includes(quiet)) removedAt = Date.now();
        await new Promise((r) => setTimeout(r, Math.max(0, everyMs - (Date.now() - started))));
      }
    })();
    const heartbeat = (async () => {
      while (running) {
        await refresh(alive, Date.now());
        await new Promise((r) => setTimeout(r, 200));
      }
    })();

    const deadline = Date.now() + 5_000;
    while (removedAt === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    running = false;
    await Promise.all([sweeper, heartbeat]);

    expect(removedAt, 'sessiz şoför hiç düşürülmedi').not.toBeNull();
    const elapsed = removedAt! - lastSeen;
    expect(elapsed).toBeGreaterThanOrEqual(staleMs);
    // Tarama gecikmesi, Redis gidiş-dönüşü ve yüklü CI'da zamanlayıcı kayması için 500 ms pay.
    expect(elapsed).toBeLessThanOrEqual(staleMs + everyMs + 500);
    expect((await stateOf(quiet)).inGeo).toBe(false);
    expect(aliveDropped).toBe(false);
    expect(await stateOf(alive)).toMatchObject({ inGeo: true, status: 'available' });
  });
});

describe('sweepStaleDrivers — offlineReason ve presenceVersion', () => {
  const versionOf = async (id: string) => {
    const v = await redis.get(redisKeys.driverPresenceVersion(id));
    return v === null ? null : Number(v);
  };

  it('11a. düşürülen şoföre offlineReason=stale_heartbeat yazılır ve presenceVersion eskisinden (ve Redis saatinden) büyük olur', async () => {
    const now = Date.now();
    const id = await seed({ status: 'available', lastSeen: now - STALE - 1_000 });
    const old = now - 5_000;
    await redis.set(redisKeys.driverPresenceVersion(id), String(old));
    const [sec, usec] = await redis.time();
    const redisNow = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);

    expect(await sweepStaleDrivers(redis, { staleMs: STALE, now })).toContain(id);
    const h = await redis.hgetall(redisKeys.driver(id));
    expect(h[DRIVER_HASH.status]).toBe('offline');
    expect(h[DRIVER_HASH.offlineReason]).toBe('stale_heartbeat');
    expect(h).not.toHaveProperty('presenceVersion'); // sürüm hash'te değil, ayrı anahtarda
    const v = (await versionOf(id))!;
    expect(v).toBeGreaterThan(old);
    expect(v).toBeGreaterThanOrEqual(redisNow);
  });

  it('11b. sürüm saatin ilerisindeyse de eski+1\'den küçük olmaz (geri gitmez)', async () => {
    const now = Date.now();
    const id = await seed({ status: 'available', lastSeen: now - STALE - 1_000 });
    const future = now + 3_600_000;
    await redis.set(redisKeys.driverPresenceVersion(id), String(future));
    await sweepStaleDrivers(redis, { staleMs: STALE, now });
    expect(await versionOf(id)).toBe(future + 1);
  });

  it('11c. busy ve taze şoförün sürümü/sebebi değişmez; ikinci tarama düşürülmüş şoförün sürümünü tekrar artırmaz', async () => {
    const now = Date.now();
    const busy = await seed({ status: 'busy', lastSeen: now - STALE - 60_000 });
    const fresh = await seed({ status: 'available', lastSeen: now - STALE + 1_000 });
    const stale = await seed({ status: 'available', lastSeen: now - STALE - 1_000 });
    for (const id of [busy, fresh, stale]) await redis.set(redisKeys.driverPresenceVersion(id), '1000');

    await sweepStaleDrivers(redis, { staleMs: STALE, now });
    expect(await versionOf(busy)).toBe(1000);
    expect(await versionOf(fresh)).toBe(1000);
    expect(await redis.hget(redisKeys.driver(busy), DRIVER_HASH.offlineReason)).toBeNull();
    expect(await redis.hget(redisKeys.driver(fresh), DRIVER_HASH.offlineReason)).toBeNull();

    const afterFirst = await versionOf(stale);
    expect(afterFirst).toBeGreaterThan(1000);
    await sweepStaleDrivers(redis, { staleMs: STALE, now });
    expect(await versionOf(stale)).toBe(afterFirst);
  });

  it('11d. hash\'i olmayan stale kayıt için yeni hash yaratılmaz', async () => {
    const now = Date.now();
    const id = randomUUID();
    touched.add(id);
    await redis.multi().geoadd(redisKeys.geoAvailable, LNG, LAT, id).zadd(redisKeys.heartbeat, now - STALE - 5_000, id).exec();
    expect(await sweepStaleDrivers(redis, { staleMs: STALE, now })).toContain(id);
    expect(await redis.exists(redisKeys.driver(id))).toBe(0);
  });
});
