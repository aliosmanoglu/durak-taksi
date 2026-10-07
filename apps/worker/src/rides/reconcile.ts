// Uzlaştırıcı (reconciler): PG ile Redis/BullMQ arasındaki kalıcı sapmaları düzeltir. PG kazanır.
// Kurallar (her biri idempotent; aşırı agresif olmamak için yaş eşiği veya "iki kez gör" işareti kullanır):
//  1. Yetim `created` ride (API `created → searching` geçişini yapamadan düştü): belirli yaştan eskiyse `searching`'e alınır.
//  2. `searching` ride'ın dispatch / hatırlatma zinciri canlı değilse (startSearch hatası, attempts tükenmesi, Redis
//     veri kaybı) job deterministik id ile yeniden kurulur. Çağrı kendiliğinden iptal edilmez; yalnızca arama sürdürülür.
//  3. Ride hash'i `matched` ama PG `searching` (kabul geri alımı başarısız oldu): hash `searching`'e çevrilir.
//  4. Şoför hash'i `busy` ama PG'de `matched` ride'ı yok: şoför `available` yapılır (Lua, presenceVersion artar).
//  6. PG'de `matched` ama şoför hesabı `suspended` (askıya alma ile kabul yarışı): ride `searching`'e döner, şoför offline.
//  5. Yakın zamanda terminal olmuş ride'ın hash'i hâlâ açık görünüyorsa terminal duruma çekilir.
//  7. PG'de açık (`searching`/`matched`) ride'ı olup durağı `suspended` olan: ride `stand_suspended` sebebiyle `cancelled`
//     yapılır (RideStateMachine'deki sistem geçişiyle aynı kural; çağrının kendiliğinden iptali tek bu istisnadır).
// 3 ve 4 devam eden bir kabulle (Lua → PG arası, milisaniyeler) yarışabileceği için "iki kez gör" kuralıyla çalışır:
// bozukluk ilk görüldüğünde TTL'li işaret konur, bir sonraki turda hâlâ bozuksa onarılır.
// Loglara ham konum/telefon yazılmaz.
import type { Job, Queue } from 'bullmq';
import {
  canTransition, DISPATCH, DRIVER_EVENTS, DRIVER_SUSPENDED_REASON, STAND_EVENTS, STAND_SUSPENDED_REASON, DRIVER_HASH, jobIds, PRESENCE, PRESENCE_VERSION_LUA, redisKeys, REMINDER, RIDE_HASH,
  roundJobNumber,
  type ReminderJobData, type RideCancelledEvent, type RideDriverCancelledEvent, type RideTakenEvent,
} from '@duraknet/shared';
import { addDispatchJob, addReminderJob, ENSURE_CACHE, type RideJobDeps } from './dispatch';

const LIVE_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);
const SUSPECT_TTL_S = 300;
const SEARCHING_LIMIT = 500;
const TERMINAL_WINDOW_MS = 15 * 60_000;
const TERMINAL_MIN_AGE_MS = 30_000;

export type ReconcileResult = {
  orphansStarted: number;
  dispatchRestarted: number;
  reminderRestarted: number;
  ridesRepaired: number;
  driversReleased: number;
  terminalRepaired: number;
  suspendedReleased: number;
  standSuspendedCancelled: number;
};

// Ride hash'i `matched` ise `searching`'e çevirir (PG sürümüyle). KEYS: 1=ride  ARGV: 1=version
const REPAIR_SEARCHING = `
if redis.call('HGET', KEYS[1], '${RIDE_HASH.status}') ~= 'matched' then return 0 end
redis.call('HSET', KEYS[1], '${RIDE_HASH.status}', 'searching', '${RIDE_HASH.version}', ARGV[1])
redis.call('HDEL', KEYS[1], '${RIDE_HASH.driverId}')
return 1
`;

// Terminal olmuş ride'ın açık görünen hash'ini kapatır. KEYS: 1=ride 2=candidates 3=excluded 4=stand active_rides
// ARGV: 1=rideId 2=durum 3=sürüm 4=terminalTtlS
const REPAIR_TERMINAL = `
local s = redis.call('HGET', KEYS[1], '${RIDE_HASH.status}')
if s ~= 'searching' and s ~= 'matched' then return 0 end
redis.call('HSET', KEYS[1], '${RIDE_HASH.status}', ARGV[2], '${RIDE_HASH.version}', ARGV[3])
redis.call('SREM', KEYS[4], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('EXPIRE', KEYS[3], ARGV[4])
return 1
`;

// `busy` ama PG'de eşleşmesi olmayan şoförü `available` yapar (yalnızca hash'teki rideId beklenenle aynıysa).
// KEYS: 1=driver 2=geo 3=heartbeat 4=driver pv  ARGV: 1=driverId 2=beklenen rideId ('' = yok) 3=driverHashTtlS
const RELEASE_ORPHAN_BUSY = `${PRESENCE_VERSION_LUA}
if redis.call('HGET', KEYS[1], '${DRIVER_HASH.status}') ~= 'busy' then return 0 end
local cur = redis.call('HGET', KEYS[1], '${DRIVER_HASH.rideId}')
if (cur or '') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], '${DRIVER_HASH.status}', 'available')
redis.call('HDEL', KEYS[1], '${DRIVER_HASH.rideId}')
redis.call('EXPIRE', KEYS[1], ARGV[3])
dnBumpVersion(KEYS[4], dnNowMs())
local pos = redis.call('HMGET', KEYS[1], '${DRIVER_HASH.lng}', '${DRIVER_HASH.lat}')
if pos[1] and pos[2] then redis.call('GEOADD', KEYS[2], pos[1], pos[2], ARGV[1]) end
redis.call('ZADD', KEYS[3], 'NX', dnNowMs(), ARGV[1])
return 1
`;

// Askıya alınan şoförü ride'dan ayırır: ride hash'i `searching`, şoför excluded, adaylar silinir.
// KEYS: 1=ride 2=candidates 3=excluded  ARGV: 1=version 2=driverId
const RESET_RIDE_SEARCHING = `
redis.call('HSET', KEYS[1], '${RIDE_HASH.status}', 'searching', '${RIDE_HASH.version}', ARGV[1], '${RIDE_HASH.wave}', 0)
redis.call('HDEL', KEYS[1], '${RIDE_HASH.driverId}')
redis.call('DEL', KEYS[2])
redis.call('SADD', KEYS[3], ARGV[2])
return 1
`;

// Şoförü zorla offline yapar (askıya alma). KEYS: 1=driver 2=geo 3=heartbeat 4=driver pv  ARGV: 1=driverId 2=driverHashTtlS
const FORCE_OFFLINE = `${PRESENCE_VERSION_LUA}
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('HSET', KEYS[1], '${DRIVER_HASH.status}', 'offline', '${DRIVER_HASH.offlineReason}', 'forced')
redis.call('HDEL', KEYS[1], '${DRIVER_HASH.rideId}')
redis.call('EXPIRE', KEYS[1], ARGV[2])
dnBumpVersion(KEYS[4], dnNowMs())
return 1
`;

// Durağı askıdaki ride'ı iptal eder: hash terminal, durağın açık kümesinden çıkar, TTL'ler; eşleşmiş şoför `busy` ise
// ve rideId aynıysa `available` yapılır (GEO'ya geri yazılır, presenceVersion artar). Döner: önceki adaylar.
// KEYS: 1=ride 2=candidates 3=excluded 4=stand active_rides 5=driver 6=geo 7=heartbeat 8=driver pv
// ARGV: 1=rideId 2=sürüm 3=şoför ('' yok) 4=terminalTtlS 5=driverHashTtlS
const CANCEL_FOR_STAND_SUSPENSION = `${PRESENCE_VERSION_LUA}
local cands = redis.call('SMEMBERS', KEYS[2])
redis.call('HSET', KEYS[1], '${RIDE_HASH.status}', 'cancelled', '${RIDE_HASH.version}', ARGV[2])
redis.call('HDEL', KEYS[1], '${RIDE_HASH.driverId}')
redis.call('SREM', KEYS[4], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('EXPIRE', KEYS[3], ARGV[4])
if ARGV[3] ~= '' and redis.call('HGET', KEYS[5], '${DRIVER_HASH.status}') == 'busy'
   and redis.call('HGET', KEYS[5], '${DRIVER_HASH.rideId}') == ARGV[1] then
  redis.call('HSET', KEYS[5], '${DRIVER_HASH.status}', 'available')
  redis.call('HDEL', KEYS[5], '${DRIVER_HASH.rideId}')
  redis.call('EXPIRE', KEYS[5], ARGV[5])
  dnBumpVersion(KEYS[8], dnNowMs())
  local pos = redis.call('HMGET', KEYS[5], '${DRIVER_HASH.lng}', '${DRIVER_HASH.lat}')
  if pos[1] and pos[2] then redis.call('GEOADD', KEYS[6], pos[1], pos[2], ARGV[3]) end
  redis.call('ZADD', KEYS[7], 'NX', dnNowMs(), ARGV[3])
end
return cands
`;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Bozukluk ilk kez mi görülüyor? İlkse işaret konur ve `false` döner; işaret varsa siler ve `true` (onar) döner. */
async function confirmed(deps: RideJobDeps, kind: string, id: string): Promise<boolean> {
  const key = redisKeys.reconcileSuspect(kind, id);
  const set = await deps.redis.set(key, '1', 'EX', SUSPECT_TTL_S, 'NX');
  if (set === 'OK') return false;
  await deps.redis.del(key);
  return true;
}

async function isLive(queue: Queue, jobId: string | null | undefined, searchVersion: number): Promise<boolean> {
  if (!jobId) return false;
  const job = await queue.getJob(jobId);
  if (!job) return false;
  return LIVE_STATES.has(await job.getState()) && (job.data as { searchVersion?: number }).searchVersion === searchVersion;
}

/** Aynı id'li, artık canlı olmayan (failed/completed) eski job id'yi serbest bırakır; yoksa `add` yok sayılırdı. */
async function freeJobId(queue: Queue, jobId: string): Promise<void> {
  const job: Job | undefined = await queue.getJob(jobId);
  if (!job) return;
  const state = await job.getState();
  if (state === 'failed' || state === 'completed') await job.remove().catch(() => undefined);
}

type SearchingRow = {
  id: string; version: number; stand_id: string; since: Date; plat: number; plng: number;
};

export type ReconcileOptions = { now?: number };

export async function processReconcile(deps: RideJobDeps, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const { pool, redis, log, timing } = deps;
  const now = opts.now ?? Date.now();
  const minAgeMs = timing.reconcileMinAgeMs ?? 30_000;
  const orphanAgeMs = timing.reconcileOrphanAgeMs ?? 60_000;
  const res: ReconcileResult = {
    orphansStarted: 0, dispatchRestarted: 0, reminderRestarted: 0, ridesRepaired: 0, driversReleased: 0, terminalRepaired: 0, suspendedReleased: 0,
    standSuspendedCancelled: 0,
  };

  // --- 1. Yetim `created` ride'lar. Geçiş RideStateMachine ile aynı kuraldadır (shared RIDE_TRANSITIONS):
  // tek koşullu UPDATE; version = 0 koşulu API'nin kendi geçişiyle yarışta ikinci kez ilerletmeyi engeller.
  if (canTransition('created', 'searching', 'dispatch_started', 'system')) {
    const orphans = await pool.query<{ id: string; version: number; stand_id: string; plat: number; plng: number }>(
      `UPDATE rides SET status = 'searching', version = version + 1, searching_at = now()
        WHERE id IN (SELECT id FROM rides WHERE status = 'created' AND version = 0
                      AND created_at < now() - ($1::bigint * interval '1 millisecond') LIMIT 100)
          AND status = 'created' AND version = 0
        RETURNING id, version, stand_id, ST_Y(pickup_location::geometry) AS plat, ST_X(pickup_location::geometry) AS plng`,
      [orphanAgeMs],
    );
    for (const o of orphans.rows) {
      try {
        await redis.eval(
          ENSURE_CACHE, 2, redisKeys.ride(o.id), redisKeys.standActiveRides(o.stand_id),
          o.id, String(o.version), o.stand_id, String(o.plat), String(o.plng),
        );
        await freeJobId(deps.dispatchQueue, jobIds.dispatch(o.id, roundJobNumber(o.version, 1)));
        await addDispatchJob(deps, { rideId: o.id, searchVersion: o.version, wave: 1 }, 0);
        await addReminderJob(deps, { rideId: o.id, searchVersion: o.version, n: 1 }, timing.reminderFirstMs ?? REMINDER.FIRST_SEC * 1000);
        res.orphansStarted++;
        log.warn({ rideId: o.id }, 'yetim created ride searching\'e alındı');
      } catch (err) {
        log.warn({ err: errMsg(err), rideId: o.id }, 'yetim ride başlatılamadı');
      }
    }
  }

  // --- 2 + 3. `searching` ride'lar: zincir canlılığı ve önbellek tutarlılığı.
  const searching = await pool.query<SearchingRow>(
    `SELECT id, version, stand_id, COALESCE(searching_at, created_at) AS since,
            ST_Y(pickup_location::geometry) AS plat, ST_X(pickup_location::geometry) AS plng
       FROM rides
      WHERE status = 'searching' AND COALESCE(searching_at, created_at) < now() - ($1::bigint * interval '1 millisecond')
      ORDER BY created_at LIMIT ${SEARCHING_LIMIT}`,
    [minAgeMs],
  );
  const firstMs = timing.reminderFirstMs ?? REMINDER.FIRST_SEC * 1000;
  for (const r of searching.rows) {
    try {
      const [dispatchJob, reminderJob, wave, cachedStatus] = await redis.hmget(
        redisKeys.ride(r.id), RIDE_HASH.dispatchJob, RIDE_HASH.reminderJob, RIDE_HASH.wave, RIDE_HASH.status,
      );

      if (cachedStatus === 'matched' && (await confirmed(deps, 'ride', r.id))) {
        await redis.eval(REPAIR_SEARCHING, 1, redisKeys.ride(r.id), String(r.version));
        res.ridesRepaired++;
        log.warn({ rideId: r.id }, 'ride önbelleği PG ile uzlaştırıldı (matched → searching)');
      }

      const dispatchLive =
        (await isLive(deps.dispatchQueue, dispatchJob, r.version)) ||
        (await isLive(deps.dispatchQueue, jobIds.dispatch(r.id, roundJobNumber(r.version, 1)), r.version));
      if (!dispatchLive) {
        const nextWave = (Number(wave) || 0) + 1;
        await freeJobId(deps.dispatchQueue, jobIds.dispatch(r.id, roundJobNumber(r.version, nextWave)));
        await addDispatchJob(deps, { rideId: r.id, searchVersion: r.version, wave: nextWave }, 0);
        res.dispatchRestarted++;
        log.warn({ rideId: r.id, wave: nextWave }, 'dispatch zinciri yeniden kuruldu');
      }

      const reminderLive =
        (await isLive(deps.reminderQueue, reminderJob, r.version)) ||
        (await isLive(deps.reminderQueue, jobIds.reminder(r.id, roundJobNumber(r.version, 1)), r.version));
      if (!reminderLive) {
        // Geçen süreye göre ızgara: ilk hatırlatma `firstMs`, sonrakiler `reminderEveryMs` aralığında. Id'ler ızgara
        // dilimine bağlıdır (deterministik): eşzamanlı uzlaştırıcılar aynı job'ı üretir.
        const elapsed = Math.max(0, now - new Date(r.since).getTime());
        const every = timing.reminderEveryMs;
        let n: number;
        let delay: number;
        if (elapsed < firstMs) {
          n = 1;
          delay = firstMs - elapsed;
        } else {
          const past = elapsed - firstMs;
          n = 2 + Math.floor(past / every);
          delay = every - (past % every);
        }
        await freeJobId(deps.reminderQueue, jobIds.reminder(r.id, roundJobNumber(r.version, n)));
        await addReminderJob(deps, { rideId: r.id, searchVersion: r.version, n } satisfies ReminderJobData, delay);
        res.reminderRestarted++;
      }
    } catch (err) {
      log.warn({ err: errMsg(err), rideId: r.id }, 'ride uzlaştırılamadı');
    }
  }

  // --- 4. `busy` ama PG'de `matched` ride'ı olmayan şoförler (heartbeat kümesi taranır).
  let cursor = '0';
  do {
    const [next, items] = await redis.zscan(redisKeys.heartbeat, cursor, 'COUNT', 500);
    cursor = next;
    const ids = items.filter((_, i) => i % 2 === 0);
    if (ids.length === 0) continue;
    try {
      const pipe = redis.pipeline();
      for (const id of ids) pipe.hmget(redisKeys.driver(id), DRIVER_HASH.status, DRIVER_HASH.rideId);
      const states = (await pipe.exec()) ?? [];
      const busy: { id: string; rideId: string }[] = [];
      ids.forEach((id, i) => {
        const vals = (states[i]?.[1] as (string | null)[] | undefined) ?? [];
        if (vals[0] === 'busy') busy.push({ id, rideId: vals[1] ?? '' });
      });
      if (busy.length === 0) continue;
      const matched = await pool.query<{ driver_id: string }>(
        `SELECT driver_id::text AS driver_id FROM rides WHERE status = 'matched' AND driver_id::text = ANY($1::text[])`,
        [busy.map((b) => b.id)],
      );
      const hasRide = new Set(matched.rows.map((m) => m.driver_id));
      for (const b of busy) {
        if (hasRide.has(b.id) || !(await confirmed(deps, 'driver', b.id))) continue;
        const done = Number(
          await redis.eval(
            RELEASE_ORPHAN_BUSY, 4,
            redisKeys.driver(b.id), redisKeys.geoAvailable, redisKeys.heartbeat, redisKeys.driverPresenceVersion(b.id),
            b.id, b.rideId, PRESENCE.DRIVER_HASH_TTL_S,
          ),
        );
        if (done === 1) {
          res.driversReleased++;
          log.warn('eşleşmesiz busy şoför available yapıldı');
        }
      }
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'busy şoförler uzlaştırılamadı');
    }
  } while (cursor !== '0');

  // --- 6. PG'de `matched` ama şoför hesabı askıda. Geçiş RideStateMachine'deki `driver_suspended` (matched → searching,
  // aktör sistem) ile aynı kuraldadır; tek koşullu UPDATE. İki kez görme kuralı: askıya alma yolunun kendi
  // `releaseDriverForSuspension`'ı ile çakışmasın.
  if (canTransition('matched', 'searching', DRIVER_SUSPENDED_REASON, 'system')) {
    try {
      const sus = await pool.query<{ id: string }>(
        `SELECT r.id FROM rides r JOIN drivers d ON d.id = r.driver_id
          WHERE r.status = 'matched' AND d.status = 'suspended' LIMIT 50`,
      );
      for (const c of sus.rows) {
        if (!(await confirmed(deps, 'suspended-ride', c.id))) continue;
        const upd = await pool.query<{
          id: string; version: number; stand_id: string; old_driver: string; name: string; plate: string;
          plat: number; plng: number;
        }>(
          `WITH t AS (SELECT r.id, r.driver_id, d.full_name, d.plate FROM rides r JOIN drivers d ON d.id = r.driver_id
                       WHERE r.id = $1 AND r.status = 'matched' AND d.status = 'suspended' FOR UPDATE OF r)
           UPDATE rides r SET status = 'searching', version = r.version + 1, searching_at = now(), driver_id = NULL,
                  matched_at = NULL, dispatch_wave = 0, current_radius_m = NULL
             FROM t WHERE r.id = t.id AND r.status = 'matched'
           RETURNING r.id, r.version, r.stand_id, t.driver_id AS old_driver, t.full_name AS name, t.plate,
                     ST_Y(r.pickup_location::geometry) AS plat, ST_X(r.pickup_location::geometry) AS plng`,
          [c.id],
        );
        const o = upd.rows[0];
        if (!o) continue;
        await redis.eval(
          RESET_RIDE_SEARCHING, 3, redisKeys.ride(o.id), redisKeys.rideCandidates(o.id), redisKeys.rideExcluded(o.id),
          String(o.version), o.old_driver,
        );
        await redis.eval(
          ENSURE_CACHE, 2, redisKeys.ride(o.id), redisKeys.standActiveRides(o.stand_id),
          o.id, String(o.version), o.stand_id, String(o.plat), String(o.plng),
        );
        await redis.eval(
          FORCE_OFFLINE, 4, redisKeys.driver(o.old_driver), redisKeys.geoAvailable, redisKeys.heartbeat,
          redisKeys.driverPresenceVersion(o.old_driver), o.old_driver, PRESENCE.DRIVER_HASH_TTL_S,
        );
        const ev: RideDriverCancelledEvent = {
          rideId: o.id, reason: DRIVER_SUSPENDED_REASON, driverName: o.name, plate: o.plate, version: o.version,
        };
        deps.emitter.toStand(o.stand_id, STAND_EVENTS.rideDriverCancelled, ev);
        await freeJobId(deps.dispatchQueue, jobIds.dispatch(o.id, roundJobNumber(o.version, 1)));
        await addDispatchJob(deps, { rideId: o.id, searchVersion: o.version, wave: 1 }, 0);
        await addReminderJob(deps, { rideId: o.id, searchVersion: o.version, n: 1 }, firstMs);
        res.suspendedReleased++;
        log.warn({ rideId: o.id }, 'askıdaki şoförün eşleşmesi bırakıldı (uzlaştırıcı)');
      }
    } catch (err) {
      log.warn({ err: errMsg(err) }, "askıdaki şoförün ride'ları uzlaştırılamadı");
    }
  }

  // --- 7. PG'de açık ride'ı olup durağı askıda olan. İki kez görme kuralı: askıya alma yolunun kendi
  // `releaseStandForSuspension`'ı ile çakışmasın. Tek koşullu UPDATE (RideStateMachine `stand_suspended` ile aynı kural).
  if (
    canTransition('searching', 'cancelled', STAND_SUSPENDED_REASON, 'system') &&
    canTransition('matched', 'cancelled', STAND_SUSPENDED_REASON, 'system')
  ) {
    try {
      const open = await pool.query<{ id: string }>(
        `SELECT r.id FROM rides r JOIN stands s ON s.id = r.stand_id
          WHERE r.status IN ('searching', 'matched') AND s.status = 'suspended' LIMIT 50`,
      );
      for (const c of open.rows) {
        if (!(await confirmed(deps, 'suspended-stand-ride', c.id))) continue;
        const upd = await pool.query<{ id: string; version: number; stand_id: string; driver_id: string | null }>(
          `WITH t AS (SELECT r.id FROM rides r JOIN stands s ON s.id = r.stand_id
                       WHERE r.id = $1 AND r.status IN ('searching', 'matched') AND s.status = 'suspended' FOR UPDATE OF r)
           UPDATE rides r SET status = 'cancelled', version = r.version + 1, cancelled_at = now(), cancel_reason = $2
             FROM t WHERE r.id = t.id AND r.status IN ('searching', 'matched')
           RETURNING r.id, r.version, r.stand_id, r.driver_id::text AS driver_id`,
          [c.id, STAND_SUSPENDED_REASON],
        );
        const o = upd.rows[0];
        if (!o) continue;
        const driverId = o.driver_id ?? '';
        const cands = (await redis.eval(
          CANCEL_FOR_STAND_SUSPENSION, 8,
          redisKeys.ride(o.id), redisKeys.rideCandidates(o.id), redisKeys.rideExcluded(o.id), redisKeys.standActiveRides(o.stand_id),
          redisKeys.driver(driverId || '_'), redisKeys.geoAvailable, redisKeys.heartbeat, redisKeys.driverPresenceVersion(driverId || '_'),
          o.id, String(o.version), driverId, DISPATCH.RIDE_TERMINAL_TTL_S, PRESENCE.DRIVER_HASH_TTL_S,
        )) as string[];
        if (driverId) {
          const ev: RideCancelledEvent = { rideId: o.id, reason: STAND_SUSPENDED_REASON, version: o.version };
          deps.emitter.toDriver(driverId, DRIVER_EVENTS.rideCancelled, ev);
        } else {
          const taken: RideTakenEvent = { rideId: o.id, version: o.version };
          for (const cand of cands) {
            await redis.srem(redisKeys.driverRequests(cand), o.id);
            deps.emitter.toDriver(cand, DRIVER_EVENTS.rideTaken, taken);
          }
        }
        res.standSuspendedCancelled++;
        log.warn({ rideId: o.id }, 'askıdaki durağın açık çağrısı iptal edildi (uzlaştırıcı)');
      }
    } catch (err) {
      log.warn({ err: errMsg(err) }, "askıdaki durağın ride'ları uzlaştırılamadı");
    }
  }

  // --- 5. Yakın zamanda terminal olmuş ama önbellekte hâlâ açık görünen ride'lar.
  try {
    const term = await pool.query<{ id: string; status: string; version: number; stand_id: string }>(
      `SELECT id, status, version, stand_id FROM rides
        WHERE status IN ('completed', 'cancelled')
          AND COALESCE(completed_at, cancelled_at) BETWEEN to_timestamp($1::double precision / 1000)
                                                       AND to_timestamp($2::double precision / 1000)
        LIMIT 200`,
      [now - TERMINAL_WINDOW_MS, now - TERMINAL_MIN_AGE_MS],
    );
    for (const t of term.rows) {
      const fixed = Number(
        await redis.eval(
          REPAIR_TERMINAL, 4,
          redisKeys.ride(t.id), redisKeys.rideCandidates(t.id), redisKeys.rideExcluded(t.id), redisKeys.standActiveRides(t.stand_id),
          t.id, t.status, String(t.version), DISPATCH.RIDE_TERMINAL_TTL_S,
        ),
      );
      if (fixed === 1) res.terminalRepaired++;
    }
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'terminal ride önbelleği uzlaştırılamadı');
  }

  if (Object.values(res).some((v) => v > 0)) log.info(res, 'uzlaştırıcı düzeltme yaptı');
  return res;
}
