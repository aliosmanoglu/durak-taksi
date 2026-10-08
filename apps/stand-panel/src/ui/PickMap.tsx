import { useEffect, useRef, useState, type ReactNode } from 'react';
import L from 'leaflet';
import { Circle, MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import type { LatLng } from '@duraknet/shared';
import type { MapVehicle } from '../lib/driver-locations';
import { distanceMeters } from '../lib/geo';
import { T } from '../lib/texts';
import { TILE_ATTRIBUTION, TILE_URL } from '../services/config';

export type MapTarget = { point: LatLng; nonce: number };

const svgIcon = (html: string, size: number, anchorY = size / 2) =>
  L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size / 2, anchorY] });

const taxiIcon = svgIcon(
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><rect x="2" y="9" width="20" height="9" rx="3" fill="#facc15" stroke="#1e293b" stroke-width="1.5"/><rect x="8" y="5" width="8" height="4" rx="1" fill="#1e293b"/><circle cx="7" cy="18" r="2.2" fill="#1e293b"/><circle cx="17" cy="18" r="2.2" fill="#1e293b"/></svg>',
  28,
);
const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Eşleşen araç: yeşil taksi + plaka etiketi; konum eskiyse soluk ve "!" işaretli. */
const vehicleIcons = new Map<string, L.DivIcon>();
/** plaka + eski/taze başına tek ikon (saniyede bir yeniden çizimde yeni divIcon üretilmez). */
const vehicleIcon = (plate: string, stale: boolean): L.DivIcon => {
  const key = plate + (stale ? '|s' : '|f');
  let icon = vehicleIcons.get(key);
  if (!icon) {
    icon = makeVehicleIcon(plate, stale);
    if (vehicleIcons.size > 200) vehicleIcons.clear();
    vehicleIcons.set(key, icon);
  }
  return icon;
};
const makeVehicleIcon = (plate: string, stale: boolean) =>
  L.divIcon({
    className: '',
    iconSize: [96, 48],
    iconAnchor: [48, 36],
    html:
      `<div style="display:flex;flex-direction:column;align-items:center;opacity:${stale ? 0.45 : 1}">` +
      `<span style="background:#065f46;color:#fff;font:700 12px monospace;padding:1px 6px;border-radius:6px;white-space:nowrap">${escapeHtml(plate)}${stale ? ' !' : ''}</span>` +
      '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><rect x="2" y="9" width="20" height="9" rx="3" fill="#10b981" stroke="#064e3b" stroke-width="1.5"/><rect x="8" y="5" width="8" height="4" rx="1" fill="#064e3b"/><circle cx="7" cy="18" r="2.2" fill="#064e3b"/><circle cx="17" cy="18" r="2.2" fill="#064e3b"/></svg></div>',
  });
const standIcon = svgIcon(
  '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#0f766e" stroke="#fff" stroke-width="2"/><text x="12" y="16.5" text-anchor="middle" font-size="13" font-weight="700" fill="#fff" font-family="sans-serif">D</text></svg>',
  30,
);
const flagIcon = (color: string) =>
  svgIcon(
    `<svg viewBox="0 0 24 34" width="28" height="40" aria-hidden="true"><path d="M12 33C12 33 2 20 2 12a10 10 0 0 1 20 0c0 8-10 21-10 21z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="#fff"/></svg>`,
    40,
    38,
  );
const pickupIcon = flagIcon('#1d4ed8');
const dropoffIcon = flagIcon('#ea580c');

/** Programatik `setView` ve kullanıcı hareketini ayırır; yalnızca kullanıcı hareketi `onCenter` çağırır. */
function Controller({
  target,
  vehicles,
  onCenter,
  onTile,
}: {
  target: MapTarget | null;
  vehicles: MapVehicle[];
  onCenter: (c: LatLng) => void;
  onTile: (ok: boolean) => void;
}) {
  const map = useMap();
  const programmatic = useRef<LatLng | null>(null);
  const lastNonce = useRef(0);
  const fitted = useRef(new Set<string>());

  // Eşleşen araç ilk göründüğünde (ride başına bir kez) harita, araç görünür olacak kadar uzaklaşır.
  // Merkez (= alış noktası pini) sabit kalır ve yalnızca uzaklaşılır; sonraki kullanıcı yakınlaştırması bozulmaz.
  useEffect(() => {
    const fresh = vehicles.filter((v) => !fitted.current.has(v.rideId));
    if (fresh.length === 0) return;
    for (const v of fresh) fitted.current.add(v.rideId);
    const c = map.getCenter();
    let dLat = 0;
    let dLng = 0;
    for (const v of vehicles) {
      dLat = Math.max(dLat, Math.abs(v.location.lat - c.lat));
      dLng = Math.max(dLng, Math.abs(v.location.lng - c.lng));
    }
    if (dLat === 0 && dLng === 0) return;
    const bounds = L.latLngBounds([c.lat - dLat, c.lng - dLng], [c.lat + dLat, c.lng + dLng]);
    const padding = L.point(48, 48);
    const zoom = map.getBoundsZoom(bounds, false, padding);
    if (zoom >= map.getZoom()) return;
    programmatic.current = { lat: c.lat, lng: c.lng };
    map.setView(c, zoom, { animate: false });
  }, [vehicles, map]);

  useEffect(() => {
    if (!target || target.nonce === lastNonce.current) return;
    lastNonce.current = target.nonce;
    programmatic.current = target.point;
    map.setView([target.point.lat, target.point.lng], Math.max(map.getZoom(), 16), { animate: false });
  }, [target, map]);

  useMapEvents({
    moveend: () => {
      const c = map.getCenter();
      const p = programmatic.current;
      if (p && distanceMeters(p, { lat: c.lat, lng: c.lng }) < 5) {
        programmatic.current = null;
        return;
      }
      programmatic.current = null;
      onCenter({ lat: c.lat, lng: c.lng });
    },
    tileload: () => onTile(true),
    tileerror: () => onTile(false),
  });
  return null;
}

export function PickMap({
  initialCenter,
  standLocation,
  maxRadiusM,
  drivers,
  vehicles = [],
  target,
  mode,
  pickup,
  dropoff,
  onCenter,
  children,
}: {
  initialCenter: LatLng;
  standLocation: LatLng;
  maxRadiusM: number;
  drivers: { id: string; location: LatLng }[];
  /** Eşleşmiş (matched) ride'ların araçları: yakındaki araçlardan ayrı renk + plaka etiketi. */
  vehicles?: MapVehicle[];
  target: MapTarget | null;
  mode: 'pickup' | 'dropoff';
  /** Dropoff modunda sabit gösterilen alış işareti. */
  pickup: LatLng | null;
  dropoff: LatLng | null;
  onCenter: (c: LatLng) => void;
  /** Haritanın üstüne bindirilen kontroller (KONUMUM vb.). */
  children?: ReactNode;
}) {
  const [tilesOk, setTilesOk] = useState(true);
  return (
    <div className="relative h-72 min-h-[240px] w-full overflow-hidden rounded-xl border-2 border-slate-400 lg:h-80" role="application" aria-label="Alış noktası haritası">
      <MapContainer
        center={[initialCenter.lat, initialCenter.lng]}
        zoom={16}
        scrollWheelZoom
        className="h-full w-full"
        attributionControl
      >
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
        <Controller target={target} vehicles={vehicles} onCenter={onCenter} onTile={setTilesOk} />
        <Marker position={[standLocation.lat, standLocation.lng]} icon={standIcon} interactive={false} />
        <Circle
          center={[standLocation.lat, standLocation.lng]}
          radius={maxRadiusM}
          pathOptions={{ color: '#0f766e', weight: 1.5, fillOpacity: 0.03, interactive: false }}
        />
        {drivers.map((d) => (
          <Marker key={d.id} position={[d.location.lat, d.location.lng]} icon={taxiIcon} interactive={false} />
        ))}
        {vehicles.map((v) => (
          <Marker
            key={v.rideId}
            position={[v.location.lat, v.location.lng]}
            icon={vehicleIcon(v.plate, v.stale)}
            zIndexOffset={500}
            interactive={false}
          />
        ))}
        {mode === 'dropoff' && pickup && <Marker position={[pickup.lat, pickup.lng]} icon={pickupIcon} interactive={false} />}
        {mode === 'pickup' && dropoff && <Marker position={[dropoff.lat, dropoff.lng]} icon={dropoffIcon} interactive={false} />}
      </MapContainer>

      {/* Ortada sabit pin; harita altında kayar (parmak pin'i örtmesin). Pin'in ucu tam merkezdedir. */}
      <div className="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center">
        <svg
          viewBox="0 0 24 34"
          width="40"
          height="56"
          style={{ transform: 'translateY(-50%)' }}
          role="img"
          aria-label={mode === 'pickup' ? T.map.pickupPin : T.map.dropoffPin}
        >
          <path
            d="M12 33C12 33 2 20 2 12a10 10 0 0 1 20 0c0 8-10 21-10 21z"
            fill={mode === 'pickup' ? '#1d4ed8' : '#ea580c'}
            stroke="#fff"
            strokeWidth="2"
          />
          <circle cx="12" cy="12" r="4" fill="#fff" />
        </svg>
      </div>

      {!tilesOk && (
        <div role="status" className="absolute left-2 top-2 z-[500] rounded-lg bg-yellow-100 px-3 py-2 text-base font-semibold text-yellow-950">
          {T.map.tilesFailed}
        </div>
      )}
      {children}
    </div>
  );
}
