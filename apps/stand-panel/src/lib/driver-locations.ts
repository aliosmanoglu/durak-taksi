// Eşleşen aracın canlı konumu (`ride_driver_location`, docs/design/faz3-dispatch.md 3.4.3 / 3.6).
// Saf fonksiyonlar; store `driverLocs` alanında tutar. Kurallar:
// - Yalnızca `matched` ride için konum kabul edilir; ride matched'tan çıkınca (completed / cancelled /
//   şoför iptali → searching) konum silinir (`pruneLocations`).
// - `ts` sunucuda (ride_driver_location yayınlanırken, API node'unun Date.now()'u) üretilir; çok node'lu kurulumda
//   node saatleri az sapabilir. Sıralama için `TS_SKEW_TOLERANCE_MS` toleransı vardır: eldekinden bu kadardan
//   fazla eski `ts` yok sayılır (tolerans içindeki sapma/sıra karışıklığı kabul edilir; konum zaten yenidir).
// - Konum kaydı şoförü taşır (`driverId`): ride başka şoföre geçtiyse eski şoförün konumu asla gösterilmez.
// - Tazelik, ts'e değil panelin ALIM zamanına (`receivedAtMs`) göre ölçülür: node saat sapması ts'i bozabilir.
// - `session_sync`'teki `driver.location` ilk konumdur (ts = 0: gelen ilk gerçek event onun yerine geçer).
import type { LatLng, RideDriverLocationEvent, RideSnapshot } from '@duraknet/shared';
import type { RidesState } from './rides';

/** Bu süre konum gelmezse simge soluk/eski gösterilir. */
export const LOCATION_STALE_MS = 20_000;

/** Eski `ts`ye bu kadar tolerans (node saat sapması). */
export const TS_SKEW_TOLERANCE_MS = 2_000;

export type DriverLoc = { driverId: string; location: LatLng; heading?: number; ts: number; receivedAtMs: number };
export type DriverLocs = Record<string, DriverLoc>;

export const initialDriverLocs = (): DriverLocs => ({});

export function applyDriverLocation(
  locs: DriverLocs,
  rides: RidesState,
  e: RideDriverLocationEvent,
  nowMs: number,
): DriverLocs {
  const ride = rides.rides[e.rideId];
  if (ride?.status !== 'matched' || !ride.driver) return locs;
  const ex = locs[e.rideId];
  if (ex && ex.driverId === ride.driver.id && e.ts < ex.ts - TS_SKEW_TOLERANCE_MS) return locs;
  return { ...locs, [e.rideId]: { driverId: ride.driver.id, location: e.location, heading: e.heading, ts: e.ts, receivedAtMs: nowMs } };
}

/** `session_sync`: eşleşmiş ride'ın `driver.location`'ı, yerelde konum yoksa ilk konum olur. */
export function seedFromSync(locs: DriverLocs, snaps: readonly RideSnapshot[], nowMs: number): DriverLocs {
  let next = locs;
  for (const s of snaps) {
    if (s.status !== 'matched' || !s.driver) continue;
    const ex = next[s.rideId];
    // Aynı şoförün yerel (canlı) konumu sunucu anlık görüntüsünden tazedir: korunur.
    if (ex && ex.driverId === s.driver.id) continue;
    if (next === locs) next = { ...locs };
    // Şoför değişmiş: eski şoförün konumu silinir; sunucudaki konum varsa onunla değiştirilir.
    if (s.driver.location) {
      next[s.rideId] = { driverId: s.driver.id, location: s.driver.location, ts: 0, receivedAtMs: nowMs };
    } else delete next[s.rideId];
  }
  return next;
}

/** Artık `matched` olmayan (ya da yerelde bilinmeyen) ride'ların konumunu siler. */
export function pruneLocations(locs: DriverLocs, rides: RidesState): DriverLocs {
  let next = locs;
  for (const id of Object.keys(locs)) {
    const r = rides.rides[id];
    if (r?.status === 'matched' && r.driver?.id === locs[id]!.driverId) continue;
    if (next === locs) next = { ...locs };
    delete next[id];
  }
  return next;
}

export const locationAgeMs = (l: DriverLoc, nowMs: number): number => Math.max(0, nowMs - l.receivedAtMs);
export const isLocationStale = (l: DriverLoc, nowMs: number): boolean => locationAgeMs(l, nowMs) >= LOCATION_STALE_MS;

export type MapVehicle = { rideId: string; plate: string; location: LatLng; heading?: number; stale: boolean; ageSec: number };

/** Haritada gösterilecek eşleşmiş araçlar (plaka ride'ın `driver`'ından). */
export function mapVehicles(locs: DriverLocs, rides: RidesState, nowMs: number): MapVehicle[] {
  const out: MapVehicle[] = [];
  for (const [rideId, l] of Object.entries(locs)) {
    const r = rides.rides[rideId];
    if (!r || r.status !== 'matched' || !r.driver) continue;
    out.push({
      rideId, plate: r.driver.plate, location: l.location, heading: l.heading,
      stale: isLocationStale(l, nowMs), ageSec: Math.floor(locationAgeMs(l, nowMs) / 1000),
    });
  }
  return out;
}
