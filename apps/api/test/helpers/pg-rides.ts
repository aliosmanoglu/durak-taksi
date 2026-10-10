// Faz 6 rapor/tutarlılık testleri için rides satırlarını doğrudan PG'ye ekleyen yardımcı.
// Zaman damgaları testin kontrolündedir (gün sınırı senaryoları); servis katmanı atlanır.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { RideStatus } from '@duraknet/shared';
import type { TestApp } from './app';

export type SeedRide = {
  standId: string;
  status: RideStatus;
  createdAt: string;
  searchingAt?: string | null;
  matchedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  driverId?: string | null;
  cancelReason?: string | null;
};

/** Eklenen ride'ın id ve short_code'unu döner. */
export async function seedRide(t: TestApp, r: SeedRide) {
  const shortCode = randomBytes(4).toString('hex'); // 8 karakter, UNIQUE
  const row = await t.db
    .insertInto('rides')
    .values({
      short_code: shortCode,
      stand_id: r.standId,
      driver_id: r.driverId ?? null,
      status: r.status,
      pickup_location: sql`ST_SetSRID(ST_MakePoint(29, 41), 4326)::geography`,
      pickup_address: 'Rapor Test Mah.',
      dropoff_location: null,
      dropoff_address: null,
      notes: null,
      current_radius_m: null,
      cancel_reason: r.cancelReason ?? null,
      client_request_id: null,
      last_driver_cancel_by: null,
      last_driver_cancel_version: null,
      created_at: sql`${r.createdAt}::timestamptz` as never,
      searching_at: (r.searchingAt ? new Date(r.searchingAt) : null),
      matched_at: (r.matchedAt ? new Date(r.matchedAt) : null),
      completed_at: (r.completedAt ? new Date(r.completedAt) : null),
      cancelled_at: (r.cancelledAt ? new Date(r.cancelledAt) : null),
    })
    .returning(['id', 'short_code'])
    .executeTakeFirstOrThrow();
  return { id: row.id, shortCode: row.short_code };
}

/** Testin ride'larını siler (FK: rides → stands/drivers; hesaplar t.cleanup() ile silinir). */
export async function deleteRidesOf(t: TestApp, standIds: string[]) {
  if (standIds.length) await t.db.deleteFrom('rides').where('stand_id', 'in', standIds).execute();
}

/** `base` ISO zamanına `s` saniye ekler. */
export const plusSec = (base: string, s: number) => new Date(new Date(base).getTime() + s * 1000).toISOString();
