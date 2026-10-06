import type { LatLng } from '@duraknet/shared';

export type RecentAddress = { address: string; location: LatLng };
export const RECENT_MAX = 5;

const key = (a: string) => a.trim().toLocaleLowerCase('tr');

/** Yeni adresi başa ekler; aynı adres (büyük/küçük harf duyarsız) tekrarlanmaz; en çok 5. */
export function pushRecent(list: readonly RecentAddress[], item: RecentAddress): RecentAddress[] {
  const address = item.address.trim();
  if (!address) return [...list];
  const rest = list.filter((r) => key(r.address) !== key(address));
  return [{ address, location: item.location }, ...rest].slice(0, RECENT_MAX);
}

/** localStorage'dan okunan bozuk/eski veriye karşı doğrulama. */
export function parseRecent(raw: unknown): RecentAddress[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentAddress[] = [];
  for (const r of raw) {
    const o = r as { address?: unknown; location?: { lat?: unknown; lng?: unknown } } | null;
    if (
      o &&
      typeof o.address === 'string' &&
      o.address.trim() &&
      typeof o.location?.lat === 'number' &&
      typeof o.location.lng === 'number' &&
      Number.isFinite(o.location.lat) &&
      Number.isFinite(o.location.lng)
    ) {
      out.push({ address: o.address, location: { lat: o.location.lat, lng: o.location.lng } });
    }
  }
  return out.slice(0, RECENT_MAX);
}
