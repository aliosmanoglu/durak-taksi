// vitest globalSetup (yalnızca 'integration' projesi): gerçek PostGIS + Redis konteynerleri
// tüm entegrasyon test dosyaları için bir kez başlatılır, migration uygulanır, bağlantı adresleri
// `inject('pgUrl' | 'redisUrl')` ile test dosyalarına verilir.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { runner } from 'node-pg-migrate';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
    redisUrl: string;
  }
}

// docker-compose.yml ile aynı imajlar.
const PG_IMAGE = 'postgis/postgis:16-3.4';
const REDIS_IMAGE = 'redis:7-alpine';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../migrations');

export default async function setup(project: TestProject) {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer(PG_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);

  // Üretimdeki `pnpm migrate:up` ile aynı yol: node-pg-migrate runner'ı SQL migration dosyasını okur.
  await runner({
    databaseUrl: pg.getConnectionUri(),
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: () => {},
  });

  project.provide('pgUrl', pg.getConnectionUri());
  project.provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.allSettled([pg.stop(), redis.stop()]);
  };
}
