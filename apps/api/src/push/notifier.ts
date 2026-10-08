// API tarafı push yan etkisi: `account_suspended` bildirimi BullMQ `push` kuyruğuna job olarak atılır
// (token iş verisine alınır; `expo-server-sdk` yalnızca worker'dadır). Hata isteği bozmaz.
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUES, type PushJobData } from '@duraknet/shared';

export interface PushNotifier {
  accountSuspended(token: string): Promise<void>;
  close(): Promise<void>;
}

/** `connection`: BullMQ'nun kullanacağı ioredis bağlantısı (`maxRetriesPerRequest: null`; çağıran kapatır). */
export function createPushNotifier(connection: Redis): PushNotifier {
  const queue = new Queue<PushJobData>(QUEUES.push, { connection });
  return {
    async accountSuspended(token) {
      await queue.add('account_suspended', { type: 'account_suspended', token }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 100,
      });
    },
    close: () => queue.close(),
  };
}
