// Geocoding soyut arayüzün arkasındadır (Q7): sağlayıcı değiştirmek için `geocoder` değişkenini
// başka bir `Geocoder` ile değiştirmek yeter. Varsayılan: Nominatim.
// Nominatim kullanım politikası: otomatik tamamlama yasaktır, saniyede en çok 1 istek. Bu yüzden
// arama yalnızca görevli ARA'ya bastığında yapılır; ters geocoding pin durunca tek istektir.
import type { LatLng } from '@duraknet/shared';
import { createPacer } from '../lib/pacer';
import { formatNominatimAddress, type NominatimAddress } from '../lib/geocode-format';
import { GEOCODER_URL } from './config';

export type GeoHit = { label: string; location: LatLng };

export interface Geocoder {
  /** Koordinat -> adres metni; bulunamazsa `null`. Hata/zaman aşımında reddeder. */
  reverse(p: LatLng, signal: AbortSignal): Promise<string | null>;
  /** Serbest metin -> adaylar (`near` yakınına öncelik). */
  search(query: string, near: LatLng, signal: AbortSignal): Promise<GeoHit[]>;
}

const pacer = createPacer(1_000);

/** Nominatim sınırı: istekler en az 1 sn arayla gider; beklerken iptal edilebilir. */
function pace(signal: AbortSignal): Promise<void> {
  const wait = pacer.reserve(Date.now());
  if (wait <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, wait);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type NominatimItem = { lat?: string; lon?: string; display_name?: string; address?: NominatimAddress };

class NominatimGeocoder implements Geocoder {
  constructor(private readonly base: string) {}

  async reverse(p: LatLng, signal: AbortSignal): Promise<string | null> {
    const url = `${this.base}/reverse?format=jsonv2&addressdetails=1&accept-language=tr&zoom=18&lat=${p.lat}&lon=${p.lng}`;
    await pace(signal);
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`geocode ${res.status}`);
    const j = (await res.json()) as NominatimItem & { error?: string };
    if (j.error) return null;
    return formatNominatimAddress(j.address, j.display_name);
  }

  async search(query: string, near: LatLng, signal: AbortSignal): Promise<GeoHit[]> {
    const d = 0.3; // ~30 km'lik görünüm kutusu: yakındakilere öncelik (sınırlamaz)
    const viewbox = `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`;
    const url =
      `${this.base}/search?format=jsonv2&addressdetails=1&accept-language=tr&countrycodes=tr&limit=5` +
      `&viewbox=${viewbox}&q=${encodeURIComponent(query)}`;
    await pace(signal);
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`geocode ${res.status}`);
    const arr = (await res.json()) as NominatimItem[];
    const out: GeoHit[] = [];
    for (const it of arr) {
      const lat = Number(it.lat);
      const lng = Number(it.lon);
      const label = formatNominatimAddress(it.address, it.display_name);
      if (label && Number.isFinite(lat) && Number.isFinite(lng)) out.push({ label, location: { lat, lng } });
    }
    return out;
  }
}

export const geocoder: Geocoder = new NominatimGeocoder(GEOCODER_URL);

/** `ms` sonra iptal eden sinyal (ters geocoding için 4 sn). `clear()` zamanlayıcıyı ve dinleyiciyi temizler. */
export function timeoutSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  const stop = () => {
    clearTimeout(t);
    ctl.abort();
  };
  if (parent) {
    if (parent.aborted) stop();
    else parent.addEventListener('abort', stop, { once: true });
  }
  return {
    signal: ctl.signal,
    clear: () => {
      clearTimeout(t);
      parent?.removeEventListener('abort', stop);
    },
  };
}
