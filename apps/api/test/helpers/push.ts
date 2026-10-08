// Faz 5 testleri için sahte PushSender. Gerçek Expo'ya hiç gitmez; gönderilenleri kaydeder ve token bazında
// ticket hatası (ör. DeviceNotRegistered) ya da toplu gönderim hatası enjekte edebilir.
// NOT: arayüz biçimi backend'in `apps/worker/src/push/` tanımına göre burada tek yerde uyarlanır.
export type FakePushMessage = {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  sound?: string | null;
  priority?: string;
  ttl?: number;
  channelId?: string;
};
export type FakePushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

export class FakePushSender {
  /** Başarılı/başarısız fark etmeksizin send'e verilen tüm mesajlar. */
  readonly sent: FakePushMessage[] = [];
  /** token -> Expo hata kodu (ticket hatası). */
  readonly ticketErrors = new Map<string, string>();
  /** true ise send() reddeder (Expo erişilemiyor). */
  failAll = false;
  /** receipt kontrolü için: ticket id -> hata kodu. */
  readonly receiptErrors = new Map<string, string>();
  /** token -> son ticket id'si (makbuz hatası enjekte etmek için). */
  readonly ticketIds = new Map<string, string>();
  private n = 0;

  async send(messages: FakePushMessage[]): Promise<FakePushTicket[]> {
    if (this.failAll) throw new Error('sahte Expo erişilemiyor');
    this.sent.push(...messages);
    return messages.map((m): FakePushTicket => {
      const err = this.ticketErrors.get(m.to);
      if (err) return { status: 'error', message: err, details: { error: err } };
      const id = `ticket-${++this.n}`;
      this.ticketIds.set(m.to, id);
      return { status: 'ok', id };
    });
  }

  async getReceipts(ids: string[]) {
    return Object.fromEntries(
      ids.map((id) => {
        const err = this.receiptErrors.get(id);
        return [id, err ? { status: 'error', message: err, details: { error: err } } : { status: 'ok' }];
      }),
    );
  }

  to(token: string) {
    return this.sent.filter((m) => m.to === token);
  }
  clear() {
    this.sent.length = 0;
  }
}

let seq = 0;
/** Benzersiz geçerli Expo token'ı. */
export const uniquePushToken = () =>
  `ExponentPushToken[t${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 8)}]`;
