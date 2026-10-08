# Kendi Nominatim sunucusu

1. Sunucu: ≥ 8 GB RAM, ~30 GB SSD. `docker compose -f docker-compose.nominatim.yml up -d`; `docker logs -f` ile içe aktarmanın bitmesini bekle (`Nominatim is ready`).
2. Doğrula: `curl "http://HOST:8088/search?q=Kadıköy&format=jsonv2&limit=1"` ve `/reverse?lat=41.0&lon=29.0&format=jsonv2`.
3. Panel tarayıcıdan çağırdığı için HTTPS + CORS gerekir: ters proxy (nginx/Caddy) arkasına koy, `Access-Control-Allow-Origin` değerini panel origin'i ile sınırla; `VITE_GEOCODER_URL=https://geocode.example.com` ile paneli derle.
4. Genel `nominatim.openstreetmap.org` üretimde kullanılmaz (kullanım politikası, veri aktarımı).
5. Güncelleme: `REPLICATION_URL` ile otomatik; disk büyümesini izle.
6. Türkçe adres kalitesi pilot öncesi 10–20 gerçek alış adresiyle denenmeli; zayıfsa görevli adresi elle düzeltir (panelde mevcut).
