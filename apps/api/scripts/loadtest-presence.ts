/**
 * Faz 2 kabul kriteri yük betiği (CI DIŞI, elle çalıştırılır):
 *   "2 API node'u arkasında 500 simüle şoför 3 sn aralıkla konum gönderirken p95 işleme < 50 ms".
 *
 * KULLANIM (kökten; iki API node'u aynı PG + Redis'e bağlı ve çalışır durumda olmalı):
 *   pnpm --filter @duraknet/api exec tsx --env-file=../../.env scripts/loadtest-presence.ts
 * Ortam değişkenleri:
 *   DATABASE_URL        (zorunlu)  şoförler doğrudan buraya `approved` olarak eklenir. Host localhost/127.0.0.1/::1
 *                                  değilse ALLOW_REMOTE_DB=1 olmadan betik çalışmaz (yanlışlıkla üretim DB'sine yazmasın).
 *   JWT_ACCESS_SECRET   (zorunlu)  API node'larıyla AYNI olmalı; access token'lar betikte imzalanır
 *   REDIS_URL           (önerilir) yoksa yalnızca go_online ack süresi ölçülür
 *   API_URLS            varsayılan "http://127.0.0.1:3000,http://127.0.0.1:3001"; şoförler round-robin dağıtılır
 *   N=500  DURATION_S=60  INTERVAL_MS=3000  ALLOW_REMOTE_DB=1 (isteğe bağlı)
 *
 * HESAP HAZIRLIĞI: REST ile 500 kayıt + onay + giriş, kayıt/giriş hız sınırlarına (IP bazlı) takılır ve argon2
 * yüzünden dakikalar sürer. Bu yüzden betik şoförleri doğrudan DB'ye `approved` ekler (password_hash sahte:
 * bu hesaplarla şifreyle giriş yapılamaz) ve access token'ı `issueTokens` ile imzalar (tv=0). Telefonlar
 * +90599… kurgusaldır. Bitişte, hata olsa da, SIGINT/SIGTERM (Ctrl+C) gelse de eklediği şoförleri DB'den ve
 * Redis'ten siler (full_name = license_no = 'LOADTEST').
 *
 * NE ÖLÇÜLÜR / SINIRLAR — bu betik "p95 işleme < 50 ms" kriterini KANITLAMAZ:
 *  1. `driver_go_online` ack round-trip (p50/p95/p99): ağ + socket.io + durum kontrolü (PG) + Lua + ack.
 *     Bağlanma dalgası sırasında ölçülür (konum yükü altında değil); konum işleme süresinin vekili değildir.
 *  2. `driver_location_update` ack'sizdir. Her güncelleme benzersiz bir enlemle gönderilir; örnekleyici 100 ms'de
 *     bir tüm şoförlerin `dn:driver:{id}` hash'ini okur. Enlem göründüğünde:
 *       - entry = updatedAt − gönderim anı. Sunucu updatedAt'i handler GİRİŞİNDE, Lua'dan ÖNCE `Date.now()` ile
 *         alır; bu değer istemci→sunucu ağı + socket.io çözümleme + handler'a giriş gecikmesidir, Lua/Redis
 *         işleme süresini İÇERMEZ. Aynı makinede (veya NTP senkron saatle) çalıştırılmalıdır.
 *       - seen = örnekleme anı − gönderim anı: işlemeyi de içeren ÜST SINIR, ama +≤100 ms örnekleme
 *         çözünürlüğü ve örnekleyicinin kendi Redis gecikmesi eklenir; 50 ms eşiğine karşı karar vermek için kaba.
 *     Bir sonraki gönderime kadar hiç görünmeyen güncelleme "görünmeyen/düşen" sayılır (throttle veya hata).
 *  3. KESİN KANIT (Faz 6): `METRICS_URL` verilirse betik, yük öncesi ve sonrası API node'larının /metrics
 *     çıktısından `duraknet_location_update_seconds` histogramını okur ve farktan sunucu içi p50/p95/p99'u basar
 *     (kova içi doğrusal interpolasyon; 50 ms bir kova sınırıdır, "≤ 50 ms oranı" ayrıca yazılır). Bu, 1. ve 2.
 *     maddedeki dolaylı ölçümlerin yerini alan kabul ölçümüdür.
 *       METRICS_URL    virgülle ayrılmış /metrics adresleri (her API node'u için; ör. http://127.0.0.1:3000/metrics,...)
 *       METRICS_TOKEN  node'daki `METRICS_TOKEN` ile aynı Bearer token (node'da tanımsızsa METRICS_ALLOW_ANON=true gerekir)
 *     Yük öncesi taban çizgisi alınır, böylece süreç ömrü boyunca birikmiş eski örnekler sonucu bozmaz; yine de
 *     ölçüm sırasında node'lara başka konum trafiği gelmemelidir.
 *  Tek istemci süreci 500 socket'i sürer; istemci event loop gecikmesi ölçümlere eklenir.
 */
import { randomInt } from 'node:crypto';
import { Redis } from 'ioredis';
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import { DRIVER_EVENTS, redisKeys, type Ack } from '@duraknet/shared';
import { issueTokens } from '../src/auth/tokens';

const env = process.env;
const DATABASE_URL = env.DATABASE_URL;
const ACCESS_SECRET = env.JWT_ACCESS_SECRET;
if (!DATABASE_URL || !ACCESS_SECRET) {
  console.error('DATABASE_URL ve JWT_ACCESS_SECRET gerekli (bkz. dosya başı).');
  process.exit(1);
}

// Yanlışlıkla uzak (ör. üretim) veritabanına yazmayı engelle.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
let dbHost: string;
try {
  dbHost = new URL(DATABASE_URL).hostname;
} catch {
  console.error('DATABASE_URL ayrıştırılamadı.');
  process.exit(1);
}
if (!LOCAL_HOSTS.has(dbHost) && env.ALLOW_REMOTE_DB !== '1') {
  console.error(`DATABASE_URL yerel değil (${dbHost}). Bilerek çalıştırıyorsanız ALLOW_REMOTE_DB=1 verin.`);
  process.exit(1);
}

const API_URLS = (env.API_URLS ?? 'http://127.0.0.1:3000,http://127.0.0.1:3001').split(',').map((s) => s.trim());
const N = Number(env.N ?? 500);
const DURATION_S = Number(env.DURATION_S ?? 60);
const INTERVAL_MS = Number(env.INTERVAL_MS ?? 3000);
const TAG = 'LOADTEST';
const METRICS_URLS = (env.METRICS_URL ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const METRICS_TOKEN = env.METRICS_TOKEN;
const HIST = 'duraknet_location_update_seconds';

// ---- /metrics histogram okuma (sunucu içi gecikme) ----
/** Tüm URL'lerden histogram kovalarını (le -> kümülatif sayı) toplar; ulaşılamayan URL hata fırlatır. */
async function scrapeHistogram(): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const url of METRICS_URLS) {
    const res = await fetch(url, { headers: METRICS_TOKEN ? { authorization: `Bearer ${METRICS_TOKEN}` } : {} });
    if (!res.ok) throw new Error(`/metrics ${res.status} döndü (${url}); METRICS_TOKEN / METRICS_ALLOW_ANON kontrol edin`);
    for (const line of (await res.text()).split('\n')) {
      if (!line.startsWith(`${HIST}_bucket`)) continue;
      const le = /le="([^"]+)"/.exec(line)?.[1];
      const val = Number(line.slice(line.lastIndexOf(' ') + 1));
      if (le === undefined || Number.isNaN(val)) continue;
      const k = le === '+Inf' ? Infinity : Number(le);
      out.set(k, (out.get(k) ?? 0) + val);
    }
  }
  return out;
}

/** Kümülatif kova sayılarından kuantil (kova içinde doğrusal interpolasyon). En büyük sonlu kovanın üstü: Infinity. */
function bucketQuantile(buckets: Map<number, number>, q: number): number {
  const bs = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const total = bs.length ? bs[bs.length - 1]![1] : 0;
  if (!total) return NaN;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const [le, count] of bs) {
    if (count >= rank) {
      if (le === Infinity) return Infinity;
      return count === prevCount ? le : prevLe + ((le - prevLe) * (rank - prevCount)) / (count - prevCount);
    }
    prevLe = le;
    prevCount = count;
  }
  return Infinity;
}

const BASE = { lat: 41.0082, lng: 28.9784 };

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const summary = (name: string, xs: number[]) =>
  console.log(
    `${name.padEnd(30)} n=${String(xs.length).padStart(6)}  p50=${pct(xs, 50).toFixed(1)}  p95=${pct(xs, 95).toFixed(1)}  p99=${pct(xs, 99).toFixed(1)}  max=${xs.length ? Math.max(...xs).toFixed(1) : 'NaN'} ms`,
  );

type Sim = { id: string; token: string; socket?: Socket; seq: number; pending?: { lat: string; sentAt: number; ts: number } };

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const redis = env.REDIS_URL ? new Redis(env.REDIS_URL) : null;
const sims: Sim[] = [];
const timers: NodeJS.Timeout[] = [];
let sampling = false;

// ---- Temizlik: tek sefer çalışır; normal bitiş, hata ve sinyalde çağrılır ----
let cleanupPromise: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    sampling = false;
    timers.forEach((t) => clearTimeout(t));
    for (const s of sims) s.socket?.close();
    const ids = sims.map((s) => s.id);
    try {
      if (redis && ids.length) {
        const m = redis.multi();
        m.zrem(redisKeys.geoAvailable, ...ids);
        m.zrem(redisKeys.heartbeat, ...ids);
        for (const id of ids) m.del(redisKeys.driver(id), redisKeys.locationThrottle(id), redisKeys.driverRequests(id));
        await m.exec();
      }
    } catch (e) {
      console.error('Redis temizliği başarısız:', e instanceof Error ? e.message : e);
    }
    try {
      // Önceki yarıda kalmış koşulardan kalanlar da etiketle silinir.
      const r = await pool.query(`DELETE FROM drivers WHERE full_name = $1 AND license_no = $1`, [TAG]);
      console.log(`temizlik: ${r.rowCount ?? 0} LOADTEST şoförü silindi`);
    } catch (e) {
      console.error('DB temizliği başarısız:', e instanceof Error ? e.message : e);
    }
    await Promise.allSettled([pool.end(), redis?.quit()]);
  })();
  return cleanupPromise;
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    console.log(`\n${sig} alındı; temizleniyor…`);
    void cleanup().finally(() => process.exit(130));
  });
}

async function main() {
  // Sunucu içi histogram taban çizgisi (yük öncesi). Ulaşılamazsa betik yükü başlatmadan hata verir.
  const metricsBefore = METRICS_URLS.length ? await scrapeHistogram() : null;

  // ---- 1) Hesaplar ----
  console.log(`${N} şoför ekleniyor (DB host: ${dbHost})…`);
  for (let i = 0; i < N; i += 100) {
    const batch = Math.min(100, N - i);
    const values: string[] = [];
    const params: string[] = [TAG];
    for (let j = 0; j < batch; j++) {
      const phone = `+90599${String(randomInt(10_000_000)).padStart(7, '0')}`;
      const plate = `99LT${String(randomInt(1_000_000)).padStart(6, '0')}`;
      params.push(phone, plate);
      values.push(`($1, $${params.length - 1}, 'loadtest-no-login', 'approved', $${params.length}, $1, now())`);
    }
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO drivers (full_name, phone, password_hash, status, plate, license_no, approved_at)
       VALUES ${values.join(',')} ON CONFLICT DO NOTHING RETURNING id`,
      params,
    );
    for (const r of rows) {
      const { accessToken } = issueTokens({ accessSecret: ACCESS_SECRET!, refreshSecret: 'x'.repeat(32) }, { sub: r.id, role: 'driver', tv: 0 });
      sims.push({ id: r.id, token: accessToken, seq: 0 });
    }
  }
  console.log(`${sims.length} şoför hazır; ${API_URLS.length} node: ${API_URLS.join(', ')}`);

  const goOnlineRtt: number[] = [];
  const entryLat: number[] = [];
  const seenLat: number[] = [];
  let sent = 0;
  let dropped = 0;
  let tsEchoed = 0;
  let disconnects = 0;
  let connectErrors = 0;

  // ---- 2) Bağlan + go_online (ack RTT) ----
  await Promise.all(
    sims.map(
      (s, i) =>
        new Promise<void>((resolve) => {
          const socket = io(`${API_URLS[i % API_URLS.length]}/driver`, { auth: { token: s.token }, transports: ['websocket'], reconnection: false, forceNew: true });
          s.socket = socket;
          socket.on('disconnect', () => void disconnects++);
          socket.once('connect_error', (e) => {
            connectErrors++;
            console.error(`connect_error: ${e.message}`);
            resolve();
          });
          socket.once('connect', async () => {
            const start = performance.now();
            const loc = { lat: BASE.lat + (Math.random() - 0.5) * 0.1, lng: BASE.lng + (Math.random() - 0.5) * 0.1 };
            const ack = (await socket.timeout(10_000).emitWithAck(DRIVER_EVENTS.goOnline, { location: loc }).catch(() => null)) as Ack | null;
            if (ack?.ok) goOnlineRtt.push(performance.now() - start);
            else console.error(`go_online başarısız: ${JSON.stringify(ack)}`);
            resolve();
          });
        }),
    ),
  );
  console.log(`bağlı: ${sims.filter((s) => s.socket?.connected).length}/${sims.length}`);

  // ---- 3) Konum yayını + örnekleyici ----
  const endAt = Date.now() + DURATION_S * 1000;
  for (const s of sims) {
    const tick = () => {
      if (!s.socket?.connected || Date.now() > endAt) return;
      if (s.pending) dropped++; // önceki güncelleme hiç görünmedi
      s.seq++;
      // Benzersiz enlem: seq'i 7. ondalığa göm (cihaz gürültüsü düzeyinde).
      const lat = +(BASE.lat + (s.seq % 1000) * 1e-7 + randomInt(1000) * 1e-4).toFixed(7);
      const sentAt = Date.now();
      // ts gönderim anından kasıtlı 250 ms geride: sunucu updatedAt'e istemci ts'ini yazıyorsa ayırt edilir.
      const ts = sentAt - 250;
      s.pending = { lat: String(lat), sentAt, ts };
      s.socket.emit(DRIVER_EVENTS.locationUpdate, { location: { lat, lng: BASE.lng }, ts });
      sent++;
    };
    // Başlangıçları aralığa yay.
    timers.push(
      setTimeout(() => {
        tick();
        timers.push(setInterval(tick, INTERVAL_MS));
      }, randomInt(INTERVAL_MS)),
    );
  }

  sampling = !!redis;
  const sampler = (async () => {
    while (sampling && redis) {
      const live = sims.filter((s) => s.pending);
      const p = redis.pipeline();
      for (const s of live) p.hmget(redisKeys.driver(s.id), 'lat', 'updatedAt');
      const res = (await p.exec()) ?? [];
      const now = Date.now();
      res.forEach(([, v], i) => {
        const s = live[i]!;
        const [lat, updatedAt] = (v as [string | null, string | null]) ?? [];
        if (!s.pending || lat === null || Number(lat) !== Number(s.pending.lat)) return;
        const u = Number(updatedAt);
        if (u === s.pending.ts) tsEchoed++;
        entryLat.push(u - s.pending.sentAt);
        seenLat.push(now - s.pending.sentAt);
        s.pending = undefined;
      });
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  await new Promise((r) => setTimeout(r, DURATION_S * 1000 + 1500));
  sampling = false;
  await sampler;

  // ---- 4) Sonuç ----
  console.log('\n=== Sonuç ===');
  summary('go_online ack RTT', goOnlineRtt);
  if (redis) {
    summary('location entry (updatedAt-sent)', entryLat);
    summary('location seen (sample-sent)', seenLat);
    console.log(`gönderilen=${sent} ölçülen=${entryLat.length} görünmeyen/düşen=${dropped} connect_error=${connectErrors} kopma=${disconnects}`);
    if (tsEchoed > entryLat.length * 0.9) {
      console.warn('UYARI: updatedAt istemcinin ts değeriyle aynı; sunucu kendi saatini yazmıyor → "entry" ölçümü GEÇERSİZ.');
    }
    const ages = await Promise.all(sims.map((s) => redis.zscore(redisKeys.heartbeat, s.id)));
    const staleHb = ages.filter((a) => a === null || Date.now() - Number(a) > INTERVAL_MS * 3).length;
    console.log(`bitişte heartbeat'i eski/eksik şoför: ${staleHb}`);
  } else {
    console.log('REDIS_URL yok: konum güncellemesi ölçülmedi.');
  }
  if (metricsBefore) {
    // ---- Sunucu içi gecikme: /metrics histogram farkı (KESİN KANIT) ----
    const after = await scrapeHistogram();
    const delta = new Map<number, number>();
    for (const [le, c] of after) delta.set(le, Math.max(0, c - (metricsBefore.get(le) ?? 0)));
    const total = delta.get(Infinity) ?? 0;
    const fmt = (s: number) => (Number.isFinite(s) ? `${(s * 1000).toFixed(1)} ms` : s === Infinity ? '> son kova' : 'NaN');
    const p50 = bucketQuantile(delta, 0.5);
    const p95 = bucketQuantile(delta, 0.95);
    const p99 = bucketQuantile(delta, 0.99);
    const le50 = delta.get(0.05);
    console.log(`\n=== Sunucu içi ${HIST} (${METRICS_URLS.length} node, yük süresince) ===`);
    console.log(`örnek=${total}  p50=${fmt(p50)}  p95=${fmt(p95)}  p99=${fmt(p99)}`);
    if (le50 !== undefined && total > 0) console.log(`≤ 50 ms oranı: ${((le50 / total) * 100).toFixed(2)}%`);
    if (total === 0) console.log('UYARI: histogramda yeni örnek yok; METRICS_URL doğru node\'lara mı bakıyor?');
    else if (total < sent * 0.9) console.log(`UYARI: sunucu örneği (${total}) gönderilenin (${sent}) %90'ından az; kısmi ölçüm.`);
    console.log(
      `Kabul ("p95 < 50 ms"): ${Number.isFinite(p95) && p95 <= 0.05 ? 'SAĞLANDI' : 'SAĞLANMADI/belirsiz'} ` +
        '(kova içi interpolasyon tahmindir; 50 ms bir kova sınırı olduğundan ≤ 50 ms oranı güvenilirdir).',
    );
  } else {
    console.log(
      '\nKabul ("p95 işleme < 50 ms"): METRICS_URL verilmediği için KARARLAŞTIRILAMAZ.\n' +
        '  - "entry" handler girişine kadarki gecikmedir; Lua/Redis işleme süresini içermez.\n' +
        '  - "seen" işlemeyi içerir ama ~100 ms örnekleme çözünürlüğü nedeniyle 50 ms eşiği için kaba bir üst sınırdır.\n' +
        '  - Kesin p95 için betiği METRICS_URL (+ METRICS_TOKEN) ile tekrar çalıştırın (bkz. dosya başı, madde 3).',
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => cleanup());
