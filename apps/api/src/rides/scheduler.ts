// Dispatch / hatırlatma job'larını kuyruğa alır (yalnızca üretici; zamanlama ve işleme worker'dadır).
// Kritik zamanlama Pub/Sub'da değil BullMQ'dadır. Job id'leri deterministiktir (idempotent): aynı tur için
// `add` tekrarlanırsa BullMQ ikinciyi yok sayar.
import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  jobIds, QUEUES, REMINDER, roundJobNumber,
  type DispatchJobData, type ReminderJobData,
} from '@duraknet/shared';

export interface DispatchScheduler {
  /**
   * Yeni arama turu başlatır: dalga 1 hemen, ilk `ride_still_open` hatırlatması `reminderFirstMs` sonra.
   * `searchVersion` = `searching`'e girişteki `rides.version`.
   */
  startSearch(rideId: string, searchVersion: number): Promise<void>;
  close(): Promise<void>;
}

const JOB_OPTS: JobsOptions = {
  removeOnComplete: true,
  removeOnFail: 100,
  attempts: 5,
  backoff: { type: 'exponential', delay: 500 },
};

export type SchedulerOptions = { reminderFirstMs?: number };

/** `connection`: BullMQ'nun kullanacağı ioredis bağlantısı (çağıran kapatır). */
export function createDispatchScheduler(connection: Redis, opts: SchedulerOptions = {}): DispatchScheduler {
  const dispatchQ = new Queue<DispatchJobData>(QUEUES.dispatch, { connection });
  const reminderQ = new Queue<ReminderJobData>(QUEUES.reminder, { connection });
  const reminderFirstMs = opts.reminderFirstMs ?? REMINDER.FIRST_SEC * 1000;
  return {
    async startSearch(rideId, searchVersion) {
      await dispatchQ.add(
        'wave',
        { rideId, searchVersion, wave: 1 },
        { ...JOB_OPTS, jobId: jobIds.dispatch(rideId, roundJobNumber(searchVersion, 1)) },
      );
      await reminderQ.add(
        'remind',
        { rideId, searchVersion, n: 1 },
        { ...JOB_OPTS, delay: reminderFirstMs, jobId: jobIds.reminder(rideId, roundJobNumber(searchVersion, 1)) },
      );
    },
    async close() {
      await Promise.allSettled([dispatchQ.close(), reminderQ.close()]);
    },
  };
}

export const noopScheduler: DispatchScheduler = { async startSearch() {}, async close() {} };
