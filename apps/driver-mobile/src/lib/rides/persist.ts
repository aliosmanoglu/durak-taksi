// Soğuk açılış için diske yazılan yolculuk özeti. SecureStore değer başına ~2 KB sınırı olan platformlar var
// (eski iOS/Android Keystore uyarıları); tam anlık görüntü (şoför, varış, notlar) yazılmaz. Özet, okuma tarafındaki
// `rideSnapshotSchema` doğrulamasını geçecek biçimde kalır (şemanın zorunlu alanları korunur).
import type { RideSnapshot } from '@duraknet/shared';

export const ACTIVE_RIDE_MAX_BYTES = 2048;
const NOTES_MAX = 80;

const byteLength = (s: string): number => new TextEncoder().encode(s).length;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

/** Yalnızca soğuk açılışta D2'yi göstermeye yeten alanlar. */
export function summarizeActiveRide(r: RideSnapshot): RideSnapshot {
  return {
    rideId: r.rideId,
    shortCode: r.shortCode,
    status: r.status,
    version: r.version,
    stand: { id: r.stand.id, name: r.stand.name, phone: r.stand.phone, location: r.stand.location },
    pickup: r.pickup,
    pickupAddress: r.pickupAddress,
    createdAt: r.createdAt,
    ...(r.notes ? { notes: clip(r.notes, NOTES_MAX) } : {}),
  };
}

/**
 * Diske yazılacak JSON; `maxBytes`'ı aşmaz. Sığmazsa sırayla notlar, adres ve durak adı kısaltılır; yine sığmazsa
 * `null` döner (çağıran anahtarı siler: eski yolculuk diskte kalmasın).
 */
export function serializeActiveRide(r: RideSnapshot, maxBytes = ACTIVE_RIDE_MAX_BYTES): string | null {
  const s = summarizeActiveRide(r);
  const fits = () => byteLength(JSON.stringify(s)) <= maxBytes;
  if (fits()) return JSON.stringify(s);
  delete s.notes;
  if (fits()) return JSON.stringify(s);
  for (const n of [200, 100, 50]) {
    s.pickupAddress = clip(s.pickupAddress, n);
    s.stand = { ...s.stand, name: clip(s.stand.name, n) };
    if (fits()) return JSON.stringify(s);
  }
  return null;
}
