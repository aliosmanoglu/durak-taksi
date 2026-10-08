// Nominatim yanıtından kısa, okunur adres üretir ("Moda Cd. 12, Kadıköy"). Saf; ağ çağrısı yok.

export type NominatimAddress = Partial<Record<string, string>>;

const abbreviate = (road: string): string =>
  road
    .replace(/\bCaddesi\b/gi, 'Cd.')
    .replace(/\bSokağı\b/gi, 'Sk.')
    .replace(/\bSokak\b/gi, 'Sk.')
    .replace(/\bBulvarı\b/gi, 'Blv.')
    .replace(/\bMahallesi\b/gi, 'Mh.');

export function formatNominatimAddress(addr: NominatimAddress | undefined, displayName?: string): string | null {
  if (addr) {
    const road = addr.road ?? addr.pedestrian ?? addr.footway ?? addr.residential;
    const street = road ? [abbreviate(road), addr.house_number].filter(Boolean).join(' ') : undefined;
    const area = addr.suburb ?? addr.neighbourhood ?? addr.quarter ?? addr.city_district ?? addr.town ?? addr.village;
    const district = addr.city_district ?? addr.county ?? addr.town;
    const parts = [street ?? addr.amenity ?? addr.building, area, district && district !== area ? district : undefined]
      .filter((p): p is string => !!p && p.length > 0);
    if (parts.length > 0) return [...new Set(parts)].join(', ').slice(0, 300);
  }
  const dn = displayName?.trim();
  return dn ? dn.slice(0, 300) : null;
}
