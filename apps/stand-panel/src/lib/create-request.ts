// `ride_create` idempotency kimliği (docs/design/faz5-resilience.md Bölüm 3). Saf mantık; yan etkisiz.
// Kural: aynı form içeriği için ack TIMEOUT sonrası AYNI `clientRequestId` ile yeniden denenir (sunucu ikinci
// çağrı açmaz, mevcut ride'ı döner). İçerik değiştiyse ya da kayıt eskidiyse yeni kimlik üretilir. Kimlik
// `pendingCreate` içinde yaşar: başarı / senkronla çözülme / TTL onu silince bir sonraki gönderim yeni kimlik alır
// (aynı adrese bilinçli ikinci çağrı eski ride'a bağlanmaz).

/** Zaman aşımı sonrası bekleyen oluşturmanın geçerlilik süresi (yeniden kullanım ve senkronla eşleştirme). */
export const PENDING_CREATE_TTL_MS = 60_000;
/** Ack zaman aşımında otomatik yeniden deneme sayısı (ilk gönderim hariç) ve araları. */
export const CREATE_AUTO_RETRIES = 1;
export const CREATE_AUTO_RETRY_DELAY_MS = 1_000;

export type CreatePayloadFields = {
  pickup: { lat: number; lng: number };
  pickupAddress: string;
  dropoff?: { lat: number; lng: number };
  dropoffAddress?: string;
  notes?: string;
};

/** Form içeriğinin karşılaştırılabilir imzası (kimlik yalnızca aynı içerik için yeniden kullanılır). */
export function createSignature(p: CreatePayloadFields): string {
  return JSON.stringify([
    p.pickup.lat,
    p.pickup.lng,
    p.pickupAddress,
    p.dropoff?.lat ?? null,
    p.dropoff?.lng ?? null,
    p.dropoffAddress ?? null,
    p.notes ?? null,
  ]);
}

export type PendingRequestId = { clientRequestId: string; signature: string; sentAtMs: number };

/** Bu içerik için bekleyen (zaman aşımına uğramış) bir gönderim var ve hâlâ taze mi? */
export function isRetryOfPending(
  pending: PendingRequestId | null | undefined,
  signature: string,
  now: number,
  ttlMs: number = PENDING_CREATE_TTL_MS,
): pending is PendingRequestId {
  return !!pending && pending.signature === signature && now - pending.sentAtMs <= ttlMs;
}

/** Gönderimde kullanılacak kimlik: taze + aynı içerik → eskisi; aksi hâlde yenisi. */
export function requestIdFor(
  pending: PendingRequestId | null | undefined,
  signature: string,
  now: number,
  gen: () => string = newClientRequestId,
): { id: string; retry: boolean } {
  return isRetryOfPending(pending, signature, now)
    ? { id: pending.clientRequestId, retry: true }
    : { id: gen(), retry: false };
}

/** Yalnızca ack zaman aşımı otomatik yeniden denenir; bağlantı koptuysa denenmez. */
export function shouldAutoRetry(code: string, attempt: number, connected: boolean): boolean {
  return code === 'TIMEOUT' && connected && attempt < CREATE_AUTO_RETRIES;
}

/** RFC 4122 v4. `crypto.randomUUID` yalnızca güvenli bağlamda vardır; yoksa `getRandomValues` ile üretilir. */
export function newClientRequestId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
