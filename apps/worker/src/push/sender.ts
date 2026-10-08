// Push gönderici arayüzü (Faz 5). Gerçek uygulama Expo'dur; testler ve yerel geliştirme sahte uygulama enjekte eder.
// Biçimler Expo'nun kendi ticket/receipt biçimiyle uyumludur (`details.error` hata kodu).
import { Expo, type ExpoPushMessage, type ExpoPushReceipt, type ExpoPushTicket } from 'expo-server-sdk';
import type { PushDataType } from '@duraknet/shared';

export type PushMessage = {
  /** Expo push token'ı. */
  to: string;
  title: string;
  body: string;
  /** Kilit ekranında görünmeyen veri; kabul için güvenilmez (kabul her zaman `ride_accept`). */
  data: { type: PushDataType; rideId?: string };
  channelId: string;
  priority: 'high';
  ttl: number;
  sound: 'default';
};

export type PushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

export type PushReceipt =
  | { status: 'ok' }
  | { status: 'error'; message?: string; details?: { error?: string } };

export interface PushSender {
  /** Mesajları gönderir; dönen ticket'lar `messages` ile aynı sırada ve uzunluktadır. Ağ/servis hatasında reddeder. */
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  /** Ticket id'lerinin makbuzlarını getirir (henüz hazır olmayanlar sonuçta bulunmaz). */
  getReceipts(ids: string[]): Promise<Record<string, PushReceipt>>;
}

/** Expo Push Service uygulaması: 100'lük chunk'lar, isteğe bağlı erişim token'ı. */
export class ExpoPushSender implements PushSender {
  private readonly expo: Expo;

  constructor(opts: { accessToken?: string } = {}) {
    this.expo = new Expo(opts.accessToken ? { accessToken: opts.accessToken } : {});
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    // chunkPushNotifications sırayı korur; chunk başına dönen ticket'lar chunk sırasındadır.
    for (const chunk of this.expo.chunkPushNotifications(messages as ExpoPushMessage[])) {
      try {
        const res: ExpoPushTicket[] = await this.expo.sendPushNotificationsAsync(chunk);
        tickets.push(...(res as PushTicket[]));
      } catch (err) {
        // Chunk tamamen başarısız: her mesaj için hata ticket'ı (token silinmez; kod DeviceNotRegistered değil).
        const message = err instanceof Error ? err.message : String(err);
        tickets.push(...chunk.map((): PushTicket => ({ status: 'error', message, details: { error: 'ChunkFailed' } })));
      }
    }
    return tickets;
  }

  async getReceipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    const out: Record<string, PushReceipt> = {};
    for (const chunk of this.expo.chunkPushNotificationReceiptIds(ids)) {
      const res: Record<string, ExpoPushReceipt> = await this.expo.getPushNotificationReceiptsAsync(chunk);
      Object.assign(out, res);
    }
    return out;
  }
}

