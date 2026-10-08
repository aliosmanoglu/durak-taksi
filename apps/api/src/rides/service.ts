// Çağrı yaşam döngüsü (CLAUDE.md Bölüm 1, 5, 6). Durum yalnızca RideStateMachine ile değişir.
// Yazma sırası: PG koşullu UPDATE kazanır, ardından Redis önbelleği uydurulur ve event yayınlanır.
// İstisna: kabulde önce Redis Lua (FCFS yarışı), sonra PG; PG 0 satır dönerse Redis geri alınır.
// Servis bellekte kullanıcı/ride/socket state'i tutmaz; yayın `RideEventSink` üzerindendir.
import { randomInt } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  DISPATCH, DRIVER_EVENTS, DRIVER_SUSPENDED_REASON, DRIVER_HASH, PRESENCE, redisKeys, RIDE_HASH, RIDE_EVENTS_CHANNEL, RIDE_ROOM_EVENTS,
  STAND_EVENTS, STAND_SUSPENDED_REASON,
  type LatLng, type RideAcceptAck, type RideCancelledEvent, type RideCompletedEvent, type RideCreateResult,
  type RideDriverCancelledEvent, type RideEventMessage, type RideMatchedEvent, type RideRequest,
  type RideSnapshot, type RideStatus, type RideTakenEvent,
} from '@duraknet/shared';
import { isUniqueViolation, latOf, lngOf, toGeography, type Db } from '../db';
import { AppError } from '../http/errors';
import { defineLua } from '../presence/scripts';
import { apiMetrics, type ApiMetrics } from '../metrics';
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
  /** İdempotency: aynı durak + aynı kimlik tek ride üretir; tekrarda mevcut ride döner, yeni arama başlamaz. */
  clientRequestId?: string;
};

export type DriverRideSync = { activeRide?: RideSnapshot; openRequests: RideRequest[] };

export interface RideService {
  /** Durak: çağrı açar (`created` → `searching`), önbelleği yazar, dispatch'i başlatır. */
  createRide(standId: string, input: RideCreateInput): Promise<RideCreateResult>;
  /**
   * Şoför: FCFS kabul. Kaybeden `RIDE_NOT_AVAILABLE` / `NOT_A_CANDIDATE` / `DRIVER_NOT_AVAILABLE`.
   * Dönen veri `RideSnapshot` + kabuldeki `busy` geçişinin `presenceVersion`'ı (ack); `ride_accepted` event'i düz snapshot'tır.
   */
  accept(driverId: string, rideId: string): Promise<RideAcceptAck>;
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
  /**
   * Durak askıya alma (tek sistem kaynaklı iptal istisnası): durağın açık (`searching`/`matched`) ride'larını
   * `stand_suspended` sebebiyle `cancelled` yapar (`cancel_reason = 'stand_suspended'`); eşleşmiş şoföre `ride_cancelled`,
   * adaylara `ride_taken`, şoför `busy → available`. Tekil hatalar loglanıp atlanır; kaçanı uzlaştırıcı kapatır.
   * Döner: iptal edilen ride sayısı.
   */
  releaseStandForSuspension(standId: string): Promise<number>;
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
  /** Prometheus metrikleri; verilmezse süreç geneli varsayılan. */
  metrics?: ApiMetrics;
};

const SHORT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const shortCode = () =>
  Array.from({ length: 6 }, () => SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)]).join('');

const notAvailable = () => new AppError(409, 'RIDE_NOT_AVAILABLE', 'Çağrı artık müsait değil');
/** Tekrar (idempotent) eşlemesine aday hatalar: durum hedefte ise sonuç aynı döner, değilse hata korunur. */
const RETRY_CODES = new Set(['INVALID_TRANSITION', 'VERSION_CONFLICT', 'FORBIDDEN']);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createRideService(opts: RideServiceOptions): RideService {
  const { db, redis, log, sink, scheduler } = opts;
  const metrics = opts.metrics ?? apiMetrics();
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

  /** İdempotent tekrar kontrolleri için ride'ın güncel (kısa) hali. Yalnızca hata yolunda okunur; karar değil, sonuç eşlemesi içindir. */
  const terminalRow = (rideId: string) =>
    db
      .selectFrom('rides')
      .select([
        'status', 'version', 'stand_id', 'driver_id', 'completed_at', 'cancel_reason',
        'last_driver_cancel_by', 'last_driver_cancel_version',
      ])
      .where('id', '=', rideId)
      .executeTakeFirst();

  /** Kabul tekrarı: ride bu şoföre zaten `matched` ise snapshot + güncel `presenceVersion` (yeni event yayınlanmaz). */
  async function alreadyAcceptedBy(driverId: string, rideId: string): Promise<RideAcceptAck | null> {
    const [status, owner] = await redis.hmget(redisKeys.ride(rideId), RIDE_HASH.status, RIDE_HASH.driverId);
    if (status !== 'matched' || owner !== driverId) return null;
    const [snapshot] = await snapshotsOf({ kind: 'ids', ids: [rideId] });
    if (!snapshot || snapshot.status !== 'matched' || snapshot.driver?.id !== driverId) return null;
    const pv = Number(await redis.get(redisKeys.driverPresenceVersion(driverId)));
    return { ...snapshot, presenceVersion: Number.isFinite(pv) && pv > 0 ? pv : Date.now() };
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

  /** Durak iptali / durak askıya alma sonrası ortak iş (PG commit edilmiştir): önbellek, event'ler, oda temizliği. */
  async function afterStandClose(tr: TransitionResult, reason: string | undefined): Promise<RideCancelledEvent> {
    const cands = await mirror(tr, { releaseDriverId: tr.driverId, excludeDriver: false });
    const ev: RideCancelledEvent = { rideId: tr.rideId, ...(reason ? { reason } : {}), version: tr.version };
    if (tr.from === 'searching') {
      // Açık çağrı adayların ekranından kalkar.
      if (cands.length > 0) {
        const pipe = redis.pipeline();
        for (const c of cands) pipe.srem(redisKeys.driverRequests(c), tr.rideId);
        await pipe.exec().catch((e: unknown) => log.warn({ err: errMsg(e) }, 'istek kümeleri temizlenemedi'));
      }
      const taken: RideTakenEvent = { rideId: tr.rideId, version: tr.version };
      for (const c of cands) sink.toDriver(c, DRIVER_EVENTS.rideTaken, taken);
    } else if (tr.driverId) {
      sink.toDriver(tr.driverId, DRIVER_EVENTS.rideCancelled, ev);
    }
    sink.toStand(tr.standId, STAND_EVENTS.rideCancelled, ev);
    sink.leaveRide(tr.rideId, 'both');
    publish(tr.rideId, tr.from, 'cancelled', tr.version);
    metrics.ridesTotal.inc({ event: 'cancelled' });
    return ev;
  }

  return {
    async createRide(standId, input) {
      let inserted: { id: string; short_code: string } | undefined;
      const requestId = input.clientRequestId;
      for (let attempt = 0; !inserted; attempt++) {
        try {
          const row = await db
            .insertInto('rides')
            .values({
              short_code: shortCode(),
              stand_id: standId,
              client_request_id: requestId ?? null,
              pickup_location: toGeography(input.pickup),
              pickup_address: input.pickupAddress,
              dropoff_location: input.dropoff ? toGeography(input.dropoff) : null,
              dropoff_address: input.dropoffAddress ?? null,
              notes: input.notes ?? null,
            })
            // Yalnızca (stand_id, client_request_id) çakışması sessizce yok sayılır; short_code çakışması 23505 verip yeniden denenir.
            .onConflict((oc) =>
              oc.columns(['stand_id', 'client_request_id']).where('client_request_id', 'is not', null).doNothing(),
            )
            .returning(['id', 'short_code'])
            .executeTakeFirst();
          if (row) {
            inserted = row;
          } else if (requestId) {
            // Aynı istek daha önce işlendi (ack kaybı sonrası yeniden deneme): mevcut ride'ı dön, yeni arama başlatma.
            // İlk isteğin dispatch zinciri yarım kaldıysa worker uzlaştırıcısı kurar.
            const existing = await db
              .selectFrom('rides')
              .select(['id', 'short_code', 'status', 'pickup_address', latOf('pickup_location').as('pLat'), lngOf('pickup_location').as('pLng')])
              .where('stand_id', '=', standId).where('client_request_id', '=', requestId)
              .executeTakeFirstOrThrow();
            // Yalnızca AYNI içerik ve açık ride için idempotent ok. Kimlik yeniden kullanılmış (farklı içerik) ya da ride
            // kapanmışsa istemci yeni kimlikle yeniden denemeli: 409 CONFLICT.
            const sameContent =
              existing.pickup_address === input.pickupAddress &&
              Math.abs(Number(existing.pLat) - input.pickup.lat) < 1e-6 &&
              Math.abs(Number(existing.pLng) - input.pickup.lng) < 1e-6;
            if (!sameContent) throw new AppError(409, 'CONFLICT', 'Bu istek kimliği farklı bir çağrı için kullanılmış');
            if (existing.status === 'completed' || existing.status === 'cancelled') {
              throw new AppError(409, 'CONFLICT', 'Bu istek kimliğiyle açılan çağrı kapanmış; yeni kimlikle tekrar deneyin');
            }
            return { rideId: existing.id, shortCode: existing.short_code };
          }
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
      metrics.ridesTotal.inc({ event: 'created' });
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
        if (code === 'RIDE_NOT_AVAILABLE') {
          // İdempotent tekrar: ack kaybı sonrası aynı şoför yeniden kabul gönderdiyse ride zaten ona `matched`'tır.
          const again = await alreadyAcceptedBy(driverId, rideId);
          if (again) return again;
        }
        if (code === 'NOT_A_CANDIDATE') throw new AppError(409, 'NOT_A_CANDIDATE', 'Bu çağrı size gösterilmedi');
        if (code === 'DRIVER_NOT_AVAILABLE') throw new AppError(409, 'DRIVER_NOT_AVAILABLE', 'Şu anda çağrı alamazsınız');
        throw notAvailable();
      }
      const newVersion = Number(r[1]);
      const presenceVersion = Number(r[2]);

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
      const others = ownRequests.filter((o) => o !== rideId);
      const pipe = redis.pipeline();
      for (const c of cands) pipe.srem(redisKeys.driverRequests(c), rideId);
      for (const other of others) pipe.srem(redisKeys.rideCandidates(other), driverId);
      pipe.del(redisKeys.driverRequests(driverId));
      await pipe.exec().catch((e: unknown) => log.warn({ err: errMsg(e), rideId }, 'istek kümeleri temizlenemedi'));
      // Kazananın diğer açık çağrıları için `ride_taken.version`: o ride'ların önbellekteki güncel sürümü.
      const otherVersions = await Promise.all(
        others.map((o) => redis.hget(redisKeys.ride(o), RIDE_HASH.version).catch(() => null)),
      );

      const [snapshot] = await snapshotsOf({ kind: 'ids', ids: [rideId] });
      if (!snapshot) throw notAvailable();
      const driverPos = snapshot.driver?.location;
      const dist = driverPos ? distanceM(driverPos, snapshot.pickup) : 0;

      sink.joinRide(rideId, { driverId, standId: tr.standId });
      sink.toDriver(driverId, DRIVER_EVENTS.rideAccepted, snapshot);
      for (const c of cands) {
        if (c !== driverId && !excluded.includes(c)) {
          const ev: RideTakenEvent = { rideId, version: tr.version };
          sink.toDriver(c, DRIVER_EVENTS.rideTaken, ev);
        }
      }
      others.forEach((other, i) => {
        // Sürümü bilinmeyen (önbelleği düşmüş) ride için event atlanır: istemci zaten session_sync ile düzeltir.
        const v = otherVersions[i];
        if (v == null || !Number.isFinite(Number(v))) return;
        const ev: RideTakenEvent = { rideId: other, version: Number(v) };
        sink.toDriver(driverId, DRIVER_EVENTS.rideTaken, ev);
      });
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
      metrics.ridesTotal.inc({ event: 'matched' });
      if (tr.searchingAt && tr.matchedAt) {
        metrics.matchSeconds.observe(Math.max(0, (tr.matchedAt.getTime() - tr.searchingAt.getTime()) / 1000));
      }
      return { ...snapshot, presenceVersion };
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
      let tr: TransitionResult;
      try {
        tr = await machine.transition({
          rideId: input.rideId, reason: 'driver_cancelled', actor: 'driver', driverId, expectedVersion: input.version,
        });
      } catch (err) {
        // İdempotent tekrar: kanıt PG'dedir (iptal geçişiyle aynı UPDATE'te yazılan `last_driver_cancel_by`): yalnızca bu
        // ride'ı GERÇEKTEN iptal etmiş şoföre, orijinal iptalin sürümüyle ok. Decline-only şoför eski hata yolunu alır.
        if (err instanceof AppError && RETRY_CODES.has(err.code)) {
          const row = await terminalRow(input.rideId);
          if (row && row.last_driver_cancel_by === driverId && row.driver_id !== driverId && row.last_driver_cancel_version != null) {
            return { rideId: input.rideId, version: row.last_driver_cancel_version };
          }
        }
        throw err;
      }
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
      let tr: TransitionResult;
      try {
        tr = await machine.transition({
          rideId: input.rideId,
          reason: 'completed',
          actor: actor.role,
          expectedVersion: input.version,
          ...(actor.role === 'driver' ? { driverId: actor.id } : { standId: actor.id }),
        });
      } catch (err) {
        // İdempotent tekrar: ride zaten `completed` ve çağıran onun sahibi ise aynı sonuç döner (yetki önce kontrol edilir).
        if (err instanceof AppError && RETRY_CODES.has(err.code)) {
          const row = await terminalRow(input.rideId);
          const owner = actor.role === 'driver' ? row?.driver_id === actor.id : row?.stand_id === actor.id;
          if (row && owner && row.status === 'completed') {
            return {
              rideId: input.rideId,
              completedAt: (row.completed_at ? new Date(row.completed_at) : new Date()).toISOString(),
              version: row.version,
            };
          }
        }
        throw err;
      }
      await mirror(tr, { releaseDriverId: tr.driverId, excludeDriver: false });
      const ev: RideCompletedEvent = {
        rideId: tr.rideId, completedAt: (tr.completedAt ?? new Date()).toISOString(), version: tr.version,
      };
      sink.toStand(tr.standId, STAND_EVENTS.rideCompleted, ev);
      // Şoför kendi tamamlamasında ack alır; durak tamamlarsa şoföre event gider.
      if (actor.role === 'stand' && tr.driverId) sink.toDriver(tr.driverId, DRIVER_EVENTS.rideCompleted, ev);
      sink.leaveRide(tr.rideId, 'both');
      publish(tr.rideId, 'matched', 'completed', tr.version);
      metrics.ridesTotal.inc({ event: 'completed' });
      return ev;
    },

    async standCancel(standId, input) {
      let tr: TransitionResult;
      try {
        tr = await machine.transition({
          rideId: input.rideId,
          reason: 'stand_cancelled',
          actor: 'stand',
          standId,
          expectedVersion: input.version,
          ...(input.reason ? { cancelReason: input.reason } : {}),
        });
      } catch (err) {
        // İdempotent tekrar: aynı durağın ride'ı zaten `cancelled` ise `ok` (yabancı durak FORBIDDEN almaya devam eder).
        if (err instanceof AppError && RETRY_CODES.has(err.code)) {
          const row = await terminalRow(input.rideId);
          if (row && row.stand_id === standId && row.status === 'cancelled') {
            return { rideId: input.rideId, ...(row.cancel_reason ? { reason: row.cancel_reason } : {}), version: row.version };
          }
        }
        throw err;
      }
      return afterStandClose(tr, input.reason);
    },

    async releaseStandForSuspension(standId) {
      const open = await db
        .selectFrom('rides').select('id').where('stand_id', '=', standId).where('status', 'in', ['searching', 'matched'])
        .execute();
      let closed = 0;
      for (const { id } of open) {
        try {
          // Sürüm koşulu yok: sistem iptali durumdan bağımsız; yarışan kabul/tamamlama varsa koşullu UPDATE belirler.
          const tr = await machine.transition({
            rideId: id, reason: 'stand_suspended', actor: 'system', standId, cancelReason: STAND_SUSPENDED_REASON,
          });
          await afterStandClose(tr, STAND_SUSPENDED_REASON);
          closed++;
        } catch (err) {
          // Araya giren tamamlama/iptal (AppError) normaldir; diğer hatalar uzlaştırıcıya bırakılır.
          if (!(err instanceof AppError)) log.error({ err: errMsg(err), rideId: id }, 'durak askıya alma: ride iptal edilemedi');
        }
      }
      if (closed > 0) log.info({ standId, closed }, 'askıdaki durağın açık çağrıları iptal edildi');
      return closed;
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
