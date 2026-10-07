// vitest globalSetup: worker entegrasyon testleri için yalnızca Redis konteyneri (api ile aynı imaj).
// Adres test dosyalarına `inject('redisUrl')` ile verilir.
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string;
  }
}

const REDIS_IMAGE = 'redis:7-alpine';

export default async function setup(project: TestProject) {
  const redis = await new RedisContainer(REDIS_IMAGE).start();
  project.provide('redisUrl', redis.getConnectionUrl());
  return async () => {
    await redis.stop();
  };
}
