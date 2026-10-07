import type { Server as HttpServer } from 'node:http';
import { Server, type Namespace, type ServerOptions, type Socket } from 'socket.io';
import type { Logger } from 'pino';
import {
  authRefreshSchema,
  COMMON_EVENTS,
  DRIVER_EVENTS,
  goOnlineSchema,
  locationUpdateSchema,
  NAMESPACES,
  rooms,
  type Ack,
  type DriverSessionSync,
  type DriverStatusResult,
  type ErrorCode,
  type StandSessionSync,
} from '@duraknet/shared';
import { AppError } from './http/errors';
import { assertActiveSession, type AuthDeps } from './auth/service';
import { verifyToken, type VerifiedClaims } from './auth/tokens';
import type { PresenceService } from './presence/service';

export interface Realtime {
  /**
   * Hesabın tüm açık socket'lerini keser. redis-adapter kuruluysa istek Redis üzerinden tüm node'lara
   * (kendisi dahil) yayılır; bu yüzden yerel socket'ler de asenkron (bir Pub/Sub turu sonra) düşer.
   */
  disconnectAccount(role: 'driver' | 'stand', id: string): void;
}

/** Access token süresi dolunca `auth_expired` gönderilir; bu süre içinde `auth_refresh` gelmezse bağlantı kesilir. */
export const AUTH_REFRESH_GRACE_MS = 30_000;

type SocketRole = 'driver' | 'stand';
const roomOf = (role: SocketRole, id: string) => (role === 'driver' ? rooms.driver(id) : rooms.stand(id));

// socket.data yalnızca JSON'a çevrilebilir veri tutar: redis-adapter onu node'lar arası
// fetchSockets yanıtında serileştirir (Timeout nesnesi döngüsel yapı hatası verir).
type SocketData = { auth: VerifiedClaims };
const dataOf = (socket: Socket) => socket.data as SocketData;

// Oturum zamanlayıcıları socket nesnesinin kendisinde (socket başına; modül seviyesinde state yok).
const TIMERS = Symbol('sessionTimers');
type SessionTimers = { expiry?: NodeJS.Timeout; grace?: NodeJS.Timeout };
const timersOf = (socket: Socket): SessionTimers =>
  ((socket as Socket & { [TIMERS]?: SessionTimers })[TIMERS] ??= {});

// Socket.io istemcisine connect_error olarak gider: err.message = kod, err.data = { code, message }.
function socketError(code: ErrorCode, message: string) {
  return Object.assign(new Error(code), { data: { code, message } });
}

function authMiddleware(deps: AuthDeps, role: SocketRole) {
  return async (socket: Socket, next: (err?: Error) => void) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    const claims = typeof token === 'string' ? verifyToken(deps.secrets.accessSecret, token, 'access') : null;
    if (!claims) return next(socketError('UNAUTHORIZED', 'Kimlik doğrulanamadı'));
    if (claims.role !== role) return next(socketError('FORBIDDEN', 'Bu bağlantı için yetkiniz yok'));
    try {
      // Onaysız/askıdaki hesap ve eski token_version bağlanamaz (Faz 1 kabul kriteri).
      await assertActiveSession(deps, claims);
    } catch (err) {
      if (err instanceof AppError) return next(socketError(err.code, err.message));
      return next(socketError('INTERNAL', 'Sunucu hatası'));
    }
    dataOf(socket).auth = claims;
    next();
  };
}

function clearSessionTimers(socket: Socket) {
  const t = timersOf(socket);
  clearTimeout(t.expiry);
  clearTimeout(t.grace);
  t.expiry = t.grace = undefined;
}

// Bağlı socket'in oturumu access token süresiyle sınırlıdır. Böylece hesap durumu en geç her token
// yenilemesinde (≤ 15 dk) yeniden kontrol edilir; disconnectAccount'un kaçırdığı durumlar da kapanır.
function scheduleSessionExpiry(socket: Socket) {
  clearSessionTimers(socket);
  const t = timersOf(socket);
  const ms = Math.max(0, dataOf(socket).auth.exp * 1000 - Date.now());
  t.expiry = setTimeout(() => {
    socket.emit(COMMON_EVENTS.authExpired, {});
    t.grace = setTimeout(() => socket.disconnect(true), AUTH_REFRESH_GRACE_MS);
  }, ms);
}

function registerCommonHandlers(deps: AuthDeps, socket: Socket, log: Logger) {
  // Bağlantıyı koparmadan access token yenileme. Yeni token aynı hesaba ait olmalı.
  socket.on(COMMON_EVENTS.authRefresh, async (payload: unknown, ack?: (r: Ack) => void) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const parsed = authRefreshSchema.safeParse(payload);
    if (!parsed.success) return reply({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Geçersiz istek' } });
    const current = dataOf(socket).auth;
    const claims = verifyToken(deps.secrets.accessSecret, parsed.data.token, 'access');
    if (!claims || claims.sub !== current.sub || claims.role !== current.role) {
      return reply({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Kimlik doğrulanamadı' } });
    }
    try {
      await assertActiveSession(deps, claims);
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'INTERNAL';
      reply({ ok: false, error: { code, message: 'Oturum geçersiz' } });
      socket.disconnect(true);
      return;
    }
    dataOf(socket).auth = claims;
    scheduleSessionExpiry(socket);
    reply({ ok: true });
  });

  socket.on('disconnect', () => clearSessionTimers(socket));
  socket.on('error', (err) => log.warn({ err: err.message }, 'socket hatası'));
}

const validationError = { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Geçersiz istek' } } as const;

function replyOf<T>(ack: unknown): (r: Ack<T>) => void {
  return typeof ack === 'function' ? (ack as (r: Ack<T>) => void) : () => {};
}

function toAckError(err: unknown, log: Logger): Ack<never> {
  if (err instanceof AppError) return { ok: false, error: { code: err.code, message: err.message } };
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'socket handler hatası');
  return { ok: false, error: { code: 'INTERNAL', message: 'Sunucu hatası' } };
}

/**
 * Şoför varlık event'leri (CLAUDE.md Bölüm 5, Senaryo 1–2). `ready`, bağlantı kontrolleri (odaya katılma +
 * ikinci durum kontrolü) bitene kadar handler'ları bekletir: istemci `connect` olur olmaz event gönderse
 * bile kaybolmaz, ama askıya alma yarışını kaybeden socket de presence'a yazamaz.
 * Socket kopunca presence'a dokunulmaz; heartbeat sweeper toleransı uygular.
 */
function registerDriverHandlers(
  deps: AuthDeps,
  socket: Socket,
  presence: PresenceService,
  ready: Promise<boolean>,
  log: Logger,
) {
  const driverId = () => dataOf(socket).auth.sub;

  // Not: presence her çağrıda nesne üzerinden çağrılır (destructure edilmez); testler metodu sarmalayabilir.
  socket.on(DRIVER_EVENTS.goOnline, async (payload: unknown, ack?: unknown) => {
    const reply = replyOf<DriverStatusResult>(ack);
    if (!(await ready)) return;
    const parsed = goOnlineSchema.safeParse(payload);
    if (!parsed.success) return reply(validationError);
    const id = driverId();
    // Askıya alma/çıkış ile yarış (go_online seyrek; iki DB kontrolünün maliyeti önemsiz):
    // 1) Önce kontrol: zaten geçersiz oturum hiç yazmasın.
    // 2) goOnline'dan SONRA tekrar kontrol: askıya alma (PG UPDATE → disconnect → forceOffline) ilk kontrol
    //    ile Lua arasına düşerse forceOffline goOnline'dan önce çalışmış olabilir ve şoför GEO'da kalırdı.
    //    PG UPDATE forceOffline'dan önce commit edildiği için ikinci kontrol bunu görür; forceOffline tekrarlanır.
    const rejectSession = async (err: unknown, wrote: boolean) => {
      if (wrote) {
        await presence.forceOffline(id).catch((e: unknown) =>
          log.error({ err: e instanceof Error ? e.message : String(e) }, 'forceOffline başarısız'),
        );
      }
      reply(toAckError(err, log));
      socket.disconnect(true);
    };
    try {
      await assertActiveSession(deps, dataOf(socket).auth);
    } catch (err) {
      return rejectSession(err, false);
    }
    let status: DriverStatusResult['status'];
    try {
      status = await presence.goOnline(id, parsed.data.location);
    } catch (err) {
      return reply(toAckError(err, log));
    }
    try {
      await assertActiveSession(deps, dataOf(socket).auth);
    } catch (err) {
      return rejectSession(err, true);
    }
    reply({ ok: true, data: { status } });
  });

  socket.on(DRIVER_EVENTS.goOffline, async (_payload: unknown, ack?: unknown) => {
    const reply = replyOf<DriverStatusResult>(ack);
    if (!(await ready)) return;
    try {
      reply({ ok: true, data: { status: await presence.goOffline(driverId()) } });
    } catch (err) {
      reply(toAckError(err, log));
    }
  });

  // Ack'siz; geçersiz veya throttle'a takılan güncelleme sessizce düşer. Ham konum loglanmaz.
  // Şoför offline ise (pasif, hash süresi dolmuş veya sweeper düşürmüş) istemci "Aktif" görünüp çağrı
  // alamaz halde kalmasın diye `session_sync` gönderilir; istemci toggle'ını buna göre düzeltir.
  // Faz 3: busy şoförün konumu ayrıca `ride:{rideId}` odasına (`ride_driver_location`) yayınlanacak.
  socket.on(DRIVER_EVENTS.locationUpdate, async (payload: unknown) => {
    if (!(await ready)) return;
    const parsed = locationUpdateSchema.safeParse(payload);
    if (!parsed.success) return;
    try {
      const r = await presence.updateLocation(driverId(), {
        location: parsed.data.location,
        heading: parsed.data.heading,
      });
      if (r === 'offline') socket.emit(COMMON_EVENTS.sessionSync, driverSessionSync('offline'));
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'konum güncellenemedi');
    }
  });
}

/** Şoför `session_sync` gövdesi. Faz 3'te aktif ride ve açık çağrılar eklenecek. */
function driverSessionSync(driverStatus: DriverSessionSync['driverStatus']): DriverSessionSync {
  return { driverStatus, openRequests: [] };
}

type NamespaceOpts = { presence: PresenceService | null };

function setupNamespace(nsp: Namespace, deps: AuthDeps, role: SocketRole, log: Logger, opts: NamespaceOpts) {
  nsp.use(authMiddleware(deps, role));
  nsp.on('connection', async (socket) => {
    const claims = dataOf(socket).auth;
    registerCommonHandlers(deps, socket, log);
    scheduleSessionExpiry(socket);

    let markReady!: (ok: boolean) => void;
    const ready = new Promise<boolean>((r) => (markReady = r));
    // Handler'lar hemen kaydedilir (erken gelen event'ler kaybolmasın), ama `ready` çözülene kadar bekler.
    if (role === 'driver' && opts.presence) registerDriverHandlers(deps, socket, opts.presence, ready, log);

    try {
      await socket.join(roomOf(role, claims.sub));
      // Handshake kontrolü ile odaya katılma arasında hesap askıya alınmış olabilir: bu durumda
      // disconnectAccount socket'i henüz odada bulamamıştır. Katıldıktan sonra bir kez daha kontrol et.
      await assertActiveSession(deps, claims);
    } catch {
      markReady(false);
      socket.disconnect(true);
      return;
    }
    markReady(true);

    try {
      if (role === 'driver') {
        const status = opts.presence ? await opts.presence.getStatus(claims.sub) : 'offline';
        socket.emit(COMMON_EVENTS.sessionSync, driverSessionSync(status));
      } else {
        const sync: StandSessionSync = { activeRides: [] }; // Faz 3
        socket.emit(COMMON_EVENTS.sessionSync, sync);
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'session_sync gönderilemedi');
    }
  });
}

export type RealtimeOptions = {
  corsOrigin: string[] | '*';
  /**
   * Zorunlu. `null` = bilinçli olarak devre dışı (yalnızca kimlik/taşıma testleri): şoför varlık
   * event'leri kaydedilmez, `session_sync` `offline` gönderir.
   */
  presence: PresenceService | null;
  /** Çok node'lu kurulum için socket.io adapter fabrikası (ör. `createAdapter(pub, sub)`). */
  adapter?: ServerOptions['adapter'];
};

/**
 * Socket.io sunucusunu HTTP sunucusuna bağlamadan kurar. Çağıran önce Express'i HTTP sunucusuna
 * bağlamalı, sonra `attach` çağırmalıdır: engine.io attach anındaki `request` dinleyicilerini
 * sarmalar; sonradan eklenen Express dinleyicisi /socket.io/ polling isteklerine de yanıt verip
 * süreci ERR_HTTP_HEADERS_SENT ile çökertir.
 */
export function createRealtime(deps: AuthDeps, log: Logger, opts: RealtimeOptions) {
  const io = new Server({
    cors: { origin: opts.corsOrigin },
    serveClient: false,
    ...(opts.adapter ? { adapter: opts.adapter } : {}),
  });
  // Ana namespace kullanılmıyor; kimliksiz bağlantıları reddet.
  io.use((_socket, next) => next(socketError('FORBIDDEN', 'Geçersiz namespace')));
  setupNamespace(io.of(NAMESPACES.driver), deps, 'driver', log, { presence: opts.presence });
  setupNamespace(io.of(NAMESPACES.stand), deps, 'stand', log, { presence: null });

  const realtime: Realtime = {
    disconnectAccount(role, id) {
      io.of(NAMESPACES[role]).in(roomOf(role, id)).disconnectSockets(true);
    },
  };
  return { io, realtime, attach: (httpServer: HttpServer) => io.attach(httpServer) };
}

export const noopRealtime: Realtime = { disconnectAccount: () => {} };
