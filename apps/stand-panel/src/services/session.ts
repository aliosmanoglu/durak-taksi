// Oturum yönetimi (docs/design/faz3-dispatch.md 3.3): access token bellekte, refresh token localStorage'da (Q11).
// Access %80'inde sessizce yenilenir; yenilenince socket'e `auth_refresh` gider (realtime.ts dinler).
// Bu modül realtime'ı içe aktarmaz: ilişki `onAuthed` / `onToken` / `onEnded` dinleyicileriyle kurulur.
import type { AuthTokens } from '@duraknet/shared';
import { backoffMs, refreshDelayMs } from '../lib/session-policy';
import { resetSessionState, useStore } from '../store';
import { T } from '../lib/texts';
import { api } from './http';
import { clearSession, getRefreshToken, loadMe, saveMe, setRefreshToken } from './storage';
import type { LoginResult, Me } from './types';

export type RefreshOutcome = 'ok' | 'network' | 'rejected';

export type LoginOutcome =
  | { kind: 'ok' }
  | { kind: 'credentials' }
  | { kind: 'pending' }
  | { kind: 'suspended' }
  | { kind: 'rateLimited'; retryAfterMs: number }
  | { kind: 'network' }
  | { kind: 'server' };

let access: string | null = null;
let accessTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<RefreshOutcome> | null = null;

const authedListeners = new Set<() => void>();
const tokenListeners = new Set<(token: string) => void>();
const endedListeners = new Set<() => void>();

export const onAuthed = (cb: () => void) => void authedListeners.add(cb);
export const onToken = (cb: (token: string) => void) => void tokenListeners.add(cb);
export const onEnded = (cb: () => void) => void endedListeners.add(cb);

export const getAccessToken = (): string | null => access;

function scheduleRefresh(expiresInSec: number) {
  clearTimeout(accessTimer);
  accessTimer = setTimeout(() => void silentRefresh(1), refreshDelayMs(expiresInSec));
}

async function silentRefresh(attempt: number): Promise<void> {
  const out = await refreshAccess();
  if (out === 'network') {
    clearTimeout(accessTimer);
    accessTimer = setTimeout(() => void silentRefresh(attempt + 1), backoffMs(attempt));
  }
}

function applyTokens(t: Partial<AuthTokens> & { accessToken: string; accessExpiresIn: number }) {
  access = t.accessToken;
  if (t.refreshToken) setRefreshToken(t.refreshToken);
  scheduleRefresh(t.accessExpiresIn);
}

/** Access token'ı yeniler (tek uçuş). Reddedilirse oturumu kapatır. */
export function refreshAccess(): Promise<RefreshOutcome> {
  if (inflight) return inflight;
  inflight = (async (): Promise<RefreshOutcome> => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) {
      endSession(T.session.ended);
      return 'rejected';
    }
    const res = await api<AuthTokens>('POST', '/auth/refresh', { body: { refreshToken } });
    if (res.ok) {
      applyTokens(res.data);
      tokenListeners.forEach((cb) => cb(res.data.accessToken));
      return 'ok';
    }
    if (res.kind === 'network') return 'network';
    if (res.code === 'ACCOUNT_SUSPENDED') {
      endSession(undefined, 'suspended');
      return 'rejected';
    }
    if (res.code === 'ACCOUNT_PENDING') {
      endSession(undefined, 'pending');
      return 'rejected';
    }
    if (res.code === 'UNAUTHORIZED' || res.code === 'VALIDATION_ERROR') {
      endSession(T.session.ended);
      return 'rejected';
    }
    return 'network'; // 429 / 5xx: geçici, tekrar denenir
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

type Who = Me | { role: 'admin' };

async function fetchMe(): Promise<Who | 'network' | 'rejected'> {
  if (!access) return 'network';
  const res = await api<Who | { role: 'driver' }>('GET', '/me', { token: access });
  if (res.ok) return res.data.role === 'stand' || res.data.role === 'admin' ? res.data : 'rejected';
  if (res.kind === 'network') return 'network';
  return res.code === 'UNAUTHORIZED' || res.code === 'FORBIDDEN' ? 'rejected' : 'network';
}

function startAuthed(who: Who) {
  if (who.role === 'admin') {
    // Yönetici: çağrı soketi açılmaz, durak verisi yok; yalnızca rapor ekranı.
    useStore.getState().set({ auth: 'authed', role: 'admin', me: null, blockedKind: null, loginNotice: null });
    return;
  }
  saveMe(who);
  useStore.getState().set({ auth: 'authed', role: 'stand', me: who, blockedKind: null, loginNotice: null });
  authedListeners.forEach((cb) => cb());
}

/** Sayfa açılışı: refresh token varsa oturumu sessizce geri kurar. */
export async function boot(): Promise<void> {
  useStore.getState().set({ auth: 'booting' });
  if (!getRefreshToken()) {
    useStore.getState().set({ auth: 'anon' });
    return;
  }
  const out = await refreshAccess();
  if (out === 'rejected') return; // endSession zaten durumu kurdu
  if (out === 'ok') {
    const me = await fetchMe();
    if (me === 'rejected') return endSession(T.session.ended);
    if (me !== 'network') return startAuthed(me);
    // /me ağ hatası: önbellekten devam
  }
  const cached = loadMe();
  if (!cached) {
    useStore.getState().set({ auth: 'bootFailed' });
    return;
  }
  // Ağ yok: son bilinen ekran, "Bağlantı yok" şeridi; girişe atılmaz. Bağlantı gelince devam edilir.
  useStore.getState().set({ auth: 'authed', role: 'stand', me: cached, conn: 'disconnected' });
  void retryBootLoop(1);
}

async function retryBootLoop(attempt: number): Promise<void> {
  clearTimeout(retryTimer);
  if (useStore.getState().auth !== 'authed') return;
  const out = access ? 'ok' : await refreshAccess();
  if (useStore.getState().auth !== 'authed') return;
  if (out === 'ok') {
    const me = await fetchMe();
    if (me === 'rejected') return endSession(T.session.ended);
    if (me !== 'network') return startAuthed(me);
  }
  if (out !== 'rejected') retryTimer = setTimeout(() => void retryBootLoop(attempt + 1), backoffMs(attempt));
}

/** Açılışta ağ yokken başarısız olunduysa kullanıcı TEKRAR DENE'ye basar. */
export function retryBoot(): Promise<void> {
  return boot();
}

export async function login(username: string, password: string, role: 'stand' | 'admin' = 'stand'): Promise<LoginOutcome> {
  const res = await api<LoginResult>('POST', '/auth/login', {
    body: { role, username: username.trim(), password },
  });
  if (!res.ok) {
    if (res.kind === 'network') return { kind: 'network' };
    switch (res.code) {
      case 'INVALID_CREDENTIALS': return { kind: 'credentials' };
      case 'ACCOUNT_PENDING':
        useStore.getState().set({ auth: 'blocked', blockedKind: 'pending' });
        return { kind: 'pending' };
      case 'ACCOUNT_SUSPENDED':
        useStore.getState().set({ auth: 'blocked', blockedKind: 'suspended' });
        return { kind: 'suspended' };
      case 'RATE_LIMITED': return { kind: 'rateLimited', retryAfterMs: res.retryAfterMs ?? 60_000 };
      default: return { kind: 'server' };
    }
  }
  applyTokens(res.data);
  const me = await fetchMe();
  if (typeof me === 'string') {
    clearTimeout(accessTimer);
    access = null;
    clearSession();
    return { kind: me === 'network' ? 'network' : 'server' };
  }
  startAuthed(me);
  return { kind: 'ok' };
}

/** Oturumlu REST çağrısı: 401'de bir kez yenileyip tekrar dener. Yenileme reddedilirse oturum kapanır. */
export async function apiAuthed<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  let res = await api<T>(method, path, { body, token: access ?? undefined });
  if (!res.ok && res.kind === 'http' && res.code === 'UNAUTHORIZED') {
    if ((await refreshAccess()) === 'ok') res = await api<T>(method, path, { body, token: access ?? undefined });
  }
  return res;
}

export type LogoutOutcome = { ok: true } | { ok: false; kind: 'network' | 'server' };

/** Tüm cihazlardan çıkış (`POST /auth/logout`). Ağ hatasında oturum AÇIK kalır; kullanıcı tekrar dener. */
export async function logout(): Promise<LogoutOutcome> {
  if (useStore.getState().role === 'admin') {
    // Yönetici oturumu sunucuda iptal edilemez (ADMIN_TOKEN_VERSION); yalnızca bu cihazdan çıkılır.
    endSession();
    return { ok: true };
  }
  if (!access) {
    const out = await refreshAccess();
    if (out === 'rejected') return { ok: true }; // oturum zaten kapandı
    if (out === 'network' || !access) return { ok: false, kind: 'network' };
  }
  const res = await api<undefined>('POST', '/auth/logout', { token: access ?? undefined });
  if (res.ok || (!res.ok && res.kind === 'http' && (res.status === 401 || res.status === 403))) {
    endSession();
    return { ok: true };
  }
  return { ok: false, kind: res.kind === 'network' ? 'network' : 'server' };
}

/** Oturumu yerelde sonlandırır; `blocked` verilirse onay-bekleniyor/askıda ekranına, aksi halde girişe gider. */
export function endSession(notice?: string, blocked?: 'pending' | 'suspended'): void {
  clearTimeout(accessTimer);
  clearTimeout(retryTimer);
  access = null;
  clearSession();
  endedListeners.forEach((cb) => cb());
  resetSessionState();
  useStore.getState().set({
    auth: blocked ? 'blocked' : 'anon',
    blockedKind: blocked ?? null,
    loginNotice: blocked ? null : (notice ?? null),
  });
}
