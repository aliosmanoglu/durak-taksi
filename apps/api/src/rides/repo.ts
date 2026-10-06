// Ride okumaları (snapshot / istek). Yalnızca okur; durum değişikliği state-machine.ts'tedir.
// Şoför konumu Redis'te olduğu için snapshot'a servis katmanında eklenir.
import type { LatLng, RideRequest, RideSnapshot, RideStatus } from '@duraknet/shared';
import { latOf, lngOf, type Db } from '../db';

export type RideRow = {
  rideId: string;
  shortCode: string;
  status: RideStatus;
  version: number;
  standId: string;
  standName: string;
  standPhone: string;
  standLocation: LatLng;
  pickup: LatLng;
  pickupAddress: string;
  dropoff: LatLng | null;
  dropoffAddress: string | null;
  notes: string | null;
  createdAt: Date;
  matchedAt: Date | null;
  driver: { id: string; name: string; plate: string; vehicle?: string; phone: string } | null;
};

export type RideFilter =
  | { kind: 'ids'; ids: string[] }
  | { kind: 'standOpen'; standId: string }
  | { kind: 'driverMatched'; driverId: string };

export async function fetchRideRows(db: Db, filter: RideFilter): Promise<RideRow[]> {
  if (filter.kind === 'ids' && filter.ids.length === 0) return [];
  let q = db
    .selectFrom('rides as r')
    .innerJoin('stands as s', 's.id', 'r.stand_id')
    .leftJoin('drivers as d', 'd.id', 'r.driver_id')
    .select([
      'r.id as rideId', 'r.short_code as shortCode', 'r.status', 'r.version', 'r.stand_id as standId',
      's.name as standName', 's.phone as standPhone',
      'r.pickup_address as pickupAddress', 'r.dropoff_address as dropoffAddress', 'r.notes',
      'r.created_at as createdAt', 'r.matched_at as matchedAt',
      'd.id as driverId', 'd.full_name as driverName', 'd.plate as driverPlate',
      'd.vehicle_model as vehicleModel', 'd.vehicle_color as vehicleColor', 'd.phone as driverPhone',
      latOf('r.pickup_location').as('pLat'), lngOf('r.pickup_location').as('pLng'),
      latOf('s.location').as('sLat'), lngOf('s.location').as('sLng'),
      latOf('r.dropoff_location').as('dLat'), lngOf('r.dropoff_location').as('dLng'),
    ])
    .orderBy('r.created_at', 'asc');
  if (filter.kind === 'ids') q = q.where('r.id', 'in', filter.ids);
  else if (filter.kind === 'standOpen') q = q.where('r.stand_id', '=', filter.standId).where('r.status', 'in', ['searching', 'matched']);
  else q = q.where('r.driver_id', '=', filter.driverId).where('r.status', '=', 'matched');

  return (await q.execute()).map((r) => {
    const vehicle = [r.vehicleModel, r.vehicleColor].filter(Boolean).join(' ');
    const dLat = r.dLat as number | null;
    const dLng = r.dLng as number | null;
    return {
      rideId: r.rideId, shortCode: r.shortCode, status: r.status, version: r.version,
      standId: r.standId, standName: r.standName, standPhone: r.standPhone,
      standLocation: { lat: Number(r.sLat), lng: Number(r.sLng) },
      pickup: { lat: Number(r.pLat), lng: Number(r.pLng) },
      pickupAddress: r.pickupAddress, dropoffAddress: r.dropoffAddress, notes: r.notes,
      dropoff: dLat != null && dLng != null ? { lat: Number(dLat), lng: Number(dLng) } : null,
      createdAt: new Date(r.createdAt as unknown as Date),
      matchedAt: r.matchedAt ? new Date(r.matchedAt as unknown as Date) : null,
      driver: r.driverId
        ? {
            id: r.driverId, name: r.driverName ?? '', plate: r.driverPlate ?? '',
            ...(vehicle ? { vehicle } : {}), phone: r.driverPhone ?? '',
          }
        : null,
    };
  });
}

/** Sözleşme: opsiyonel alanlar `null` değil, hiç yazılmaz. */
export function toSnapshot(row: RideRow, driverLocation?: LatLng): RideSnapshot {
  return {
    rideId: row.rideId, shortCode: row.shortCode, status: row.status, version: row.version,
    stand: { id: row.standId, name: row.standName, phone: row.standPhone, location: row.standLocation },
    pickup: row.pickup, pickupAddress: row.pickupAddress,
    ...(row.dropoff ? { dropoff: row.dropoff } : {}),
    ...(row.dropoffAddress ? { dropoffAddress: row.dropoffAddress } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    ...(row.driver ? { driver: { ...row.driver, ...(driverLocation ? { location: driverLocation } : {}) } } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.matchedAt ? { matchedAt: row.matchedAt.toISOString() } : {}),
  };
}

export function toRequest(row: RideRow, distanceM: number): RideRequest {
  return {
    rideId: row.rideId, shortCode: row.shortCode, pickup: row.pickup, pickupAddress: row.pickupAddress,
    ...(row.dropoffAddress ? { dropoffAddress: row.dropoffAddress } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    standName: row.standName, distanceM: Math.round(distanceM),
    createdAt: row.createdAt.toISOString(), version: row.version,
    serverNow: new Date().toISOString(),
  };
}
