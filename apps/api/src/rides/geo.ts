import type { LatLng } from '@duraknet/shared';

/** Haversine (m); Redis GEO'nun kullandığı yer yarıçapıyla (6372797.56 m) uyumlu. */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6372797.560856;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
