// Faz 3 (çağrı & dispatch) entegrasyon testleri için yardımcılar. Gerçek PG + Redis; mock yok.
// Testler yalnızca soket sözleşmesi (packages/shared) ve DB/Redis durumu üzerinden konuşur; böylece
// backend iç yapısından bağımsızdır. Redis/PG paralel test dosyalarıyla paylaşıldığı için her test
// dünyanın başka bir yerinde (rastgele konum) kurulur: GEO sonuçları başka testlerin şoförlerini içermez.
import { randomInt, randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io-client';
import {
  COMMON_EVENTS, DRIVER_EVENTS, redisKeys, STAND_EVENTS,
  type Ack, type DriverSessionSync, type DriverStatusResult, type LatLng, type RideCreateResult,
  type StandSessionSync,
} from '@duraknet/shared';
import type { TestApp } from './app';
import { cleanupPresence, sleep, waitFor } from './presence';

// ---------- Konum ----------

/** Her test kendi "şehrinde": başka dosyaların şoförleri GEO aramasına girmez. */
export function uniqueCity(): LatLng {
  return { lat: 10 + randomInt(0, 400_000) / 10_000, lng: -120 + randomInt(0, 2_000_000) / 10_000 };
}
/** `p`'den kuzeye `m` metre (yaklaşık; 1° enlem ≈ 111.2 km). */
export const north = (p: LatLng, m: number): LatLng => ({ lat: p.lat + m / 111_195, lng: p.lng });

// ---------- Olay kaydedici ----------

export type Rec = ReturnType<typeof record>;

/** Socket'e gelen tüm sunucu event'lerini kaydeder. Bağlantıdan ÖNCE kurulmalı (session_sync kaçmasın). */
export function record(socket: Socket) {
  const events: { name: string; data: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const waiters = new Set<() => void>();
  socket.onAny((name: string, data: unknown) => {
    events.push({ name, data });
    for (const w of [...waiters]) w();
  });
  const all = (name: string, pred: (d: any) => boolean = () => true) => // eslint-disable-line @typescript-eslint/no-explicit-any
    events.filter((e) => e.name === name && pred(e.data)).map((e) => e.data);
  return {
    events,
    all,
    count: (name: string, pred?: (d: any) => boolean) => all(name, pred).length, // eslint-disable-line @typescript-eslint/no-explicit-any
    /** `name` (ve `pred`) için en az `n` kayıt birikene kadar bekler; hepsini döndürür. */
    async waitFor(name: string, pred: (d: any) => boolean = () => true, opts: { n?: number; ms?: number } = {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const n = opts.n ?? 1;
      const ms = opts.ms ?? 8000;
      if (all(name, pred).length >= n) return all(name, pred);
      return new Promise<any[]>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`'${name}' ${n} kez gelmedi (gelen: ${all(name, pred).length}; tüm olaylar: ${events.map((e) => e.name).join(',')})`));
        }, ms);
        const check = () => {
          if (all(name, pred).length >= n) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve(all(name, pred));
          }
        };
        waiters.add(check);
      });
    },
    /** `ms` boyunca `name` gelmediğini doğrular (negatif beklenti; zamanlamaya dayalı olduğundan kısa tutun). */
    async expectNone(name: string, ms = 600, pred: (d: any) => boolean = () => true) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const before = all(name, pred).length;
      await sleep(ms);
      const after = all(name, pred).length;
      if (after !== before) throw new Error(`'${name}' gelmemeliydi ama ${after - before} kez geldi`);
    },
  };
}

/** Ack'li emit; ack gelmezse zaman aşımı ile reddeder (handler hiç ack döndürmezse test kırmızı olur). */
export function emitAck<T = unknown>(socket: Socket, event: string, payload: unknown, ms = 8000): Promise<Ack<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`'${event}' ack gelmedi`)), ms);
    socket.emit(event, payload, (res: Ack<T>) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

export const errCode = (a: Ack<unknown>) => (a.ok ? undefined : a.error.code);

// ---------- Dünya kurulumu ----------

export type StandActor = Awaited<ReturnType<Scope['stand']>>;
export type DriverActor = Awaited<ReturnType<Scope['driver']>>;

/**
 * Bir testin dünyası: kurduğu aktörleri izler ve `cleanup()` ile hepsini temizler
 * (açık çağrıları duraktan iptal eder, Redis anahtarlarını siler, rides → sürücü/durak sırasıyla PG'den siler).
 */
export class Scope {
  readonly driverIds = new Set<string>();
  readonly standIds = new Set<string>();
  readonly rideIds = new Set<string>();
  private readonly standSockets: Socket[] = [];

  constructor(readonly t: TestApp) {}

  /** Onaylı durak + bağlı `/stand` soketi. `location` durağın (ve genelde çağrının) konumu. */
  async stand(location: LatLng, radii?: { initialRadiusM: number; maxRadiusM: number }) {
    const { t } = this;
    const reg = await t.registerStand(location);
    await t.adminAction('stands', reg.id, 'approve');
    const login = await t.loginStand(reg.username);
    const tokens = login.body.data as { accessToken: string; refreshToken: string };
    this.standIds.add(reg.id);
    if (radii) {
      const res = await t.http().patch('/stands/me/settings').set('Authorization', `Bearer ${tokens.accessToken}`).send(radii);
      if (res.status !== 200) throw new Error(`durak ayarı başarısız: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const a = await this.openStand(tokens.accessToken);
    return { id: reg.id, username: reg.username, location, tokens, ...a };
  }

  /** Aynı durak için yeni bir `/stand` soketi (ör. panel yenileme, ikinci tablet). */
  async openStand(token: string) {
    const socket = this.t.socket('/stand', token);
    const rec = record(socket);
    const sync = rec.waitFor(COMMON_EVENTS.sessionSync).then((l) => l[0] as StandSessionSync);
    await new Promise<void>((res, rej) => {
      socket.once('connect', () => res());
      socket.once('connect_error', (e: Error) => rej(new Error(`durak bağlanamadı: ${e.message}`)));
    });
    this.standSockets.push(socket);
    return { socket, rec, sync: await sync };
  }

  /** Onaylı şoför. `at` verilirse bağlanıp aktif olur (go_online). `online: false` ile yalnızca bağlanır. */
  async driver(at?: LatLng, opts: { online?: boolean } = {}) {
    const { t } = this;
    const d = await t.approvedDriver();
    this.driverIds.add(d.id);
    const conn = await this.openDriver(d.tokens.accessToken);
    let goOnline: DriverStatusResult | undefined;
    if (at && opts.online !== false) {
      const ack = await emitAck<DriverStatusResult>(conn.socket, DRIVER_EVENTS.goOnline, { location: at });
      if (!ack.ok) throw new Error(`go_online başarısız: ${JSON.stringify(ack)}`);
      goOnline = ack.data;
    }
    return { ...d, location: at, goOnline, ...conn };
  }

  async openDriver(token: string) {
    const socket = this.t.socket('/driver', token);
    const rec = record(socket);
    const sync = rec.waitFor(COMMON_EVENTS.sessionSync).then((l) => l[0] as DriverSessionSync);
    await new Promise<void>((res, rej) => {
      socket.once('connect', () => res());
      socket.once('connect_error', (e: Error) => rej(new Error(`şoför bağlanamadı: ${e.message}`)));
    });
    return { socket, rec, sync: await sync };
  }

  /** Durak soketinden çağrı açar; ack'ten rideId/shortCode döner ve takibe alır. */
  async createRide(stand: StandActor, pickup: LatLng = stand.location, extra: Record<string, unknown> = {}) {
    const ack = await emitAck<RideCreateResult>(stand.socket, STAND_EVENTS.rideCreate, {
      pickup, pickupAddress: 'Test Mah. Test Sk. No:1', ...extra,
    });
    if (!ack.ok || !ack.data) throw new Error(`ride_create başarısız: ${JSON.stringify(ack)}`);
    this.rideIds.add(ack.data.rideId);
    return ack.data;
  }

  // ---- Gözlemler (PG / Redis) ----

  ride(rideId: string) {
    return this.t.db.selectFrom('rides').selectAll().where('id', '=', rideId).executeTakeFirst();
  }
  rideStatus = async (rideId: string) => (await this.ride(rideId))?.status;
  async waitRideStatus(rideId: string, status: string, ms = 5000) {
    return waitFor(() => this.rideStatus(rideId), (s) => s === status, ms);
  }
  rideHash = (rideId: string) => this.t.redis.hgetall(redisKeys.ride(rideId));
  driverHash = (id: string) => this.t.redis.hgetall(redisKeys.driver(id));
  isExcluded = async (rideId: string, driverId: string) => (await this.t.redis.sismember(redisKeys.rideExcluded(rideId), driverId)) === 1;
  isCandidate = async (rideId: string, driverId: string) => (await this.t.redis.sismember(redisKeys.rideCandidates(rideId), driverId)) === 1;
  inGeo = async (driverId: string) => (await this.t.redis.geopos(redisKeys.geoAvailable, driverId))[0] != null;

  /** `ride_searching` olaylarından en son `version` (durak istemcisinin elindeki sürüm). */
  lastVersion(rec: Rec, rideId: string) {
    const versions = [
      ...rec.all(STAND_EVENTS.rideSearching, (d) => d.rideId === rideId),
      ...rec.all(STAND_EVENTS.rideMatched, (d) => d.rideId === rideId),
      ...rec.all(STAND_EVENTS.rideDriverCancelled, (d) => d.rideId === rideId),
    ].map((d) => d.version as number);
    return Math.max(...versions);
  }

  async cleanup() {
    const { t } = this;
    // Açık çağrıları durak iptal eder: dispatch job'ları kendiliğinden durur.
    const searching = [...this.rideIds].length
      ? await t.db.selectFrom('rides').select(['id', 'stand_id', 'version', 'status']).where('id', 'in', [...this.rideIds]).execute()
      : [];
    for (const r of searching) {
      if (r.status === 'completed' || r.status === 'cancelled') continue;
      const s = this.standSockets.find((x) => x.connected);
      if (!s) continue;
      await emitAck(s, STAND_EVENTS.rideCancel, { rideId: r.id, version: r.version }, 1500).catch(() => {});
    }
    await sleep(100);
    for (const s of this.standSockets) s.close();
    this.standSockets.length = 0;
    if (this.rideIds.size) {
      const ids = [...this.rideIds];
      const m = t.redis.multi();
      for (const id of ids) {
        m.del(redisKeys.ride(id), redisKeys.rideCandidates(id), redisKeys.rideExcluded(id));
      }
      for (const s of this.standIds) m.del(redisKeys.standActiveRides(s));
      await m.exec();
    }
    await cleanupPresence(t.redis, this.driverIds);
    if (this.driverIds.size) await t.redis.del(...[...this.driverIds].map((id) => redisKeys.driverRequests(id)));
    // rides → stands/drivers FK'si olduğundan önce ride'lar silinir.
    if (this.standIds.size) await t.db.deleteFrom('rides').where('stand_id', 'in', [...this.standIds]).execute();
    if (this.driverIds.size) await t.db.deleteFrom('rides').where('driver_id', 'in', [...this.driverIds]).execute();
    await t.cleanup();
  }
}

export const uuid = randomUUID;
export { sleep, waitFor };
