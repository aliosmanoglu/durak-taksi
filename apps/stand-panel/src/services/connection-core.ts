// Yeniden bağlanma + oturum yenileme çekirdeği (saf mantık; socket.io ve store'a bağımlı değil).
// realtime.ts gerçek socket/store'u verir; testler sahte socket + sahte zamanlayıcı verir.
import type { ErrorCode } from '@duraknet/shared';
import { afterRefresh, backoffMs, type RefreshResult } from '../lib/session-policy';

export type SocketLike = {
  readonly connected: boolean;
  /** socket.io otomatik yeniden bağlanma açık mı (ara katman reddinde `false` olur). */
  readonly active: boolean;
  connect(): unknown;
  disconnect(): unknown;
};

export type ConnectionDeps = {
  /** Güncel socket (yoksa `null`; oturum kapanmıştır). */
  getSocket: () => SocketLike | null;
  refreshAccess: () => Promise<RefreshResult>;
  endSession: (notice: undefined, blocked: 'pending' | 'suspended') => void;
  setConn: (c: 'connected' | 'disconnected') => void;
  /** Bağlıyken senkron iste; başarısızsa `onFail`. Bağlı değilse bağlanmayı dener. */
  requestSync: (onFail?: () => void) => void;
  syncWaitMs: number;
};

export type AuthCodeInput = ErrorCode | 'TIMEOUT' | 'NETWORK';

export function createConnectionCore(deps: ConnectionDeps) {
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let syncWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let gotSync = false;
  let reconnectAttempt = 0;

  /**
   * Access'i yenileyip socket'i yeniden bağlar. Ağ hatasında geri çekilmeyle tekrar dener; reddedilirse
   * (askıya alma dahil) oturum kapanmıştır ve döngü durur.
   */
  function refreshThenConnect(attempt = 1): void {
    clearTimeout(reconnectTimer);
    const s = deps.getSocket();
    if (!s) return;
    void deps.refreshAccess().then((o) => {
      if (deps.getSocket() !== s) return;
      const plan = afterRefresh(o, attempt);
      if (plan.kind === 'connect') {
        if (!s.connected) s.connect();
      } else if (plan.kind === 'retry') {
        reconnectTimer = setTimeout(() => refreshThenConnect(attempt + 1), plan.delayMs);
      }
    });
  }

  /** Ack/oturum hatası kodları. Ele alındıysa `true`. */
  function handleAuthCode(code: AuthCodeInput): boolean {
    if (code === 'ACCOUNT_SUSPENDED') return deps.endSession(undefined, 'suspended'), true;
    if (code === 'ACCOUNT_PENDING') return deps.endSession(undefined, 'pending'), true;
    if (code === 'UNAUTHORIZED') {
      refreshThenConnect();
      return true;
    }
    return false;
  }

  function onConnect(): void {
    reconnectAttempt = 0;
    gotSync = false;
    deps.setConn('connected');
    clearTimeout(syncWaitTimer);
    syncWaitTimer = setTimeout(() => {
      if (!gotSync) {
        deps.requestSync(() => {
          const s = deps.getSocket();
          if (s) {
            s.disconnect();
            s.connect();
          }
        });
      }
    }, deps.syncWaitMs);
  }

  function onSync(): void {
    gotSync = true;
    clearTimeout(syncWaitTimer);
  }

  function onDisconnect(reason: string): void {
    clearTimeout(syncWaitTimer);
    deps.setConn('disconnected');
    // Sunucu kesti (askıya alma, token süresi...): önce oturumu doğrula, sonra yeniden bağlan.
    if (reason === 'io server disconnect') refreshThenConnect();
  }

  function onConnectError(err: { message: string; data?: { code?: string } }): void {
    deps.setConn('disconnected');
    const s = deps.getSocket();
    const code = err.data?.code ?? err.message;
    // Askıya alınmış/onaysız hesap: yeniden bağlanma döngüsüne girme.
    if (code === 'ACCOUNT_SUSPENDED') return deps.endSession(undefined, 'suspended');
    if (code === 'ACCOUNT_PENDING') return deps.endSession(undefined, 'pending');
    if (!s) return;
    // Ara katman reddi (UNAUTHORIZED vb.) otomatik yeniden bağlanmayı durdurur: elle devam edilir.
    if (!s.active) {
      const attempt = ++reconnectAttempt;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (deps.getSocket() !== s) return;
        if (code === 'UNAUTHORIZED') refreshThenConnect(attempt);
        else s.connect();
      }, backoffMs(attempt));
    }
  }

  function onAuthExpired(): void {
    refreshThenConnect(); // başarılı olunca onToken dinleyicisi `auth_refresh` gönderir; 'network' yeniden denenir
  }

  function dispose(): void {
    clearTimeout(reconnectTimer);
    clearTimeout(syncWaitTimer);
  }

  return { refreshThenConnect, handleAuthCode, onConnect, onSync, onDisconnect, onConnectError, onAuthExpired, dispose };
}
