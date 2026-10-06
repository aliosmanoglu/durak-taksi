// Çağrı yaşam döngüsü (CLAUDE.md Bölüm 1, 5, 6). Durum yalnızca RideStateMachine ile değişir.
// Yazma sırası: PG koşullu UPDATE kazanır, ardından Redis önbelleği uydurulur ve event yayınlanır.
// İstisna: kabulde önce Redis Lua (FCFS yarışı), sonra PG; PG 0 satır dönerse Redis geri alınır.
// Servis bellekte kullanıcı/ride/socket state'i tutmaz; yayın `RideEventSink` üzerindendir.
import { randomInt } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  DISPATCH, DRIVER_EVENTS, DRIVER_SUSPENDED_REASON, DRIVER_HASH, PRESENCE, redisKeys, RIDE_HASH, RIDE_EVENTS_CHANNEL, RIDE_ROOM_EVENTS,
  STAND_EVENTS,
  type LatLng, type RideCancelledEvent, type RideCompletedEvent, type RideCreateResult,
  type RideDriverCancelledEvent, type RideEventMessage, type RideMatchedEvent, type RideRequest,
  type RideSnapshot, type RideStatus,
} from '@duraknet/shared';
import { isUniqueViolation, toGeography, type Db } from '../db';
import { AppError } from '../http/errors';
import { defineLua } from '../presence/scripts';
import { distanceM } from './geo';
import { fetchRideRows, toRequest, toSnapshot, type RideFilter } from './repo';
import { ACCEPT, ACCEPT_ROLLBACK, DECLINE, MIRROR } from './scripts';
import type { DispatchScheduler } from './scheduler';
import type { RideEventSink } from './sink';
import { RideStateMachine, type TransitionResult } from './state-machine';
import { retry } from '../util/retry';

export type RideCreateInput = {
  pickup: LatLng;
  pickupAddress: string;
  dropoff?: LatLng;
  dropoffAddress?: string;
  notes?: string;
};

export type DriverRideSync = { activeRide?: RideSnapshot; openRequests: RideRequest[] };

export interface RideService {
  /** Durak: çağrı açar (`created` → `searching`), önbelleği yazar, dispatch'i başlatır. */
  createRide(standId: string, input: RideCreateInput): Promise<RideCreateResult>;
  /** Şoför: FCFS kabul. Kaybeden `RIDE_NOT_AVAILABLE` / `NOT_A_CANDIDATE` / `DRIVER_NOT_AVAILABLE`. */
  accept(driverId: string, rideId: string): Promise<RideSnapshot>;
  /** Şoför: çağrıyı reddeder (excluded). Zaten kapalı çağrı için idempotent başarı. */
  decline(driverId: string, rideId: string): Promise<void>;
  /** Şoför: eşleşmiş çağrıyı iptal eder → `searching`'e döner, şoför excluded. */
  driverCancel(
    driverId: string,
    input: { rideId: string; version: number; reason?: string },
  ): Promise<{ rideId: string; version: number }>;
  /** Şoför / durak: `matched` → `completed`. */
  complete(
    actor: { role: 'driver' | 'stand'; id: string },
    input: { rideId: string; version: number },
  ): Promise<RideCompletedEvent>;
  /** Durak: `searching` | `matched` → `cancelled`. */
  standCancel(
    standId: string,
    input: { rideId: string; version: number; reason?: string },
  ): Promise<RideCancelledEvent>;
  /**
   * Askıya alma kararı (b): şoförün `matched` ride'ı varsa `searching`'e döndürür (sebep `driver_suspended`,
   * aktör sistem, şoför excluded, dispatch yeniden planlanır). Ride yoksa hiçbir şey yapmaz.
   * Çağıran ardından `presence.forceOffline` çağırmalıdır.
   */
  releaseDriverForSuspension(driverId: string): Promise<void>;
  /** `session_sync` için: aktif ride ve (şoför `available` ise) açık çağrılar. */
  driverSync(driverId: string, driverStatus: string): Promise<DriverRideSync>;
  /** `session_sync` için: durağın `searching`/`matched` ride'ları. */
  standSync(standId: string): Promise<RideSnapshot[]>;
  /** Busy şoförün konumunu eşleşen ride'ın odasına yayınlar (`ride_driver_location`). */
  publishDriverLocation(rideId: string, location: LatLng, heading: number | undefined, ts: number): void;
}

export type RideServiceOptions = {
  db: Db;
  redis: Redis;
  log: Logger;
  sink: RideEventSink;
  scheduler: DispatchScheduler;
};

const SHORT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const shortCode = () =>
  Array.from({ length: 6 }, () => SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)]).join('');

const notAvailable = () => new AppError(409, 'RIDE_NOT_AVAILABLE', 'Çağrı artık müsait değil');
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createRideService(opts: RideServiceOptions): RideService {
  const { db, redis, log, sink, scheduler } = opts;
  const machine = new RideStateMachine(db);
  const driverTtl = PRESENCE.DRIVER_HASH_TTL_S;
  const terminalTtl = DISPATCH.RIDE_TERMINAL_TTL_S;

  const acceptLua = defineLua(redis, 'dnRideAccept', 6, ACCEPT);
  const rollbackLua = defineLua(redis, 'dnRideAcceptRollback', 5, ACCEPT_ROLLBACK);
  const mirrorLua = defineLua(redis, 'dnRideMirror', 8, MIRROR);
  const declineLua = defineLua(redis, 'dnRideDecline', 4, DECLINE);

  // Bildirim hatası işlemi bozmaz (durum PG'de commit edilmiştir).
  const publish = (rideId: string, from: RideStatus, to: RideStatus, version: number) => {
    const msg: RideEventMessage = { rideId, from, to, version };
    redis.publish(RIDE_EVENTS_CHANNEL, JSON.stringify(msg)).catch((e: unknown) =>
      log.warn({ err: errMsg(e) }, 'ride olayı yayınlanamadı'),
    );
  };

  /**
   * PG'deki geçişi Redis önbelleğine yansıtır. Sınırlı yeniden denenir (Lua idempotenttir); yine de başarısız olursa
   * PG geri alınmaz (PG kazanır), hata loglanır ve worker uzlaştırıcısı önbelleği düzeltir.
   */
  async function mirror(
    tr: TransitionResult,
    opt: { releaseDriverId: string | null; excludeDriver: boolean },
  ): Promise<string[]> {
    const driverId = opt.releaseDriverId ?? '';
    try {
      return await retry(
        async () =>
          (await mirrorLua(
            redisKeys.ride(tr.rideId), redisKeys.rideCandidates(tr.rideId), redisKeys.rideExcluded(tr.rideId),
            redisKeys.standActiveRides(tr.standId),
            redisKeys.driver(driverId || '_'), redisKeys.geoAvailable, redisKeys.heartbeat,
            redisKeys.driverPresenceVersion(driverId || '_'),
            tr.rideId, tr.to, tr.version, driverId, opt.excludeDriver ? '1' : '0', terminalTtl, driverTtl,
          )) as string[],
      );
    } catch (err) {
      log.error({ err: errMsg(err), rideId: tr.rideId, to: tr.to }, 'ride önbelleği güncellenemedi');
      return [];
    }
  }

  /**
   * Dispatch'i başlatır (scheduler kısa yeniden deneme yapar). PG'de ride zaten `searching` olduğundan hata isteği
   * düşürmez: job'sız kalan ride'ı worker uzlaştırıcısı yeniden kurar. Loglanır (ham veri yok).
   */
  async function startSearchSafe(rideId: string, searchVersion: number) {
    try {
      await retry(() => scheduler.startSearch(rideId, searchVersion), { attempts: 3, baseDelayMs: 100 });
    } catch (err) {
      log.error({ err: errMsg(err), rideId }, 'dispatch başlatılamadı; uzlaştırıcı yeniden kuracak');
    }
  }

  async function driverLocation(driverId: string): Promise<LatLng | undefined> {
    const [lat, lng] = await redis.hmget(redisKeys.driver(driverId), DRIVER_HASH.lat, DRIVER_HASH.lng);
    if (lat == null || lng == null) return undefined;
    const p = { lat: Number(lat), lng: Number(lng) };
    return Number.isFinite(p.lat) && Number.isFinite(p.lng) ? p : undefined;
  }

  async function snapshotsOf(filter: RideFilter): Promise<RideSnapshot[]> {
    const rows = await fetchRideRows(db, filter);
    return Promise.all(rows.map(async (r) => toSnapshot(r, r.driver ? await driverLocation(r.driver.id) : undefined)));
  }

  // Şoföre gösterilen, hâlâ `searching` olan çağrılar. Kapanmış çağrılar (ride_taken kaçmış olabilir) temizlenir.
  async function openRequestsOf(driverId: string): Promise<RideRequest[]> {
    const ids = await redis.smembers(redisKeys.driverRequests(driverId));
    if (ids.length === 0) return [];
    const statuses = await Promise.all(ids.map((id) => redis.hget(redisKeys.ride(id), RIDE_HASH.status)));
    const open = ids.filter((_, i) => statuses[i] === 'searching');
    const stale = ids.filter((_, i) => statuses[i] !== 'searching');
    if (stale.length > 0) await redis.srem(redisKeys.driverRequests(driverId), ...stale).catch(() => 0);
    const rows = (await fetchRideRows(db, { kind: 'ids', ids: open })).filter((r) => r.status === 'searching');
    const pos = await driverLocation(driverId);
    return rows.map((r) => toRequest(r, pos ? distanceM(pos, r.pickup) : 0));
  }

  /** `matched` → `searching` sonrası ortak iş: önbellek, dispatch yeniden planı, durağa bildirim. */
  async function afterReturnToSearching(tr: TransitionResult, driverId: string, reason: string | undefined) {
    await mirror(tr, { releaseDriverId: driverId, excludeDriver: true });
    sink.leaveRide(tr.rideId, 'driver');
    publish(tr.rideId, 'matched', 'searching', tr.version);
    const d = await db.selectFrom('drivers').select(['full_name', 'plate']).where('id', '=', driverId).executeTakeFirst();
    const ev: RideDriverCancelledEvent = {
      rideId: tr.rideId,
      ...(reason ? { reason } : {}),
      driverName: d?.full_name ?? '',
      plate: d?.plate ?? '',
      version: tr.version,
    };
    sink.toStand(tr.standId, STAND_EVENTS.rideDriverCancelled, ev);
    // Şoför iptali kaydı: ayrı tablo yok, olay loglanır. Serbest metin `reason` loglanmaz (gizlilik): yalnızca var/yok.
    log.info({ rideId: tr.rideId, driverId, hasReason: Boolean(reason) }, 'eşleşme şoför tarafından bırakıldı; yeniden aranıyor');
    await startSearchSafe(tr.rideId, tr.version);
  }

  return {
    async createRide(standId, input) {
      let inserted: { id: string; short_code: string } | undefined;
      for (let attempt = 0; !inserted; attempt++) {
        try {
          inserted = await db
            .insertInto('rides')
            .values({
              short_code: shortCode(),
              stand_id: standId,
              pickup_location: toGeography(input.pickup),
              pickup_address: input.pickupAddress,
              dropoff_location: input.dropoff ? toGeography(input.dropoff) : null,
              dropoff_address: input.dropoffAddress ?? null,
              notes: input.notes ?? null,
            })
            .returning(['id', 'short_code'])
            .executeTakeFirstOrThrow();
        } catch (err) {
          if (!isUniqueViolation(err) || attempt >= 4) throw err;
        }
      }
      const rideId = inserted.id;

      const tr = await machine.transition({ rideId, reason: 'dispatch_started', actor: 'system', expectedVersion: 0 });

      // PG commit edildi; önbellek ve dispatch. Önbellek yazılamazsa worker ilk dalgada yeniden kurar (PG kazanır).
      try {
        await redis
          .multi()
          .hset(redisKeys.ride(rideId), {
            [RIDE_HASH.status]: 'searching',
            [RIDE_HASH.version]: tr.version,
            [RIDE_HASH.standId]: standId,
            [RIDE_HASH.pickupLat]: String(input.pickup.lat),
            [RIDE_HASH.pickupLng]: String(input.pickup.lng),
            [RIDE_HASH.radius]: 0,
            [RIDE_HASH.wave]: 0,
          })
          .sadd(redisKeys.standActiveRides(standId), rideId)
          .exec();
      } catch (err) {
        log.error({ err: errMsg(err), rideId }, 'ride önbelleği yazılamadı');
      }
      publish(rideId, 'created', 'searching', tr.version);
      await startSearchSafe(rideId, tr.version);
      return { rideId, shortCode: inserted.short_code };
    },

    async accept(driverId, rideId) {
      const r = (await acceptLua(
        redisKeys.ride(rideId), redisKeys.driver(driverId), redisKeys.geoAvailable,
        redisKeys.rideCandidates(rideId), redisKeys.rideExcluded(rideId), redisKeys.driverPresenceVersion(driverId),
        driverId, rideId,
      )) as [number, number | string, number?];
      if (r[0] !== 1) {
        const code = r[1];
        if (code === 'NOT_A_CANDIDATE') throw new AppError(409, 'NOT_A_CANDIDATE', 'Bu çağrı size gösterilmedi');
        if (code === 'DRIVER_NOT_AVAILABLE') throw new AppError(409, 'DRIVER_NOT_AVAILABLE', 'Şu anda çağrı alamazsınız');
        throw notAvailable();
      }
      const newVersion = Number(r[1]);

      let tr: TransitionResult;
      try {
        tr = await machine.transition({
          rideId, reason: 'driver_accepted', actor: 'driver', driverId, expectedVersion: newVersion - 1,
        });
      } catch (err) {
        // PG 0 satır (veya hata): Redis'i geri al (compensating action). Ride hash'i PG'nin güncel durumuna göre
        // düzeltilir: araya giren durak iptali/tamamlaması ride'ı terminal yapmışsa yeniden `searching` yapılmaz.
        // Bu okuma yalnızca telafi içindir; karar Lua'dadır. Okunamazsa ride hash'ine dokunulmaz (uzlaştırıcı düzeltir).
        const pg = await db
          .selectFrom('rides').select(['status', 'version']).where('id', '=', rideId).executeTakeFirst()
          .catch(() => undefined);
        await retry(() =>
          rollbackLua(
            redisKeys.ride(rideId), redisKeys.driver(driverId), redisKeys.geoAvailable, redisKeys.heartbeat,
            redisKeys.driverPresenceVersion(driverId), driverId, rideId, pg?.status ?? '', pg?.version ?? 0,
            driverTtl, terminalTtl,
          ),
        ).catch((e: unknown) => log.error({ err: errMsg(e), rideId }, 'kabul geri alınamadı; uzlaştırıcı düzeltecek'));
        if (err instanceof AppError && err.code !== 'DRIVER_NOT_AVAILABLE') throw notAvailable();
        throw err;
      }

      // Bu ride artık açık değil: adayların ekranından kalkar; kazananın diğer açık çağrıları da kapanır.
      const [cands, excluded, ownRequests] = await Promise.all([
        redis.smembers(redisKeys.rideCandidates(rideId)),
        redis.smembers(redisKeys.rideExcluded(rideId)),
        redis.smembers(redisKeys.driverRequests(driverId)),
      ]);
      const pipe = redis.pipeline();
      for (const c of cands) pipe.srem(redisKeys.driverRequests(c), rideId);
      for (const other of ownRequests) if (other !== rideId) pipe.srem(redisKeys.rideCandidates(other), driverId);
      pipe.del(redisKeys.driverRequests(driverId));
      await pipe.exec().catch((e: unknown) => log.warn({ err: errMsg(e), rideId }, 'istek kümeleri temizlenemedi'));

      const [snapshot] = await snapshotsOf({ kind: 'ids', ids: [rideId] });
      if (!snapshot) throw notAvailable();
      const driverPos = snapshot.driver?.location;
      const dist = driverPos ? distanceM(driverPos, snapshot.pickup) : 0;

      sink.joinRide(rideId, { driverId, standId: tr.standId });
      sink.toDriver(driverId, DRIVER_EVENTS.rideAccepted, snapshot);
      for (const c of cands) {
        if (c !== driverId && !excluded.includes(c)) sink.toDriver(c, DRIVER_EVENTS.rideTaken, { rideId });
      }
      for (const other of ownRequests) {
        if (other !== rideId) sink.toDriver(driverId, DRIVER_EVENTS.rideTaken, { rideId: other });
      }
      if (snapshot.driver) {
        const ev: RideMatchedEvent = {
          rideId,
          version: tr.version,
          distanceM: Math.round(dist),
          driver: {
            id: snapshot.driver.id,
            name: snapshot.driver.name,
            plate: snapshot.driver.plate,
            ...(snapshot.driver.vehicle ? { vehicle: snapshot.driver.vehicle } : {}),
            phone: snapshot.driver.phone,
          },
        };
        sink.toStand(tr.standId, STAND_EVENTS.rideMatched, ev);
      }
      publish(rideId, 'searching', 'matched', tr.version);
      return snapshot;
    },

    async decline(driverId, rideId) {
      const r = Number(
        await declineLua(
          redisKeys.ride(rideId), redisKeys.rideCandidates(rideId), redisKeys.rideExcluded(rideId),
          redisKeys.driverRequests(driverId), driverId, rideId,
        ),
      );
      if (r === -1) throw new AppError(409, 'NOT_A_CANDIDATE', 'Bu çağrı size gösterilmedi');
    },

    async driverCancel(driverId, input) {
      const tr = await machine.transition({
        rideId: input.rideId, reason: 'driver_cancelled', actor: 'driver', driverId, expectedVersion: input.version,
      });
      await afterReturnToSearching(tr, driverId, input.reason);
      return { rideId: tr.rideId, version: tr.version };
    },

    async releaseDriverForSuspension(driverId) {
      const [ride] = await fetchRideRows(db, { kind: 'driverMatched', driverId });
      if (!ride) return;
      let tr: TransitionResult;
      try {
        tr = await machine.transition({ rideId: ride.rideId, reason: DRIVER_SUSPENDED_REASON, actor: 'system', driverId });
      } catch (err) {
        // Araya giren durak iptali / tamamlama: serbest bırakılacak bir şey kalmadı.
        if (err instanceof AppError) return;
        throw err;
      }
      await afterReturnToSearching(tr, driverId, DRIVER_SUSPENDED_REASON);
    },

    async complete(actor, input) {
      const tr = await machine.transition({
        rideId: input.rideId,
        reason: 'completed',
        actor: actor.role,
        expectedVersion: input.version,
        ...(actor.role === 'driver' ? { driverId: actor.id } : { standId: actor.id }),
      });
      await mirror(tr, { releaseDriverId: tr.driverId, excludeDriver: false });
      const ev: RideCompletedEvent = {
        rideId: tr.rideId, completedAt: (tr.completedAt ?? new Date()).toISOString(), version: tr.version,
      };
      sink.toStand(tr.standId, STAND_EVENTS.rideCompleted, ev);
      // Şoför kendi tamamlamasında ack alır; durak tamamlarsa şoföre event gider.
      if (actor.role === 'stand' && tr.driverId) sink.toDriver(tr.driverId, DRIVER_EVENTS.rideCompleted, ev);
      sink.leaveRide(tr.rideId, 'both');
      publish(tr.rideId, 'matched', 'completed', tr.version);
      return ev;
    },

    async standCancel(standId, input) {
      const tr = await machine.transition({
        rideId: input.rideId,
        reason: 'stand_cancelled',
        actor: 'stand',
        standId,
        expectedVersion: input.version,
        ...(input.reason ? { cancelReason: input.reason } : {}),
      });
      const cands = await mirror(tr, { releaseDriverId: tr.driverId, excludeDriver: false });
      const ev: RideCancelledEvent = {
        rideId: tr.rideId, ...(input.reason ? { reason: input.reason } : {}), version: tr.version,
      };
      if (tr.from === 'searching') {
        // Açık çağrı adayların ekranından kalkar.
        if (cands.length > 0) {
          const pipe = redis.pipeline();
          for (const c of cands) pipe.srem(redisKeys.driverRequests(c), tr.rideId);
          await pipe.exec().catch((e: unknown) => log.warn({ err: errMsg(e) }, 'istek kümeleri temizlenemedi'));
        }
        for (const c of cands) sink.toDriver(c, DRIVER_EVENTS.rideTaken, { rideId: tr.rideId });
      } else if (tr.driverId) {
        sink.toDriver(tr.driverId, DRIVER_EVENTS.rideCancelled, ev);
      }
      sink.toStand(standId, STAND_EVENTS.rideCancelled, ev);
      sink.leaveRide(tr.rideId, 'both');
      publish(tr.rideId, tr.from, 'cancelled', tr.version);
      return ev;
    },

    async driverSync(driverId, driverStatus) {
      const [activeRide] = await snapshotsOf({ kind: 'driverMatched', driverId });
      const openRequests = driverStatus === 'available' ? await openRequestsOf(driverId) : [];
      return { ...(activeRide ? { activeRide } : {}), openRequests };
    },

    standSync: (standId) => snapshotsOf({ kind: 'standOpen', standId }),

    publishDriverLocation(rideId, location, heading, ts) {
      sink.toStandRide(rideId, RIDE_ROOM_EVENTS.driverLocation, {
        rideId, location, ...(heading !== undefined ? { heading } : {}), ts,
      });
    },
  };
}
