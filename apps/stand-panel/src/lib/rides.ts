// Panelin ride görünümü (ViewModel) ve saf geçişleri. docs/design/faz3-dispatch.md Bölüm 2 ve 3.4.3.
// Kurallar: (1) gelen event'in `version`'ı eldekinden KÜÇÜKSE yok sayılır; (2) `session_sync` listeyi
// DEĞİŞTİRİR (birleştirmez); (3) terminal ride için hiçbir event uygulanmaz.
// Tüm zamanlar `nowMs`: sunucu saatine göre düzeltilmiş epoch ms (bkz. clock.ts).
import {
  TERMINAL_RIDE_STATUSES,
  type LatLng,
  type RideCancelledEvent,
  type RideCompletedEvent,
  type RideDriverCancelledEvent,
  type RideMatchedEvent,
  type RideSearchingEvent,
  type RideSnapshot,
  type RideStatus,
  type RideStillOpenEvent,
} from '@duraknet/shared';

/** Terminal kart kaç ms sonra "Son çağrılar"a taşınır. */
export const TERMINAL_VISIBLE_MS = 30_000;
export const ARCHIVE_MAX = 10;
/** Yeni oluşturulan ride'ın `session_sync` ile silinmemesi için tanınan süre (ack/sync yarışı). */
export const CREATE_GRACE_MS = 3_000;
export const FLASH_MS = 3_000;

export const DRIVER_SUSPENDED_REASON = 'driver_suspended';

export type DriverInfo = { id: string; name: string; plate: string; vehicle?: string; phone: string };

export type RideView = {
  rideId: string;
  shortCode: string;
  status: RideStatus;
  version: number;
  pickup?: LatLng;
  pickupAddress: string;
  dropoffAddress?: string;
  notes?: string;
  createdAt?: string;
  /** Arama başlangıcı (ISO). Şoför iptalinde ve her `ride_searching`'de yenilenir. */
  searchingSince?: string;
  matchedAt?: string;
  wave?: number;
  radiusM?: number;
  notifiedCount?: number;
  driver?: DriverInfo;
  /** Eşleşme anındaki kuş uçuşu mesafe. */
  distanceM?: number;
  /** Hatırlatma bandı açıksa dakika. */
  stillOpenMinutes?: number;
  driverCancelled?: { name: string; plate: string; reason?: string; suspended: boolean };
  cancelReason?: string;
  /** Zaman aşımı sonrası sonuç bilinmiyor rozeti. */
  unknown?: boolean;
  /** Event geldi ama ride'ın ayrıntıları (adres...) yerelde yok: `session_sync_request` ile doldurulur. */
  detailsMissing?: boolean;
  /** Terminale yerelde geçildiği an. */
  closedAtMs?: number;
  /** Yerelde oluşturulduğu / ilk görüldüğü an. */
  seenAtMs: number;
  flash?: { kind: 'matched' | 'still_open' | 'driver_cancelled'; untilMs: number };
};

export type ArchivedRide = { rideId: string; shortCode: string; pickupAddress: string; result: 'completed' | 'cancelled' };

export type RidesState = {
  rides: Record<string, RideView>;
  archive: ArchivedRide[];
  /** İlk `session_sync` geldi mi (iskelet kartlar için). */
  synced: boolean;
};

export const initialRidesState = (): RidesState => ({ rides: {}, archive: [], synced: false });

export const isTerminal = (s: RideStatus): boolean => TERMINAL_RIDE_STATUSES.includes(s);
export const isOpenRide = (r: RideView): boolean => !isTerminal(r.status);

/** Yeni kart üstte: createdAt (yoksa ilk görülme) azalan. */
export function orderedRides(state: RidesState): RideView[] {
  const key = (r: RideView) => (r.createdAt ? Date.parse(r.createdAt) || r.seenAtMs : r.seenAtMs);
  return Object.values(state.rides).sort((a, b) => key(b) - key(a) || b.seenAtMs - a.seenAtMs);
}

const iso = (ms: number) => new Date(ms).toISOString();

function placeholder(rideId: string, nowMs: number): RideView {
  return {
    rideId, shortCode: '', status: 'searching', version: 0, pickupAddress: '', detailsMissing: true, seenAtMs: nowMs,
  };
}

function put(state: RidesState, r: RideView): RidesState {
  return { ...state, rides: { ...state.rides, [r.rideId]: r } };
}

/**
 * Event uygulanabilir mi? Bilinmeyen ride her zaman uygulanabilir (placeholder açılır);
 * bilinen ride için terminal değilse ve sürüm eldekinden küçük değilse.
 */
export function acceptsEvent(existing: RideView | undefined, version: number): boolean {
  if (!existing) return true;
  if (isTerminal(existing.status)) return false;
  return version >= existing.version;
}

/** `ride_create` ack'i: ride varsa (event önce geldiyse) ayrıntıları doldurur, yoksa `created` açar. */
export function applyCreated(
  state: RidesState,
  input: {
    rideId: string; shortCode: string; pickup: LatLng; pickupAddress: string;
    dropoffAddress?: string; notes?: string;
  },
  nowMs: number,
): RidesState {
  const ex = state.rides[input.rideId];
  const details = {
    shortCode: input.shortCode, pickup: input.pickup, pickupAddress: input.pickupAddress,
    dropoffAddress: input.dropoffAddress, notes: input.notes, detailsMissing: false,
  };
  if (ex) return put(state, { ...ex, ...details, createdAt: ex.createdAt ?? iso(nowMs) });
  return put(state, {
    ...details, rideId: input.rideId, status: 'created', version: 0, createdAt: iso(nowMs), seenAtMs: nowMs,
  });
}

export function applySearching(state: RidesState, e: RideSearchingEvent, nowMs: number): RidesState {
  const ex = state.rides[e.rideId];
  if (!acceptsEvent(ex, e.version)) return state;
  const base = ex ?? placeholder(e.rideId, nowMs);
  return put(state, {
    ...base,
    status: 'searching',
    version: e.version,
    wave: e.wave,
    radiusM: e.radiusM,
    notifiedCount: e.notifiedCount,
    searchingSince: e.searchingSince,
    driver: undefined,
    distanceM: undefined,
    matchedAt: undefined,
    unknown: undefined,
  });
}

export function applyMatched(state: RidesState, e: RideMatchedEvent, nowMs: number): RidesState {
  const ex = state.rides[e.rideId];
  if (!acceptsEvent(ex, e.version)) return state;
  const base = ex ?? placeholder(e.rideId, nowMs);
  return put(state, {
    ...base,
    status: 'matched',
    version: e.version,
    driver: e.driver,
    distanceM: e.distanceM,
    matchedAt: iso(nowMs),
    stillOpenMinutes: undefined,
    driverCancelled: undefined,
    unknown: undefined,
    flash: { kind: 'matched', untilMs: nowMs + FLASH_MS },
  });
}

export function applyDriverCancelled(state: RidesState, e: RideDriverCancelledEvent, nowMs: number): RidesState {
  const ex = state.rides[e.rideId];
  if (!acceptsEvent(ex, e.version)) return state;
  const base = ex ?? placeholder(e.rideId, nowMs);
  return put(state, {
    ...base,
    status: 'searching',
    version: e.version,
    driver: undefined,
    distanceM: undefined,
    matchedAt: undefined,
    // Sayaç sıfırdan başlar; sonraki `ride_searching` kesin değeri getirir.
    searchingSince: iso(nowMs),
    driverCancelled: {
      name: e.driverName, plate: e.plate, reason: e.reason, suspended: e.reason === DRIVER_SUSPENDED_REASON,
    },
    unknown: undefined,
    flash: { kind: 'driver_cancelled', untilMs: nowMs + FLASH_MS },
  });
}

export function applyStillOpen(state: RidesState, e: RideStillOpenEvent, nowMs: number): RidesState {
  const ex = state.rides[e.rideId];
  if (!acceptsEvent(ex, e.version)) return state;
  const base = ex ?? placeholder(e.rideId, nowMs);
  if (base.status === 'matched') return state; // hatırlatma yalnızca aranan çağrı içindir
  return put(state, {
    ...base,
    status: 'searching',
    version: Math.max(base.version, e.version),
    searchingSince: e.searchingSince,
    stillOpenMinutes: e.minutesOpen,
    flash: { kind: 'still_open', untilMs: nowMs + FLASH_MS },
  });
}

function close(state: RidesState, rideId: string, version: number, status: 'completed' | 'cancelled', nowMs: number, reason?: string) {
  const ex = state.rides[rideId];
  if (!ex || !acceptsEvent(ex, version)) return state; // yerelde olmayan ride için kart açılmaz
  return put(state, {
    ...ex,
    status,
    version,
    closedAtMs: nowMs,
    cancelReason: status === 'cancelled' ? reason : undefined,
    stillOpenMinutes: undefined,
    driverCancelled: undefined,
    unknown: undefined,
    flash: undefined,
  });
}

export const applyCompleted = (s: RidesState, e: RideCompletedEvent, nowMs: number) =>
  close(s, e.rideId, e.version, 'completed', nowMs);

export const applyCancelled = (s: RidesState, e: RideCancelledEvent, nowMs: number) =>
  close(s, e.rideId, e.version, 'cancelled', nowMs, e.reason);

/** Kendi `ride_cancel` / `ride_complete` ack'i başarılıysa: ack, event ile aynı sonucu taşır (sürüm bilinmez). */
export function closeLocal(state: RidesState, rideId: string, status: 'completed' | 'cancelled', nowMs: number, reason?: string): RidesState {
  const ex = state.rides[rideId];
  if (!ex || isTerminal(ex.status)) return state;
  return close(state, rideId, ex.version, status, nowMs, reason);
}

export function dismissStillOpen(state: RidesState, rideId: string): RidesState {
  const ex = state.rides[rideId];
  return ex?.stillOpenMinutes === undefined ? state : put(state, { ...ex, stillOpenMinutes: undefined });
}

export function dismissDriverCancelled(state: RidesState, rideId: string): RidesState {
  const ex = state.rides[rideId];
  return ex?.driverCancelled ? put(state, { ...ex, driverCancelled: undefined }) : state;
}

export function setUnknown(state: RidesState, rideId: string, unknown: boolean): RidesState {
  const ex = state.rides[rideId];
  if (!ex || isTerminal(ex.status) || !!ex.unknown === unknown) return state;
  return put(state, { ...ex, unknown: unknown || undefined });
}

/**
 * `session_sync` / `session_sync_request` ack'i: aktif liste yerelin yerine geçer.
 * - Sunucuda olup yerelde olmayan eklenir; ikisinde de olan sunucu değerleriyle güncellenir
 *   (yereldeki sürüm daha yüksekse yerel korunur: sıra dışı gelen eski anlık görüntü geri almaz).
 * - Yerelde açık olup sunucuda olmayan ride silinir ve sayılır (`closed`); yeni oluşturulanlar
 *   `CREATE_GRACE_MS` boyunca korunur. Terminal kartlar süreleri dolana kadar kalır.
 */
export function applySessionSync(
  state: RidesState,
  snaps: readonly RideSnapshot[],
  nowMs: number,
  quietIds: ReadonlySet<string> = new Set(),
): { state: RidesState; closed: number } {
  const next: Record<string, RideView> = {};
  const inSync = new Set<string>();
  for (const s of snaps) {
    if (isTerminal(s.status)) continue;
    inSync.add(s.rideId);
    const ex = state.rides[s.rideId];
    if (ex && !ex.detailsMissing && !isTerminal(ex.status) && ex.version > s.version) {
      next[s.rideId] = ex;
      continue;
    }
    const same = ex && ex.status === s.status;
    next[s.rideId] = {
      rideId: s.rideId,
      shortCode: s.shortCode,
      status: s.status,
      version: s.version,
      pickup: s.pickup,
      pickupAddress: s.pickupAddress,
      dropoffAddress: s.dropoffAddress,
      notes: s.notes,
      createdAt: s.createdAt,
      matchedAt: s.matchedAt,
      driver: s.driver
        ? { id: s.driver.id, name: s.driver.name, plate: s.driver.plate, vehicle: s.driver.vehicle, phone: s.driver.phone }
        : undefined,
      // Anlık görüntüde `searchingSince` yok: yerelde varsa korunur, yoksa `createdAt`'e yaslanır.
      searchingSince: same ? ex.searchingSince ?? s.createdAt : s.status === 'searching' ? s.createdAt : undefined,
      wave: same ? ex.wave : undefined,
      radiusM: same ? ex.radiusM : undefined,
      notifiedCount: same ? ex.notifiedCount : undefined,
      distanceM: same ? ex.distanceM : undefined,
      stillOpenMinutes: same ? ex.stillOpenMinutes : undefined,
      driverCancelled: ex && s.status === 'searching' ? ex.driverCancelled : undefined,
      flash: ex?.flash,
      seenAtMs: ex?.seenAtMs ?? nowMs,
    };
  }
  let closed = 0;
  for (const r of Object.values(state.rides)) {
    if (inSync.has(r.rideId)) continue;
    if (isTerminal(r.status)) {
      next[r.rideId] = r;
    } else if (r.status === 'created' && nowMs - r.seenAtMs < CREATE_GRACE_MS) {
      next[r.rideId] = r;
    } else if (!r.detailsMissing && !quietIds.has(r.rideId)) {
      closed += 1;
    }
  }
  return { state: { ...state, rides: next, synced: true }, closed };
}

/** Süresi dolan terminal kartları "Son çağrılar"a taşır (en çok 10, yeni üstte). */
export function tickArchive(state: RidesState, nowMs: number): RidesState {
  const due = Object.values(state.rides).filter(
    (r) => isTerminal(r.status) && r.closedAtMs !== undefined && nowMs - r.closedAtMs >= TERMINAL_VISIBLE_MS,
  );
  if (due.length === 0) return state;
  const rides = { ...state.rides };
  const added: ArchivedRide[] = [];
  for (const r of due.sort((a, b) => (b.closedAtMs ?? 0) - (a.closedAtMs ?? 0))) {
    delete rides[r.rideId];
    added.push({
      rideId: r.rideId, shortCode: r.shortCode, pickupAddress: r.pickupAddress,
      result: r.status === 'completed' ? 'completed' : 'cancelled',
    });
  }
  return { ...state, rides, archive: [...added, ...state.archive].slice(0, ARCHIVE_MAX) };
}

/** Ayrıntısı yerelde olmayan (event ile gelmiş) ride'lar var mı? Varsa `session_sync_request` gerekir. */
export function needsDetailSync(state: RidesState): boolean {
  return Object.values(state.rides).some((r) => r.detailsMissing && !isTerminal(r.status));
}

/** Pin'e `thresholdM` içinde açık çağrı (yinelenen çağrı uyarısı). */
export function findDuplicate(
  state: RidesState,
  pin: LatLng,
  distance: (a: LatLng, b: LatLng) => number,
  thresholdM = 50,
): RideView | undefined {
  return orderedRides(state).find(
    (r) => isOpenRide(r) && r.pickup !== undefined && distance(r.pickup, pin) <= thresholdM,
  );
}
