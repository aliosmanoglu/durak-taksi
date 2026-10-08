// Push hattı (Faz 5, docs/design/faz5-resilience.md Bölüm 1). Push yalnızca bildirimdir: `ride_requested` socket
// event'iyle PARALEL gider, kabul her zaman `ride_accept` iledir. İçerik kilit ekranında görünür: adres/not YOK,
// yalnızca durak adı ve mesafe. Ticket `DeviceNotRegistered` → token temizlenir; makbuzlar gecikmeli job'la kontrol edilir.
import type { Queue } from 'bullmq';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { PUSH, type PushJobData } from '@duraknet/shared';
import type { WorkerMetrics } from '../metrics';
import type { PushMessage, PushSender } from './sender';

/** `push-receipts` job verisi: makbuzu beklenen ticket'lar ve gönderildikleri token'lar. */
export type PushReceiptJobData = { tickets: { id: string; token: string }[] };

export type PushServiceOptions = {
  pool: Pool;
  sender: PushSender;
  log: Logger;
  metrics: WorkerMetrics;
  /** Verilirse başarılı ticket'ların makbuzu `receiptDelayMs` sonra kontrol edilir. */
  receiptsQueue?: Queue<PushReceiptJobData>;
  ttlS?: number;
  receiptDelayMs?: number;
  /** Dispatch'in push'u bekleme üst sınırı (ms); aşılırsa dispatch beklemeden sürer. */
  dispatchTimeoutMs?: number;
};

export interface PushService {
  /** Yeni bildirilen adaylara `ride_requested` push'u. ASLA reddetmez (dispatch'i bozmaz); hata loglanır ve sayılır. */
  notifyRideRequested(input: {
    rideId: string;
    standName: string;
    drivers: { id: string; distanceM: number }[];
  }): Promise<void>;
  /** `push` kuyruğu job'ı. Gönderici hatasında reddeder (BullMQ yeniden dener). */
  processJob(data: PushJobData): Promise<void>;
  /** `push-receipts` job'ı: `DeviceNotRegistered` makbuzlarının token'ını temizler. */
  processReceipts(data: PushReceiptJobData): Promise<void>;
}

const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';
export const RECEIPT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: 100,
};

/** "{mesafe}": 1 km altı 10 m'ye yuvarlanmış metre, üstü ondalıklı km (Türkçe virgül). */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createPushService(opts: PushServiceOptions): PushService {
  const { pool, sender, log, metrics } = opts;
  const ttl = opts.ttlS ?? PUSH.TTL_S;
  const receiptDelayMs = opts.receiptDelayMs ?? PUSH.RECEIPT_DELAY_S * 1000;
  const dispatchTimeoutMs = opts.dispatchTimeoutMs ?? 10_000;

  const base = { channelId: PUSH.ANDROID_CHANNEL, priority: 'high', ttl, sound: 'default' } as const;

  const clearToken = (token: string) =>
    pool.query('UPDATE drivers SET push_token = NULL WHERE push_token = $1', [token]);

  /**
   * Gönderir, ticket hatalarını işler. Gönderici (ağ) hatasında reddeder. Dönen `retryable`: geçici başarısızlık
   * (ChunkFailed ya da tüm ticket'lar hata ve hiçbiri kalıcı `DeviceNotRegistered` değil); kuyruk job'ı bunda throw eder.
   */
  async function deliver(messages: PushMessage[]): Promise<{ retryable: boolean }> {
    if (messages.length === 0) return { retryable: false };
    const tickets = await sender.send(messages);
    const pending: { id: string; token: string }[] = [];
    let sent = 0;
    for (let i = 0; i < messages.length; i++) {
      const token = messages[i]!.to;
      const t = tickets[i];
      if (!t) continue;
      if (t.status === 'ok') {
        sent++;
        pending.push({ id: t.id, token });
      } else if (t.details?.error === DEVICE_NOT_REGISTERED) {
        metrics.pushTotal.inc({ result: 'device_not_registered' });
        await clearToken(token).catch((e: unknown) => log.warn({ err: errMsg(e) }, 'push token temizlenemedi'));
      } else {
        metrics.pushTotal.inc({ result: 'error' });
        // Token/kişi bilgisi loglanmaz; yalnızca Expo hata kodu.
        log.warn({ code: t.details?.error ?? 'unknown' }, 'push ticket hatası');
      }
    }
    if (sent > 0) metrics.pushTotal.inc({ result: 'sent' }, sent);
    const errors = tickets.filter((t) => t.status === 'error');
    const code = (t: (typeof tickets)[number]) => (t.status === 'error' ? t.details?.error : undefined);
    const retryable =
      errors.some((t) => code(t) === 'ChunkFailed') ||
      (errors.length === messages.length && !errors.some((t) => code(t) === DEVICE_NOT_REGISTERED));
    if (pending.length > 0 && opts.receiptsQueue) {
      await opts.receiptsQueue
        .add('receipts', { tickets: pending }, { ...RECEIPT_JOB_OPTS, delay: receiptDelayMs })
        .catch((e: unknown) => log.warn({ err: errMsg(e) }, 'push makbuz job\'ı eklenemedi'));
    }
    return { retryable };
  }

  async function rideRequestedMessages(input: {
    rideId: string;
    standName: string;
    drivers: { id: string; distanceM: number }[];
  }): Promise<PushMessage[]> {
    if (input.drivers.length === 0) return [];
    // Tek toplu sorgu: yalnızca token'ı olan, onaylı şoförler.
    const r = await pool.query<{ id: string; push_token: string }>(
      `SELECT id, push_token FROM drivers WHERE id = ANY($1::uuid[]) AND push_token IS NOT NULL AND status = 'approved'`,
      [input.drivers.map((d) => d.id)],
    );
    const dist = new Map(input.drivers.map((d) => [d.id, d.distanceM]));
    return r.rows.map((row) => ({
      ...base,
      to: row.push_token,
      title: 'Yeni çağrı',
      body: `${input.standName} · ${formatDistance(dist.get(row.id) ?? 0)}`,
      data: { type: 'ride_requested' as const, rideId: input.rideId },
    }));
  }

  return {
    async notifyRideRequested(input) {
      const work = (async () => {
        try {
          await deliver(await rideRequestedMessages(input));
        } catch (err) {
          metrics.pushTotal.inc({ result: 'failed' });
          log.warn({ err: errMsg(err), rideId: input.rideId }, 'ride_requested push gönderilemedi');
        }
      })();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          metrics.pushTotal.inc({ result: 'timeout' });
          log.warn({ rideId: input.rideId }, 'push gönderimi dispatch için beklenmedi (zaman aşımı)');
          resolve();
        }, dispatchTimeoutMs);
      });
      await Promise.race([work, timeout]);
      clearTimeout(timer);
    },

    async processJob(data) {
      try {
        const out = await deliver([{
          ...base,
          to: data.token,
          title: 'Hesabınız askıya alındı',
          body: 'Hesabınız yönetici tarafından askıya alındı.',
          data: { type: 'account_suspended' },
        }]);
        // Geçici başarısızlıkta job başarısız olur: BullMQ attempts/backoff ile yeniden dener.
        if (out.retryable) throw new Error('push gönderimi başarısız (geçici); yeniden denenecek');
      } catch (err) {
        metrics.pushTotal.inc({ result: 'failed' });
        throw err;
      }
    },

    async processReceipts(data) {
      const receipts = await sender.getReceipts(data.tickets.map((t) => t.id));
      for (const t of data.tickets) {
        const rec = receipts[t.id];
        if (!rec || rec.status !== 'error') continue;
        if (rec.details?.error === DEVICE_NOT_REGISTERED) {
          metrics.pushTotal.inc({ result: 'device_not_registered' });
          await clearToken(t.token);
        } else {
          metrics.pushTotal.inc({ result: 'receipt_error' });
          log.warn({ code: rec.details?.error ?? 'unknown' }, 'push makbuz hatası');
        }
      }
    },
  };
}
