# Durak paneli (`@duraknet/stand-panel`)

React + Vite + Tailwind. Komutlar kökteki `CLAUDE.md` içindedir.

## Dağıtım notu: Content-Security-Policy (öneri)

CSP `index.html`'e değil, paneli sunan web sunucusunun/CDN'in yanıt başlığına konur (kod değişikliği gerekmez).
`connect-src` ve `img-src` değerlerini derleme zamanı adresleriyle (`VITE_API_URL`, `VITE_TILE_URL`,
`VITE_GEOCODER_URL`) eşleştirin. Örnek (API `https://api.example.com`, varsayılan OSM karoları ve Nominatim):

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org;
  connect-src 'self' https://api.example.com wss://api.example.com https://nominatim.openstreetmap.org;
  media-src 'self' data: blob:;
  worker-src 'self';
  manifest-src 'self';
  object-src 'none';
  base-uri 'self';
  frame-ancestors 'none';
  form-action 'self'
```

Notlar: Leaflet satır içi stil yazdığı için `style-src 'unsafe-inline'` gerekir; `script-src` satır içi betiğe
izin vermez (Vite üretim çıktısında satır içi betik yoktur; yine de dağıtımdan önce tarayıcı konsolunda
ihlal olup olmadığını doğrulayın). Refresh token `localStorage`'da tutulduğundan XSS yüzeyini CSP ile daraltmak
önemlidir. Özel karo/geocoding sağlayıcısına geçilirse ilgili alan adlarını ekleyin.
