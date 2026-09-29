import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { LatLng } from '@duraknet/shared';
import type { Database } from './types';

export type Db = Kysely<Database>;

export function createDb(connectionString: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString });
  return { db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), pool };
}

// PostGIS nokta sırası (lng, lat)'tır.
export const toGeography = (p: LatLng) =>
  sql<unknown>`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`;

export const latOf = (col: string) => sql<number>`ST_Y(${sql.ref(col)}::geometry)`;
export const lngOf = (col: string) => sql<number>`ST_X(${sql.ref(col)}::geometry)`;

export function isUniqueViolation(err: unknown): err is { code: '23505'; constraint?: string } {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23503';
}
