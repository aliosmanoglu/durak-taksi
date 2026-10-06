import type { Server as HttpServer } from 'node:http';
import { Server, type Namespace, type ServerOptions, type Socket } from 'socket.io';
import type { Logger } from 'pino';
import {
  authRefreshSchema,
  COMMON_EVENTS,
  DRIVER_EVENTS,
  emptyPayloadSchema,
  goOnlineSchema,
  locationUpdateSchema,
  NAMESPACES,
  rideAcceptSchema,
  rideCancelSchema,
  rideCompleteSchema,
  rideCreateSchema,
  rideDeclineSchema,
  rideDriverCancelSchema,
  rooms,
  STAND_EVENTS,
  type Ack,
  type DriverSessionSync,
  type DriverStatusResult,
  type ErrorCode,
  type RideCancelledEvent,
  type RideCompletedEvent,
  type RideCreateResult,
  type RideSnapshot,
  type StandSessionSync,
} from '@duraknet/shared';
import { AppError } from './http/errors';
import { assertActiveSession, getAccountState, type AuthDeps } from './auth/service';
import { verifyToken, type VerifiedClaims } from './auth/tokens';
import type { LocationOutcome, PresenceService, PresenceState } from './presence/service';
import type { DriverRideSync, RideService } from './rides/service';
import { createIoSink, type RideEventSink } from './rides/sink';
import { replyOf, toAckError, validationError } from './socket-util';

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
  rides: RideService | null,
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
    let result: DriverStatusResult;
    try {
      result = await presence.goOnline(id, parsed.data.location);
    } catch (err) {
      return reply(toAckError(err, log));
    }
    try {
      await assertActiveSession(deps, dataOf(socket).auth);
    } catch (err) {
      return rejectSession(err, true);
    }
    reply({ ok: true, data: { status: result.status, presenceVersion: result.presenceVersion } });
  });

  socket.on(DRIVER_EVENTS.goOffline, async (payload: unknown, ack?: unknown) => {
    const reply = replyOf<DriverStatusResult>(ack);
    if (!(await ready)) return;
    if (!emptyPayloadSchema.safeParse(payload).success) return reply(validationError);
    try {
      const r = await presence.goOffline(driverId());
      reply({ ok: true, data: { status: r.status, presenceVersion: r.presenceVersion } });
    } catch (err) {
      reply(toAckError(err, log));
    }
  });

  // Bağlıyken güncel durumu isteme (ör. uygulama arka plandan döndü); socket'i yeniden kurmaya gerek kalmaz.
  socket.on(DRIVER_EVENTS.sessionSyncRequest, async (payload: unknown, ack?: unknown) => {
    const reply = replyOf<DriverSessionSync>(ack);
    if (!(await ready)) return;
    if (!emptyPayloadSchema.safeParse(payload).success) return reply(validationError);
    try {
      reply({ ok: true, data: await driverSessionSync(await presence.getState(driverId()), rides, driverId()) });
    } catch (err) {
      reply(toAckError(err, log));
    }
  });

  // Ack'siz; geçersiz veya throttle'a takılan güncelleme sessizce düşer. Ham konum loglanmaz.
  // Şoför offline ise (pasif, hash süresi dolmuş veya sweeper düşürmüş) istemci "Aktif" görünüp çağrı
  // alamaz halde kalmasın diye `session_sync` gönderilir; istemci toggle'ını buna göre düzeltir.
  // Sebep ve sürüm konum Lua'sının kendi yanıtından gelir (ek Redis round-trip yok).
  // Busy (eşleşmiş) şoförün konumu ayrıca yalnızca `ride:{rideId}` odasına (`ride_driver_location`) yayınlanır;
  // rideId konum Lua'sından gelir (ek Redis turu yok). Throttle'a takılan güncelleme yayınlanmaz.
  socket.on(DRIVER_EVENTS.locationUpdate, async (payload: unknown) => {
    if (!(await ready)) return;
    const parsed = locationUpdateSchema.safeParse(payload);
    if (!parsed.success) return;
    try {
      const out: LocationOutcome = {};
      const r = await presence.updateLocation(driverId(), {
        location: parsed.data.location,
        heading: parsed.data.heading,
      }, undefined, out);
      if (typeof r === 'object') {
        socket.emit(COMMON_EVENTS.sessionSync, await driverSessionSync(r, rides, driverId()));
      } else if (r === 'ok' && out.rideId && rides) {
        rides.publishDriverLocation(out.rideId, parsed.data.location, parsed.data.heading, Date.now());
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'konum güncellenemedi');
    }
  });
}

/**
 * Şoför `session_sync` gövdesi. `offlineReason` yalnızca offline iken bulunur (alan hiç yazılmaz, `undefined`
 * değil). `activeRide` (PG'deki `matched` ride) her durumda; `openRequests` yalnızca `available` iken dolar.
 */
async function driverSessionSync(state: PresenceState, rides: RideService | null, driverId: string): Promise<DriverSessionSync> {
  const extra: DriverRideSync = rides ? await rides.driverSync(driverId, state.status) : { openRequests: [] };
  return {
    driverStatus: state.status,
    ...(state.status === 'offline' ? { offlineReason: state.offlineReason ?? 'not_online' } : {}),
    presenceVersion: state.presenceVersion,
    ...(extra.activeRide ? { activeRide: extra.activeRide } : {}),
    openRequests: extra.openRequests,
    serverTime: new Date().toISOString(),
  };
}

/** Şoför ride event'leri: kabul, ret, şoför iptali, tamamlama (CLAUDE.md Bölüm 6). */
function registerDriverRideHandlers(
  deps: AuthDeps,
  socket: Socket,
  presence: PresenceService,
  rides: RideService,
  ready: Promise<boolean>,
  log: Logger,
) {
  const claims = () => dataOf(socket).auth;

  socket.on(DRIVER_EVENTS.rideAccept, async (payload: unknown, ack?: unknown) => {
    const reply = replyOf<RideSnapshot>(ack);
    if (!(await ready)) return;
    const parsed = rideAcceptSchema.safeParse(payload);
    if (!parsed.success) return reply(validationError);
    const id = claims().sub;
    try {
      await assertActiveSession(deps, claims());
    } catch (err) {
      reply(toAckError(err, log));
      socket.disconnect(true);
      return;
    }
    let snapshot: RideSnapshot;
    try {
      snapshot = await rides.accept(id, parsed.data.rideId);
    } catch (err) {
      return reply(toAckError(err, log));
    }
    // Askıya alma yarışı: kontrol ile kabul arasında hesap askıya alındıysa eşleşme geri verilir
    // (askıya alma yolu releaseDriverForSuspension çağırmış olabilir; işlem idempotenttir) ve şoför offline olur.
    // YALNIZCA hesap gerçekten askıdaysa: askıya alma da logout da token_version'ı artırır, bu yüzden hata kodu
    // (UNAUTHORIZED) ikisini ayırt etmez; hesap durumu okunur. Logout (token_version uyuşmazlığı, hesap `approved`)
    // karar (a)'yı bozmaz: eşleşmiş ride iptal edilmez, `matched` kalır ve şoför yeniden girince devam eder.
    try {
      await assertActiveSession(deps, claims());
    } catch (err) {
      const state = err instanceof AppError ? await getAccountState(deps, 'driver', id).catch(() => null) : null;
      if (err instanceof AppError && state?.status === 'suspended') {
        await rides.releaseDriverForSuspension(id).catch((e: unknown) =>
          log.error({ err: e instanceof Error ? e.message : String(e) }, 'askıdaki şoförün çağrısı bırakılamadı'),
        );
        await presence.forceOffline(id).catch(() => undefined);
        reply(toAckError(err, log));
        socket.disconnect(true);
        return;
      }
    }
    reply({ ok: true, data: snapshot });
  });

  socket.on(DRIVER_EVENTS.rideDecline, async (payload: unknown, ack?: unknown) => {
    const reply = replyOf<undefined>(ack);
    if (!(await ready)) return;
    const parsed = rideDeclineSchema.safeParse(payload);
    if (!parsed.success) return reply(validationError);
    try {
      await rides.decline(claims().sub, parsed.data.rideId);
      reply({ ok: true });
    } catch (err) {
      reply(toAckError(err, log));
    }
  });

  socket.on(DRIVER_EVENTS.rideDriverCancel, async (payload: unknown, ack?: unknown) => {
    const reply = replyOf<{ rideId: string; version: number }>(ack);
    if (!(await ready)) return;
    const parsed = rideDriverCancelSchema.safeParse(payload);
    if (!parsed.success) return reply(validationError);
    try {
      reply({ ok: true, data: await rides.driverCancel(claims().sub, parsed.data) });
    } catch (err) {
      reply(toAckError(err, log));
    }
  });

  socket.on(DRIVER_EVENTS.rideComplete, async (payload: unknown, ack?: unknown) => {
    const reply = replyOf<RideCompletedEvent>(ack);
    if (!(await ready)) return;
    const parsed = rideCompleteSchema.safeParse(payload);
    if (!parsed.success) return reply(validationError);
    try {
      reply({ ok: true, data: await rides.complete({ role: 'driver', id: claims().sub }, parsed.data) });
    } catch (err) {
      reply(toAckError(err, log));
    }
  });
}

/**
 * Durak `session_sync` gövdesi: açık ride'lar + sunucu saati. Eşleşmiş ride'ların odasına (yeniden) katılır
 * (konum yayını `ride:{id}` odasından gelir).
 */
async function standSessionSync(socket: Socket, rides: RideService | null): Promise<StandSessionSync> {
  const activeRides = rides ? await rides.standSync(dataOf(socket).auth.sub) : [];
  for (const r of activeRides) if (r.status === 'matched') await socket.join(rooms.ride(r.rideId));
  return { activeRides, serverTime: new Date().toISOString() };
}

/** Durak ride event'leri: çağrı aç, iptal, tamamla, oturum durumu iste. */
function registerStandHandlers(socket: Socket, rides: RideService, ready: Promise<boolean>, log: Logger) {
  const standId = () => dataOf(socket).auth.sub;

  // Bağlıyken güncel durumu isteme (şoför tarafının eşi); gövde zorunlu `{}`.
  socket.on(STAND_EVENTS.sessionSyncRequest, async (payload: unknown, ack?: unknown) => {
    const reply = replyOf<StandSessionSync>(ack);
    if (!(await ready)) return;
    if (!emptyPayloadSchema.safeParse(payload).success) return reply(validationError);
    try {
      reply({ ok: true, data: await standSessionSync(socket, rides) });
    } catch (err) {
      reply(toAckError(err, log));
    }
  });

  socket.on(STAND_EVENTS.rideCreate, async (payload: unknown, ack?: unknown) => {
    const reply = replyOf<RideCreateResult>(ack);
    if (!(await ready)) return;
    const parsed = rideCreateSchema.safeParse(payload);
    if (!parsed.success) return reply(validationError);
    try {
      reply({ ok: true, data: await rides.createRide(standId(), parsed.data) });
    } catch (err) {
      reply(toAckError(err, log));
    }
  });

  socket.on(STAND_EVENTS.rideCancel, async (payload: unknown, ack?: unknown) => {
    const reply = replyOf<RideCancelledEvent>(ack);
    if (!(await ready)) return;
    const parsed = rideCancelSchema.safeParse(payload);
    if (!parsed.success) return reply(validationError);
    try {
      reply({ ok: true, data: await rides.standCancel(standId(), parsed.data) });
    } catch (err) {
      reply(toAckError(err, log));
    }
  });

  socket.on(STAND_EVENTS.rideComplete, async (payload: unknown, ack?: unknown) => {
    const reply = replyOf<RideCompletedEvent>(ack);
    if (!(await ready)) return;
    const parsed = rideCompleteSchema.safeParse(payload);
    if (!parsed.success) return reply(validationError);
    try {
      reply({ ok: true, data: await rides.complete({ role: 'stand', id: standId() }, parsed.data) });
    } catch (err) {
      reply(toAckError(err, log));
    }
  });
}

/** `presence: null` (yalnızca kimlik/taşıma testleri) iken gönderilen varlık durumu. */
const noPresenceState = (): PresenceState => ({ status: 'offline', offlineReason: 'not_online', presenceVersion: Date.now() });

type NamespaceOpts = { presence: PresenceService | null; rides: RideService | null };

function setupNamespace(nsp: Namespace, deps: AuthDeps, role: SocketRole, log: Logger, opts: NamespaceOpts) {
  nsp.use(authMiddleware(deps, role));
  nsp.on('connection', async (socket) => {
    const claims = dataOf(socket).auth;
    registerCommonHandlers(deps, socket, log);
    scheduleSessionExpiry(socket);

    let markReady!: (ok: boolean) => void;
    const ready = new Promise<boolean>((r) => (markReady = r));
    // Handler'lar hemen kaydedilir (erken gelen event'ler kaybolmasın), ama `ready` çözülene kadar bekler.
    if (role === 'driver' && opts.presence) {
      registerDriverHandlers(deps, socket, opts.presence, opts.rides, ready, log);
      if (opts.rides) registerDriverRideHandlers(deps, socket, opts.presence, opts.rides, ready, log);
    }
    if (role === 'stand' && opts.rides) registerStandHandlers(socket, opts.rides, ready, log);

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
        const state = opts.presence ? await opts.presence.getState(claims.sub) : noPresenceState();
        const sync = await driverSessionSync(state, opts.rides, claims.sub);
        // Eşleşmiş ride varsa soket ride odasına katılır (yeniden bağlanma restorasyonu).
        if (sync.activeRide) await socket.join(rooms.ride(sync.activeRide.rideId));
        socket.emit(COMMON_EVENTS.sessionSync, sync);
      } else {
        socket.emit(COMMON_EVENTS.sessionSync, await standSessionSync(socket, opts.rides));
      }
    } catch (err) {
      // session_sync gelmezse istemci durumunu bilemeden bekler; bağlantıyı kes, istemci yeniden bağlansın.
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'session_sync gönderilemedi');
      socket.disconnect(true);
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
  /**
   * Ride servisi fabrikası (Faz 3). Socket.io sunucusu burada kurulduğu için servis, odalara yayın yapan
   * RideEventSink'i fabrika argümanı olarak alır. Verilmezse ride event'leri kaydedilmez (yalnızca kimlik/varlık testleri).
   */
  rides?: ((sink: RideEventSink) => RideService) | null;
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
  const rides = opts.rides ? opts.rides(createIoSink(io)) : null;
  setupNamespace(io.of(NAMESPACES.driver), deps, 'driver', log, { presence: opts.presence, rides });
  setupNamespace(io.of(NAMESPACES.stand), deps, 'stand', log, { presence: null, rides });

  const realtime: Realtime = {
    disconnectAccount(role, id) {
      io.of(NAMESPACES[role]).in(roomOf(role, id)).disconnectSockets(true);
    },
  };
  return { io, realtime, rides, attach: (httpServer: HttpServer) => io.attach(httpServer) };
}

export const noopRealtime: Realtime = { disconnectAccount: () => {} };
