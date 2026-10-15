import type { Redis } from 'ioredis';
import { redisKeys } from '@duraknet/shared';
import type { AdminSessionVersion } from './service';

/** Yönetici oturum sayacı Redis'te tutulur: tüm API node'ları aynı değeri görür, yeniden başlatma gerekmez. */
export function redisAdminSession(redis: Redis): AdminSessionVersion {
  return {
    get: async () => Number((await redis.get(redisKeys.adminTokenVersion)) ?? 0),
    bump: async () => redis.incr(redisKeys.adminTokenVersion),
  };
}
