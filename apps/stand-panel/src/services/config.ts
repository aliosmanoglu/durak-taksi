// Derleme zamanı yapılandırması (Vite `VITE_*`). Bkz. apps/stand-panel/.env.example.
const env = import.meta.env as Record<string, string | undefined>;

/** API tabanı; boşsa sayfanın origin'i (aynı alan adı arkasında dağıtımda). Sondaki `/` atılır. */
export const API_URL = (env.VITE_API_URL?.trim() || window.location.origin).replace(/\/+$/, '');

export const TILE_URL = env.VITE_TILE_URL?.trim() || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION = '&copy; OpenStreetMap';

export const GEOCODER_URL = (env.VITE_GEOCODER_URL?.trim() || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');

export const APP_VERSION = '0.1.0';

export const ACK_TIMEOUT_MS = 10_000;
export const HTTP_TIMEOUT_MS = 15_000;
