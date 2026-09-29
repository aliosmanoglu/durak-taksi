import type { Server as HttpServer } from 'node:http';
import { Server, type Namespace, type Socket } from 'socket.io';
import type { Logger } from 'pino';
import {
  authRefreshSchema,
  COMMON_EVENTS,
  NAMESPACES,
  rooms,
  type Ack,
  type ErrorCode,
} from '@duraknet/shared';
import { AppError } from './http/errors';
import { assertActiveSession, type AuthDeps } from './auth/service';
import { verifyToken, type VerifiedClaims } from './auth/tokens';

export interface Realtime {
  /** Hesabın tüm açık socket'lerini keser (tüm node'larda; redis-adapter Faz 2'de eklenecek). */
  disconnectAccount(role: 'driver' | 'stand', id: string): void;
}

/** Access token süresi dolunca `auth_expired` gönderilir; bu süre içinde `auth_refresh` gelmezse bağlantı kesilir. */
export const AUTH_REFRESH_GRACE_MS = 30_000;

type SocketRole = 'driver' | 'stand';
const roomOf = (role: SocketRole, id: string) => (role === 'driver' ? rooms.driver(id) : rooms.stand(id));

type SocketData = {
  auth: VerifiedClaims;
  expiryTimer?: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
};
const dataOf = (socket: Socket) => socket.data as SocketData;

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
  const d = dataOf(socket);
  clearTimeout(d.expiryTimer);
  clearTimeout(d.graceTimer);
  d.expiryTimer = d.graceTimer = undefined;
}

// Bağlı socket'in oturumu access token süresiyle sınırlıdır. Böylece hesap durumu en geç her token
// yenilemesinde (≤ 15 dk) yeniden kontrol edilir; disconnectAccount'un kaçırdığı durumlar da kapanır.
function scheduleSessionExpiry(socket: Socket) {
  clearSessionTimers(socket);
  const d = dataOf(socket);
  const ms = Math.max(0, d.auth.exp * 1000 - Date.now());
  d.expiryTimer = setTimeout(() => {
    socket.emit(COMMON_EVENTS.authExpired, {});
    d.graceTimer = setTimeout(() => socket.disconnect(true), AUTH_REFRESH_GRACE_MS);
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

function setupNamespace(nsp: Namespace, deps: AuthDeps, role: SocketRole, log: Logger) {
  nsp.use(authMiddleware(deps, role));
  nsp.on('connection', async (socket) => {
    const claims = dataOf(socket).auth;
    registerCommonHandlers(deps, socket, log);
    scheduleSessionExpiry(socket);
    await socket.join(roomOf(role, claims.sub));
    // Handshake kontrolü ile odaya katılma arasında hesap askıya alınmış olabilir: bu durumda
    // disconnectAccount socket'i henüz odada bulamamıştır. Katıldıktan sonra bir kez daha kontrol et.
    try {
      await assertActiveSession(deps, claims);
    } catch {
      socket.disconnect(true);
      return;
    }
    // Faz 2+: session_sync, konum ve ride event'leri burada kaydedilecek.
  });
}

/**
 * Socket.io sunucusunu HTTP sunucusuna bağlamadan kurar. Çağıran önce Express'i HTTP sunucusuna
 * bağlamalı, sonra `attach` çağırmalıdır: engine.io attach anındaki `request` dinleyicilerini
 * sarmalar; sonradan eklenen Express dinleyicisi /socket.io/ polling isteklerine de yanıt verip
 * süreci ERR_HTTP_HEADERS_SENT ile çökertir.
 */
export function createRealtime(deps: AuthDeps, log: Logger, opts: { corsOrigin: string[] | '*' }) {
  const io = new Server({ cors: { origin: opts.corsOrigin }, serveClient: false });
  // Ana namespace kullanılmıyor; kimliksiz bağlantıları reddet.
  io.use((_socket, next) => next(socketError('FORBIDDEN', 'Geçersiz namespace')));
  setupNamespace(io.of(NAMESPACES.driver), deps, 'driver', log);
  setupNamespace(io.of(NAMESPACES.stand), deps, 'stand', log);

  const realtime: Realtime = {
    disconnectAccount(role, id) {
      io.of(NAMESPACES[role]).in(roomOf(role, id)).disconnectSockets(true);
    },
  };
  return { io, realtime, attach: (httpServer: HttpServer) => io.attach(httpServer) };
}

export const noopRealtime: Realtime = { disconnectAccount: () => {} };
