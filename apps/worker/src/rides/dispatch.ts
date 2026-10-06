// Dispatch dalgaları, sürekli tarama, ride_still_open hatırlatması ve stand_nearby_drivers
// (CLAUDE.md Bölüm 5, Senaryo 4). Zamanlama BullMQ'dadır; job'lar idempotenttir ve her çalışmada PG'den ride
// durumunu kontrol eder: `searching` ∧ `version === searchVersion` değilse (kapanmış veya eski arama turu) kendini
// yeniden planlamadan çıkar. Çağrı kendiliğinden iptal edilmez; arama ride `searching` olduğu sürece süresiz sürer.
// Şoför konumu/durumu Redis'ten, ride/durak verisi PG'den okunur. GEO komutlarında sıra (lng, lat).
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import {
  DISPATCH, DRIVER_EVENTS, DRIVER_HASH, jobIds, redisKeys, RIDE_HASH, roundJobNumber, STAND_EVENTS,
  type DispatchJobData, type LatLng, type ReminderJobData, type RideRequest, type RideSearchingEvent,
  type RideStillOpenEvent, type NearbyDriversEvent,
} from '@duraknet/shared';
import type { WorkerEmitter } from './emitter';

export type DispatchTiming = {
  /** Dalga 1, 2, 3 sonrası bekleme (ms). Tablo bitince `continuousScanMs`. */
  waveDelaysMs: number[];
  continuousScanMs: number;
  reminderEveryMs: number;
  nearbyEveryMs: number;
  /** Adayın konumu bundan eskiyse bildirilmez. */
  locationFreshMs: number;
  /** İlk `ride_still_open` gecikmesi (yalnızca uzlaştırıcı yeniden kurarken kullanılır; varsayılan `REMINDER.FIRST_SEC`). */
  reminderFirstMs?: number;
  /** Uzlaştırıcı tarama aralığı; verilmezse uzlaştırıcı kurulmaz (testler). */
  reconcileEveryMs?: number;
  /** `searching` ride'ı bu süreden yeniyse job'sız sayılmaz (API'nin startSearch'i sürüyor olabilir). Varsayılan 30 sn. */
  reconcileMinAgeMs?: number;
  /** `created` ride'ı bu süreden eskiyse yetim sayılıp `searching`'e alınır. Varsayılan 60 sn. */
  reconcileOrphanAgeMs?: number;
};

export const DEFAULT_TIMING: DispatchTiming = {
  waveDelaysMs: DISPATCH.WAVE_DELAY_S.map((s) => s * 1000),
  continuousScanMs: DISPATCH.CONTINUOUS_SCAN_EVERY_S * 1000,
  reminderEveryMs: 300_000,
  nearbyEveryMs: DISPATCH.NEARBY_EVERY_S * 1000,
  locationFreshMs: DISPATCH.LOCATION_FRESH_MS,
};

export type RideJobDeps = {
  pool: Pool;
  redis: Redis;
  emitter: WorkerEmitter;
  log: Logger;
  timing: DispatchTiming;
  dispatchQueue: Queue<DispatchJobData>;
  reminderQueue: Queue<ReminderJobData>;
};

export const JOB_OPTS = {
  removeOnComplete: true,
  removeOnFail: 100,
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 500 },
};

/** Dalga yarıçapı: 1 → initial, 2 → 2×initial (en çok max), 3+ → max. */
export function radiusForWave(wave: number, initialM: number, maxM: number): number {
  const mult = DISPATCH.WAVE_RADIUS_MULTIPLIERS[wave - 1];
  return mult === undefined ? maxM : Math.min(maxM, initialM * mult);
}

// Önbellek yoksa (TTL, kayıp, API'nin yazamaması) PG'ye göre yeniden kurar; varsa dokunmaz.
// KEYS: 1=ride 2=stand active_rides  ARGV: 1=rideId 2=version 3=standId 4=lat 5=lng
export const ENSURE_CACHE = `
if redis.call('HGET', KEYS[1], '${RIDE_HASH.status}') then return 0 end
redis.call('HSET', KEYS[1], '${RIDE_HASH.status}', 'searching', '${RIDE_HASH.version}', ARGV[2],
  '${RIDE_HASH.standId}', ARGV[3], '${RIDE_HASH.pickupLat}', ARGV[4], '${RIDE_HASH.pickupLng}', ARGV[5],
  '${RIDE_HASH.radius}', 0, '${RIDE_HASH.wave}', 0)
redis.call('SADD', KEYS[2], ARGV[1])
return 1
`;

// Adayları ride hâlâ `searching` iken atomik ekler (kabul/iptal Lua'sıyla aynı ride hash'ini okur): kapanıştan
// sonra candidates/requests kümelerine kalıntı yazılmaz.
// KEYS: 1=ride 2=candidates 3=excluded, sonra her aday için dn:driver:{id}:requests  ARGV: 1=rideId 2..=driverId
// Döner: yeni eklenen driverId'ler.
const NOTIFY = `
local out = {}
if redis.call('HGET', KEYS[1], '${RIDE_HASH.status}') ~= 'searching' then return out end
for i = 2, #ARGV do
  local id = ARGV[i]
  if redis.call('SISMEMBER', KEYS[3], id) == 0 and redis.call('SADD', KEYS[2], id) == 1 then
    redis.call('SADD', KEYS[i + 2], ARGV[1])
    out[#out + 1] = id
  end
end
return out
`;

// Sıradaki job id'sini yalnızca ride hash'i varsa yazar (TTL sonrası hayalet hash oluşmasın).
const NOTE_JOB = `
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end
return 1
`;

type DispatchRow = {
  status: string;
  version: number;
  stand_id: string;
  short_code: string;
  pickup_address: string;
  dropoff_address: string | null;
  notes: string | null;
  created_at: Date;
  searching_at: Date | null;
  plat: number;
  plng: number;
  stand_name: string;
  initial_radius_m: number;
  max_radius_m: number;
};

async function loadDispatchRow(pool: Pool, rideId: string): Promise<DispatchRow | undefined> {
  const r = await pool.query<DispatchRow>(
    `SELECT r.status, r.version, r.stand_id, r.short_code, r.pickup_address, r.dropoff_address, r.notes,
            r.created_at, r.searching_at,
            ST_Y(r.pickup_location::geometry) AS plat, ST_X(r.pickup_location::geometry) AS plng,
            s.name AS stand_name, s.initial_radius_m, s.max_radius_m
       FROM rides r JOIN stands s ON s.id = r.stand_id
      WHERE r.id = $1`,
    [rideId],
  );
  return r.rows[0];
}

export type DispatchOutcome =
  | { skipped: true }
  | { skipped: false; wave: number; radiusM: number; newCandidates: number; notifiedCount: number };

/** Dalga job'ını (deterministik id: tekrar `add` yok sayılır) ekler ve id'yi ride hash'ine not eder. */
export async function addDispatchJob(deps: RideJobDeps, data: DispatchJobData, delayMs: number): Promise<void> {
  const id = jobIds.dispatch(data.rideId, roundJobNumber(data.searchVersion, data.wave));
  await deps.dispatchQueue.add('wave', data, { ...JOB_OPTS, delay: delayMs, jobId: id });
  await deps.redis.eval(NOTE_JOB, 1, redisKeys.ride(data.rideId), RIDE_HASH.dispatchJob, id);
}

/** Hatırlatma job'ının karşılığı. */
export async function addReminderJob(deps: RideJobDeps, data: ReminderJobData, delayMs: number): Promise<void> {
  const id = jobIds.reminder(data.rideId, roundJobNumber(data.searchVersion, data.n));
  await deps.reminderQueue.add('remind', data, { ...JOB_OPTS, delay: delayMs, jobId: id });
  await deps.redis.eval(NOTE_JOB, 1, redisKeys.ride(data.rideId), RIDE_HASH.reminderJob, id);
}

/** Sonraki dalga/tarama: deterministik job id (tekrar çalıştırmaya karşı idempotent). */
async function enqueueNextWave(deps: RideJobDeps, data: DispatchJobData): Promise<void> {
  const delay = deps.timing.waveDelaysMs[data.wave - 1] ?? deps.timing.continuousScanMs;
  await addDispatchJob(deps, { ...data, wave: data.wave + 1 }, delay);
}

/**
 * Job tüm `attempts` hakkını tüketip başarısız olduysa zincir kopmasın: ride hâlâ aynı arama turunda `searching`
 * ise sonraki dalga yine planlanır (arama süresiz sürer). Hata olursa yalnızca loglanır; uzlaştırıcı yeniden kurar.
 */
export async function continueDispatchChain(deps: RideJobDeps, data: DispatchJobData): Promise<void> {
  try {
    const r = await deps.pool.query<{ status: string; version: number }>('SELECT status, version FROM rides WHERE id = $1', [data.rideId]);
    const ride = r.rows[0];
    if (!ride || ride.status !== 'searching' || ride.version !== data.searchVersion) return;
    await enqueueNextWave(deps, data);
  } catch (err) {
    deps.log.warn({ err: err instanceof Error ? err.message : String(err), rideId: data.rideId }, 'dispatch zinciri sürdürülemedi');
  }
}

/** `continueDispatchChain`'in hatırlatma karşılığı. */
export async function continueReminderChain(deps: RideJobDeps, data: ReminderJobData): Promise<void> {
  try {
    const r = await deps.pool.query<{ status: string; version: number }>('SELECT status, version FROM rides WHERE id = $1', [data.rideId]);
    const ride = r.rows[0];
    if (!ride || ride.status !== 'searching' || ride.version !== data.searchVersion) return;
    await enqueueNextReminder(deps, data);
  } catch (err) {
    deps.log.warn({ err: err instanceof Error ? err.message : String(err), rideId: data.rideId }, 'hatırlatma zinciri sürdürülemedi');
  }
}

async function enqueueNextReminder(deps: RideJobDeps, data: ReminderJobData): Promise<void> {
  await addReminderJob(deps, { ...data, n: data.n + 1 }, deps.timing.reminderEveryMs);
}

/** Bir dalga / tarama. Sonuç testler için döner. */
export async function processDispatch(deps: RideJobDeps, data: DispatchJobData): Promise<DispatchOutcome> {
  const { pool, redis, emitter, log, timing } = deps;
  const { rideId, searchVersion, wave } = data;

  const ride = await loadDispatchRow(pool, rideId);
  if (!ride || ride.status !== 'searching' || ride.version !== searchVersion) return { skipped: true };

  await redis.eval(
    ENSURE_CACHE, 2, redisKeys.ride(rideId), redisKeys.standActiveRides(ride.stand_id),
    rideId, String(ride.version), ride.stand_id, String(ride.plat), String(ride.plng),
  );

  const radiusM = radiusForWave(wave, ride.initial_radius_m, ride.max_radius_m);

  const [cands, excluded] = await Promise.all([
    redis.smembers(redisKeys.rideCandidates(rideId)),
    redis.smembers(redisKeys.rideExcluded(rideId)),
  ]);
  const seen = new Set([...cands, ...excluded]);

  // COUNT'a zaten bildirilmiş/dışlanmış şoförler kadar pay eklenir: en yakın 25'i hep aynı (eski) adaylar
  // doldurup sonraki taramalarda yeni şoförleri gizlemesin.
  const found = (await redis.call(
    'GEOSEARCH', redisKeys.geoAvailable,
    'FROMLONLAT', String(ride.plng), String(ride.plat),
    'BYRADIUS', String(radiusM), 'm',
    'ASC', 'COUNT', String(DISPATCH.GEOSEARCH_COUNT + seen.size), 'WITHDIST',
  )) as [string, string][];

  const fresh = found.filter(([id]) => !seen.has(id));
  const pipe = redis.pipeline();
  for (const [id] of fresh) pipe.hmget(redisKeys.driver(id), DRIVER_HASH.status, DRIVER_HASH.updatedAt);
  const states = fresh.length > 0 ? ((await pipe.exec()) ?? []) : [];
  const now = Date.now();
  const eligible: { id: string; distanceM: number }[] = [];
  fresh.forEach(([id, dist], i) => {
    const [, vals] = states[i] ?? [];
    const [status, updatedAt] = (vals as (string | null)[] | undefined) ?? [];
    if (status === 'available' && updatedAt != null && now - Number(updatedAt) <= timing.locationFreshMs) {
      eligible.push({ id, distanceM: Number(dist) });
    }
  });
  const chosen = eligible.slice(0, DISPATCH.GEOSEARCH_COUNT);

  let added: string[] = [];
  if (chosen.length > 0) {
    added = (await redis.eval(
      NOTIFY, 3 + chosen.length, redisKeys.ride(rideId), redisKeys.rideCandidates(rideId), redisKeys.rideExcluded(rideId),
      ...chosen.map((c) => redisKeys.driverRequests(c.id)),
      rideId, ...chosen.map((c) => c.id),
    )) as string[];
  }
  const distOf = new Map(chosen.map((c) => [c.id, c.distanceM]));
  for (const id of added) {
    const req: RideRequest = {
      rideId, shortCode: ride.short_code, pickup: { lat: ride.plat, lng: ride.plng }, pickupAddress: ride.pickup_address,
      ...(ride.dropoff_address ? { dropoffAddress: ride.dropoff_address } : {}),
      ...(ride.notes ? { notes: ride.notes } : {}),
      standName: ride.stand_name, distanceM: Math.round(distOf.get(id) ?? 0),
      createdAt: new Date(ride.created_at).toISOString(), version: ride.version,
    };
    emitter.toDriver(id, DRIVER_EVENTS.rideRequested, req);
  }

  // PG sayaçları (durum değil; status'a dokunulmaz). Ride bu arada kapandıysa 0 satır: durağa bildirim gitmez.
  const upd = await pool.query<{ notified_count: number }>(
    `UPDATE rides SET dispatch_wave = $2, current_radius_m = $3, notified_count = notified_count + $4
      WHERE id = $1 AND status = 'searching' AND version = $5
      RETURNING notified_count`,
    [rideId, Math.min(wave, 32767), radiusM, added.length, searchVersion],
  );
  const notifiedCount = upd.rows[0]?.notified_count;
  if (notifiedCount === undefined) return { skipped: true };

  await redis.hset(redisKeys.ride(rideId), { [RIDE_HASH.wave]: wave, [RIDE_HASH.radius]: radiusM });
  const searching: RideSearchingEvent = {
    rideId, wave, radiusM, notifiedCount,
    searchingSince: new Date(ride.searching_at ?? ride.created_at).toISOString(),
    version: ride.version,
  };
  emitter.toStand(ride.stand_id, STAND_EVENTS.rideSearching, searching);

  await enqueueNextWave(deps, data);

  log.debug({ rideId, wave, radiusM, added: added.length }, 'dispatch dalgası tamamlandı');
  return { skipped: false, wave, radiusM, newCandidates: added.length, notifiedCount };
}

/** `ride_still_open`: yalnızca bildirim; çağrıyı iptal etmez, aramayı etkilemez. */
export async function processReminder(deps: RideJobDeps, data: ReminderJobData): Promise<{ skipped: boolean }> {
  const { pool, emitter } = deps;
  const { rideId, searchVersion } = data;
  const r = await pool.query<{ status: string; version: number; stand_id: string; searching_at: Date | null; created_at: Date }>(
    'SELECT status, version, stand_id, searching_at, created_at FROM rides WHERE id = $1',
    [rideId],
  );
  const ride = r.rows[0];
  if (!ride || ride.status !== 'searching' || ride.version !== searchVersion) return { skipped: true };

  const since = new Date(ride.searching_at ?? ride.created_at);
  const ev: RideStillOpenEvent = {
    rideId,
    searchingSince: since.toISOString(),
    minutesOpen: Math.max(0, Math.floor((Date.now() - since.getTime()) / 60_000)),
    version: ride.version,
  };
  emitter.toStand(ride.stand_id, STAND_EVENTS.rideStillOpen, ev);

  await enqueueNextReminder(deps, data);
  return { skipped: false };
}

/** `stand_nearby_drivers`: onaylı her durağın `max_radius_m` içindeki `available` şoförleri, durak odasına. */
export async function processNearby(deps: Pick<RideJobDeps, 'pool' | 'redis' | 'emitter'>): Promise<{ stands: number }> {
  const { pool, redis, emitter } = deps;
  const r = await pool.query<{ id: string; lat: number; lng: number; max_radius_m: number }>(
    `SELECT id, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, max_radius_m
       FROM stands WHERE status = 'approved'`,
  );
  for (const s of r.rows) {
    const res = (await redis.call(
      'GEOSEARCH', redisKeys.geoAvailable,
      'FROMLONLAT', String(s.lng), String(s.lat),
      'BYRADIUS', String(s.max_radius_m), 'm',
      'ASC', 'COUNT', '200', 'WITHCOORD',
    )) as [string, [string, string]][];
    const ev: NearbyDriversEvent = {
      drivers: res.map(([id, [lng, lat]]): { id: string; location: LatLng } => ({
        id, location: { lat: Number(lat), lng: Number(lng) },
      })),
    };
    emitter.toStand(s.id, STAND_EVENTS.nearbyDrivers, ev);
  }
  return { stands: r.rows.length };
}
