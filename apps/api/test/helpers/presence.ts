// Faz 2 (şoför varlığı) entegrasyon testleri için yardımcılar. Gerçek Redis'e bakar; mock yok.
// Redis paralel test dosyalarıyla paylaşıldığı için yalnızca verilen driverId'lere dokunulur.
import { createAdapter, type RedisAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io-client';
import { COMMON_EVENTS, NAMESPACES, redisKeys, rooms, type LatLng } from '@duraknet/shared';
import type { PresenceService } from '../../src/presence/service';
import type { TestApp } from './app';

// ---- Bilinen noktalar (İstanbul) ----
export const SULTANAHMET: LatLng = { lat: 41.0054, lng: 28.9768 };
export const TAKSIM: LatLng = { lat: 41.0369, lng: 28.985 };

/** Haversine (m) — Redis'in kullandığı yer yarıçapıyla (6372797.560856 m). */
export function distanceM(a: LatLng, b: LatLng) {
  const R = 6372797.560856;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---- Redis gözlemleri ----

/** GEOSEARCH FROMLONLAT (lng, lat) ile yarıçap araması; `id -> mesafe (m)`. */
export async function geoSearch(redis: Redis, from: LatLng, radiusM: number): Promise<Map<string, number>> {
  const res = (await redis.call(
    'GEOSEARCH', redisKeys.geoAvailable,
    'FROMLONLAT', String(from.lng), String(from.lat),
    'BYRADIUS', String(radiusM), 'm',
    'ASC', 'WITHDIST',
  )) as [string, string][];
  return new Map(res.map(([id, d]) => [id, Number(d)]));
}

export async function geoPos(redis: Redis, driverId: string): Promise<LatLng | null> {
  const [pos] = await redis.geopos(redisKeys.geoAvailable, driverId);
  if (!pos) return null;
  return { lng: Number(pos[0]), lat: Number(pos[1]) };
}

export const inGeo = async (redis: Redis, driverId: string) => (await geoPos(redis, driverId)) !== null;

export async function heartbeatScore(redis: Redis, driverId: string): Promise<number | null> {
  const s = await redis.zscore(redisKeys.heartbeat, driverId);
  return s === null ? null : Number(s);
}

export const driverHash = (redis: Redis, driverId: string) => redis.hgetall(redisKeys.driver(driverId));

/** Testin kullandığı şoförlerin varlık anahtarlarını siler (global FLUSH yok). */
export async function cleanupPresence(redis: Redis, driverIds: Iterable<string>) {
  const ids = [...driverIds];
  if (!ids.length) return;
  const m = redis.multi();
  m.zrem(redisKeys.geoAvailable, ...ids);
  m.zrem(redisKeys.heartbeat, ...ids);
  for (const id of ids) {
    m.del(
      redisKeys.driver(id), redisKeys.locationThrottle(id), redisKeys.driverRequests(id),
      redisKeys.driverPresenceVersion(id),
    );
  }
  await m.exec();
}

/** Koşul sağlanana kadar kısa aralıklarla dener (ack'siz event'lerin etkisini beklemek için). */
export async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 3000, stepMs = 25): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last)) {
    if (Date.now() > end) throw new Error(`waitFor zaman aşımı; son değer: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, stepMs));
    last = await fn();
  }
  return last;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Socket'i açar ve `session_sync` dinleyicisini bağlantıdan ÖNCE kurar (polling'de connect ve
 * session_sync aynı pakette gelebilir; connect'ten sonra dinlemek event'i kaçırabilir).
 */
export function connectWithSync<T>(t: TestApp, nsp: '/driver' | '/stand', token: string) {
  const socket: Socket = t.socket(nsp, token);
  const sync = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session_sync gelmedi')), 5000);
    socket.once(COMMON_EVENTS.sessionSync, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.once('connect_error', (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`beklenmedik connect_error: ${err.message}`));
    });
  });
  return { socket, sync };
}

/** Socket'e gelecek bir sonraki `session_sync`'i bekler. */
export function nextSessionSync<T>(socket: Socket, timeoutMs = 3000) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session_sync gelmedi')), timeoutMs);
    socket.once(COMMON_EVENTS.sessionSync, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Uygulamanın kendi PresenceService nesnesindeki bir metodu sarar (socket handler'ları servisi nesne
 * üzerinden çağırır: `presence.goOnline(...)`). Mock değildir: sarmalayıcı orijinali gerçek Redis'e karşı
 * çağırır; yalnızca araya adım ekler / sonucu kaydeder. Dönen fonksiyon sarmalamayı geri alır.
 */
export function wrapPresence<K extends keyof PresenceService>(
  p: PresenceService,
  key: K,
  wrap: (orig: PresenceService[K]) => PresenceService[K],
): () => void {
  const original = p[key];
  p[key] = wrap((original as (...a: unknown[]) => unknown).bind(p) as PresenceService[K]);
  return () => {
    p[key] = original;
  };
}

/**
 * Sunucu tarafındaki socket'leri gözlemek için HTTP'ye bağlanmayan bir socket.io "probe" node'u.
 * redis-adapter ile kurulan tüm node'lara `allRooms()` isteği yayınlar; testin helper'ı `io`'yu
 * dışa açmadığı için sunucunun bir kopmayı işlediğini böyle doğrularız. Yalnızca `redisAdapter: true`
 * ile başlatılan node'ları görür.
 */
export async function createProbe(redis: Redis) {
  const pub = redis.duplicate();
  const sub = redis.duplicate();
  const io = new Server({ adapter: createAdapter(pub, sub) });
  const driverNsp = io.of(NAMESPACES.driver);
  // Abonelikler namespace oluşurken kuyruğa alınır; PING döndüğünde etkindir.
  await sub.ping();
  return {
    /**
     * Herhangi bir node'da `driver:{id}` odası var mı (en az bir bağlı socket). `fetchSockets()` yerine
     * `allRooms()`: node'lar arası fetchSockets `socket.data`'yı JSON'a çevirir; sunucu orada zamanlayıcı
     * (Timeout) tuttuğu için istek yanıtsız kalır.
     */
    async driverConnected(driverId: string) {
      return (await (driverNsp.adapter as unknown as RedisAdapter).allRooms()).has(rooms.driver(driverId));
    },
    async close() {
      // Probe HTTP'ye bağlı değil: io.close() engine olmadığı için hata verir; adapter'ı ve istemcileri kapat.
      await Promise.resolve((driverNsp.adapter as { close?: () => unknown }).close?.());
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}
