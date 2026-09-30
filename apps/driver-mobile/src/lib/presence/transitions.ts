// Varlık durum geçişleri (tasarım 3.3, 3.4, 4.5, 5 ve Bölüm 9 kararları). Her fonksiyon saftır:
// mevcut durumu ve olayı alır, durum yamasını ve yan etkileri döndürür. Yan etkileri servis katmanı uygular.
import {
  DRIVER_STATUSES,
  OFFLINE_REASONS,
  type DriverSessionSync,
  type DriverStatusResult,
  type ErrorCode,
} from '@duraknet/shared';
import {
  AUTO_REACTIVATE_MAX_COUNT,
  AUTO_REACTIVATE_MAX_GAP_MS,
  AUTO_REACTIVATE_WINDOW_MS,
  DISCONNECT_QUIET_MS,
  SYNC_WATCH_FIRST_MS,
  TOGGLE_LOCK_MS,
} from '../constants';
import { backoffMs, isSessionEndingCode, sessionEndReasonOf, type SessionEndReason } from '../session-policy';
import { T } from '../texts';
import {
  hasLocationPermission,
  type Conn,
  type Gps,
  type Notice,
  type Perm,
  type PresenceState,
  type ReactivateFailReason,
} from './state';

export type Effect =
  /** Konum görevini (gerekirse) başlat ve hemen bir konum gönder. */
  | { type: 'startTracking' }
  | { type: 'stopTracking' }
  | { type: 'emitGoOffline' }
  /** S4: izin/GPS/fix kontrolü → `driver_go_online` (servis katmanı yürütür). */
  | { type: 'autoReactivate' }
  | { type: 'requestSync' }
  | { type: 'toast'; text: string }
  | { type: 'haptic'; kind: 'success' | 'warning' }
  | { type: 'announce'; text: string }
  | { type: 'sessionEnd'; reason: SessionEndReason }
  /** Uygulama arka plandaysa yerel bildirim (ön plandaysa servis yok sayar). */
  | { type: 'localNotify'; text: string };

export type Step = { patch: Partial<PresenceState>; effects: Effect[] };

const step = (patch: Partial<PresenceState> = {}, effects: Effect[] = []): Step => ({ patch, effects });

// ---------------------------------------------------------------------------------------------
// presenceVersion (S2)

/**
 * Aynı socket bağlantısında elindekinden küçük sürümlü `session_sync` / ack yok sayılır. Eşit sürüm kabul
 * edilir (aynı geçişin hem ack'i hem sync'i gelebilir). Sürüm taşımayan (eski sunucu) yanıt kabul edilir.
 */
export function acceptPresenceVersion(
  current: number | null,
  incoming: number | undefined,
): { accept: boolean; next: number | null } {
  if (incoming == null) return { accept: true, next: current };
  if (current != null && incoming < current) return { accept: false, next: current };
  return { accept: true, next: incoming };
}

// ---------------------------------------------------------------------------------------------
// Bağlantı

export function onConnected(s: PresenceState, now: number): Step {
  const effects: Effect[] = [];
  if (s.disconnectedAt != null && now - s.disconnectedAt >= DISCONNECT_QUIET_MS) {
    effects.push({ type: 'toast', text: T.conn.restored });
  }
  // Her yeni bağlantıda sunucu `session_sync` gönderir; sürüm karşılaştırması bu bağlantı için sıfırlanır.
  return step({ conn: 'connected', disconnectedAt: null, presenceVersion: null, syncPending: true }, effects);
}

export function onDisconnected(s: PresenceState, now: number): Step {
  return step({ conn: 'disconnected', disconnectedAt: s.disconnectedAt ?? now, syncPending: false });
}

// ---------------------------------------------------------------------------------------------
// Aktif olma ön koşulları

export type Readiness = { ok: true } | { ok: false; reason: 'perm' | 'gps' | 'conn' };

/** AKTİF OL / otomatik aktif olma kontrolleri (fix alımı ayrı adımdır). Sıra: izin → GPS → bağlantı. */
export function checkGoOnlineReadiness(s: { perm: Perm; gps: Gps; conn: Conn }): Readiness {
  if (!hasLocationPermission(s.perm)) return { ok: false, reason: 'perm' };
  if (s.gps === 'off') return { ok: false, reason: 'gps' };
  if (s.conn !== 'connected') return { ok: false, reason: 'conn' };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Kullanıcı eylemleri

/** AKTİF OL: kontroller geçtiyse fix adımına geçilir. */
export function beginGoOnline(): Step {
  return step({ intent: 'goingOnline', goOnlineStep: 'fix', wantsOnline: true });
}

export function goOnlineFixAcquired(): Step {
  return step({ goOnlineStep: 'ack' });
}

/** Fix alınamadı (manuel akış). */
export function goOnlineFixFailed(): Step {
  return step({ intent: 'none', goOnlineStep: null }, [{ type: 'toast', text: T.home.errNoFix }]);
}

/**
 * PASİF OL (kural 3.4-5): önce konum görevi durur, sonra `driver_go_offline`. Bağlı değilse istek
 * `offlinePending` olarak bekler; bağlantı gelince `session_sync` kararı verir.
 */
export function beginGoOffline(s: PresenceState, now: number): Step {
  const patch: Partial<PresenceState> = { wantsOnline: false, notice: null, toggleLockedUntil: now + TOGGLE_LOCK_MS };
  if (s.conn === 'connected') {
    return step({ ...patch, intent: 'goingOffline' }, [{ type: 'stopTracking' }, { type: 'emitGoOffline' }]);
  }
  return step({ ...patch, intent: 'offlinePending' }, [{ type: 'stopTracking' }]);
}

// ---------------------------------------------------------------------------------------------
// Ack sonuçları

export type AckOutcome<T> = { ok: true; data?: T } | { ok: false; code: ErrorCode } | { ok: false; timeout: true };

const reactivateFailed = (reason: ReactivateFailReason): Step =>
  step({ intent: 'none', goOnlineStep: null, notice: { kind: 'reactivateFailed', reason } }, [
    { type: 'stopTracking' },
    { type: 'haptic', kind: 'warning' },
    { type: 'localNotify', text: T.notif.dropped },
  ]);

/**
 * `driver_go_online` ack'i. `auto`: S4 otomatik yeniden aktif olma akışından mı geldi.
 * Konum görevi yalnızca ack ok'tan sonra başlar (kural 3.4-4).
 */
export function onGoOnlineAck(
  s: PresenceState,
  r: AckOutcome<DriverStatusResult>,
  now: number,
  auto: boolean,
): Step {
  if (r.ok) {
    const v = acceptPresenceVersion(s.presenceVersion, r.data?.presenceVersion);
    if (!v.accept) {
      // Daha yeni bir session_sync zaten geldi ve durumu belirledi; ack'in durumu eskidir. Sunucu pasif
      // diyorsa (otomatik akışta) hâlâ çalışan konum görevi durdurulur.
      return step({ intent: 'none', goOnlineStep: null }, s.server === 'offline' ? [{ type: 'stopTracking' }] : []);
    }
    const status = r.data?.status ?? 'available';
    const base: Partial<PresenceState> = {
      presenceVersion: v.next,
      intent: 'none',
      goOnlineStep: null,
      server: status,
      offlineReason: undefined,
      toggleLockedUntil: now + TOGGLE_LOCK_MS,
    };
    if (status === 'offline') {
      // Sözleşmede olmamalı; güvenli taraf: pasif göster, konum gönderme.
      return step({ ...base, notice: null }, [{ type: 'stopTracking' }, { type: 'toast', text: T.home.errGoOnlineFailed }]);
    }
    const effects: Effect[] = [{ type: 'startTracking' }];
    if (status === 'available') {
      effects.push({ type: 'haptic', kind: 'success' }, { type: 'announce', text: T.home.a11yNowActive });
    }
    return step(
      {
        ...base,
        wantsOnline: true,
        notice: auto ? { kind: 'reactivated' } : null,
        // Elle AKTİF OL şoförün araç başında olduğunu gösterir: otomatik aktif olma sayacı sıfırlanır.
        ...(auto ? {} : { autoReactivations: [] }),
      },
      effects,
    );
  }
  if ('timeout' in r) {
    // Sonuç bilinmiyor: `server` değişmez, son söz bir sonraki session_sync'indir (hemen istenir).
    if (auto) {
      const f = reactivateFailed('server');
      return step(f.patch, [...f.effects, { type: 'requestSync' }]);
    }
    return step({ intent: 'none', goOnlineStep: null }, [
      { type: 'toast', text: T.home.errGoOnlineTimeout },
      { type: 'requestSync' },
    ]);
  }
  if (isSessionEndingCode(r.code)) {
    return step({ intent: 'none', goOnlineStep: null }, [
      { type: 'stopTracking' },
      { type: 'sessionEnd', reason: sessionEndReasonOf(r.code) },
    ]);
  }
  if (auto) return reactivateFailed(r.code === 'VALIDATION_ERROR' ? 'fix' : 'server');
  const text = r.code === 'VALIDATION_ERROR' ? T.home.errNoFix : T.home.errGoOnlineFailed;
  return step({ intent: 'none', goOnlineStep: null }, [{ type: 'toast', text }]);
}

/** Konum görevi ack'ten sonra başlatılamadı (kural 3.4-4): `driver_go_offline` gönderilir. */
export function onTrackingStartFailed(s: PresenceState): Step {
  if (s.conn === 'connected') {
    return step({ intent: 'goingOffline', wantsOnline: false }, [
      { type: 'emitGoOffline' },
      { type: 'toast', text: T.home.errTrackingFailed },
      { type: 'localNotify', text: T.notif.dropped },
    ]);
  }
  return step({ intent: 'offlinePending', wantsOnline: false }, [
    { type: 'toast', text: T.home.errTrackingFailed },
    { type: 'localNotify', text: T.notif.dropped },
  ]);
}

export function onGoOfflineAck(s: PresenceState, r: AckOutcome<DriverStatusResult>, now: number): Step {
  if (r.ok) {
    const v = acceptPresenceVersion(s.presenceVersion, r.data?.presenceVersion);
    if (!v.accept) return step({ intent: 'none' });
    const status = r.data?.status ?? 'offline';
    if (status === 'busy') {
      return step({ presenceVersion: v.next, intent: 'none', server: 'busy' }, [
        { type: 'startTracking' },
        { type: 'toast', text: T.home.errOfflineBusy },
      ]);
    }
    return step(
      {
        presenceVersion: v.next,
        intent: 'none',
        server: status,
        offlineReason: status === 'offline' ? 'user' : undefined,
        notice: null,
        toggleLockedUntil: now + TOGGLE_LOCK_MS,
      },
      [
        { type: 'haptic', kind: 'success' },
        { type: 'announce', text: T.home.a11yNowPassive },
      ],
    );
  }
  // Sonuç bilinmiyor: bağlıysak güncel durum hemen istenir (gelen sync 'available' derse go_offline tekrar
  // gönderilir); yanıt yoksa servis geri çekilmeyle yeniden ister (needsSyncRequest). Kalıcı kilit olmaz.
  const pending = () => step({ intent: 'offlinePending' }, s.conn === 'connected' ? [{ type: 'requestSync' }] : []);
  if ('timeout' in r) return pending();
  if (r.code === 'INVALID_TRANSITION') {
    // Aktif iş varken pasif olunamaz (Faz 3): konum paylaşımı geri açılır.
    return step({ intent: 'none' }, [{ type: 'startTracking' }, { type: 'toast', text: T.home.errOfflineBusy }]);
  }
  if (isSessionEndingCode(r.code)) {
    return step({ intent: 'none' }, [{ type: 'sessionEnd', reason: sessionEndReasonOf(r.code) }]);
  }
  return pending();
}

// ---------------------------------------------------------------------------------------------
// session_sync (tasarım 4.5 + S4)

export type DropDecision = { kind: 'reactivate' } | { kind: 'notice'; notice: Notice } | { kind: 'silent' };

/**
 * Sunucu şoförü (yerelde aktifken) pasif bildirdi: otomatik yeniden aktif olunacak mı?
 * - `forced` → hiçbir şey (askıya alma / çıkış; oturum zaten sonlanır).
 * - `stale_heartbeat` / `not_online` + `wantsOnline` + görevden son NORMAL gönderimden ≤ 10 dk → otomatik.
 *   Ölçüt zorunlu ilk gönderimle yenilenmez; yoksa her otomatik aktif olma 10 dk sayacını sıfırlardı.
 * - aynı nedenler, > 10 dk (veya hiç gönderim yok) → mavi "10 dakikadan uzun" kartı.
 * - son 10 dk içinde zaten 3 otomatik aktif olma yapıldıysa → otomatik yok, mavi "tekrar tekrar koptu" kartı
 *   (ör. saat kayması yüzünden sweeper her taramada düşürüyorsa sonsuz döngü olmasın).
 * - `user` (başka cihazdan pasif olundu), sebepsiz (eski sunucu) veya `wantsOnline = false` → "Pasife alındınız".
 */
export function decideAfterDrop(input: {
  reason: DriverSessionSync['offlineReason'];
  wantsOnline: boolean;
  lastRoutineSentAt: number | null;
  autoReactivations: readonly number[];
  now: number;
}): DropDecision {
  const { reason, wantsOnline, lastRoutineSentAt, now } = input;
  if (reason === 'forced') return { kind: 'silent' };
  if ((reason === 'stale_heartbeat' || reason === 'not_online') && wantsOnline) {
    if (lastRoutineSentAt == null || now - lastRoutineSentAt > AUTO_REACTIVATE_MAX_GAP_MS) {
      return { kind: 'notice', notice: { kind: 'droppedLong' } };
    }
    if (recentAutoReactivations(input.autoReactivations, now).length >= AUTO_REACTIVATE_MAX_COUNT) {
      return { kind: 'notice', notice: { kind: 'droppedRepeated' } };
    }
    return { kind: 'reactivate' };
  }
  return { kind: 'notice', notice: { kind: 'dropped' } };
}

/** Pencere (10 dk) içindeki otomatik yeniden aktif olma zamanları. */
export function recentAutoReactivations(times: readonly number[], now: number): number[] {
  return times.filter((t) => now - t <= AUTO_REACTIVATE_WINDOW_MS);
}

export type SyncPayload = Pick<DriverSessionSync, 'driverStatus' | 'offlineReason'> & { presenceVersion?: number };

/** `session_sync` (bağlanma, offline konum veya `session_sync_request` ack'i) ile yerel durumu uzlaştırır. */
export function reconcileSync(s: PresenceState, sync: SyncPayload, now: number): Step & { ignored: boolean } {
  const v = acceptPresenceVersion(s.presenceVersion, sync.presenceVersion);
  if (!v.accept) return { ignored: true, patch: {}, effects: [] };
  const base: Partial<PresenceState> = { presenceVersion: v.next, syncPending: false };
  const out = (patch: Partial<PresenceState>, effects: Effect[] = []) => ({
    ignored: false,
    patch: { ...base, ...patch },
    effects,
  });
  const stopIfTracking: Effect[] = s.tracking ? [{ type: 'stopTracking' }] : [];

  switch (sync.driverStatus) {
    case 'offline': {
      const patch: Partial<PresenceState> = { server: 'offline', offlineReason: sync.offlineReason };
      // Bekleyen pasif isteği sunucuda zaten gerçekleşmiş: sessizce D3.
      if (s.intent === 'offlinePending' || s.intent === 'goingOffline') {
        return out({ ...patch, intent: 'none' }, stopIfTracking);
      }
      // Ack/otomatik akış sürüyor: sonucu o belirler.
      if (s.intent === 'goingOnline' || s.intent === 'reactivating') return out(patch);
      // Zaten pasif.
      if (s.server === 'offline') return out(patch, stopIfTracking);
      // Soğuk açılış (önceki durum bilinmiyor) ve şoför aktif olmak istemiyordu: bildirim yok.
      if (s.server === 'unknown' && !s.wantsOnline) return out(patch, stopIfTracking);

      const d = decideAfterDrop({
        reason: sync.offlineReason,
        wantsOnline: s.wantsOnline,
        lastRoutineSentAt: s.lastRoutineSentAt,
        autoReactivations: s.autoReactivations,
        now,
      });
      if (d.kind === 'reactivate') {
        // Konum görevi durdurulmaz: arka planda yeniden başlatmak (Android 12+ FGS kısıtı) mümkün olmayabilir.
        return out(
          {
            ...patch,
            intent: 'reactivating',
            notice: null,
            autoReactivations: [...recentAutoReactivations(s.autoReactivations, now), now],
          },
          [{ type: 'autoReactivate' }],
        );
      }
      if (d.kind === 'silent') return out(patch, stopIfTracking);
      return out({ ...patch, notice: d.notice }, [
        ...stopIfTracking,
        { type: 'haptic', kind: 'warning' },
        { type: 'localNotify', text: T.notif.dropped },
      ]);
    }

    case 'available': {
      const patch: Partial<PresenceState> = { server: 'available', offlineReason: undefined };
      if (s.intent === 'offlinePending') return out({ ...patch, intent: 'goingOffline' }, [{ type: 'emitGoOffline' }]);
      if (s.intent !== 'none') return out(patch);
      if (s.server === 'available') return out(patch, [{ type: 'startTracking' }]);
      // Yerelde pasif/bilinmiyor ama sunucuda aktif (yeniden kurulum, başka cihaz, soğuk açılış).
      if (hasLocationPermission(s.perm) && s.gps !== 'off') {
        return out(
          { ...patch, wantsOnline: true, notice: s.server === 'busy' ? s.notice : { kind: 'stillActive' } },
          [{ type: 'startTracking' }],
        );
      }
      return out({ ...patch, intent: 'goingOffline', wantsOnline: false, notice: { kind: 'forcedOfflineNoPerm' } }, [
        ...stopIfTracking,
        { type: 'emitGoOffline' },
      ]);
    }

    case 'busy':
      // Faz 3: aktif iş ekranı. Pasif olunamaz; konum görevi çalışır.
      return out({ server: 'busy', offlineReason: undefined, intent: 'none' }, [{ type: 'startTracking' }]);
  }
}

/**
 * S4 otomatik yeniden aktif olma kontrolleri başarısız. Bağlantı yeniden koptuysa kart gösterilmez:
 * yerel durum "aktif (doğrulanmamış)" kalır, sonraki bağlantıdaki `session_sync` aynı kuralı tekrar uygular.
 */
export function onAutoReactivateCheckFailed(reason: 'perm' | 'gps' | 'conn' | 'fix'): Step {
  if (reason === 'conn') return step({ intent: 'none', goOnlineStep: null, server: 'available' });
  return reactivateFailed(reason);
}

/**
 * Sunucudan gelen `session_sync` gövdesini sözleşme listeleriyle denetler (S → C yönü için şema yok).
 * Tanınmayan gövde `null` döner ve yok sayılır.
 */
export function parseSessionSync(p: unknown): SyncPayload | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (!(DRIVER_STATUSES as readonly unknown[]).includes(o.driverStatus)) return null;
  const out: SyncPayload = { driverStatus: o.driverStatus as SyncPayload['driverStatus'] };
  if ((OFFLINE_REASONS as readonly unknown[]).includes(o.offlineReason)) {
    out.offlineReason = o.offlineReason as SyncPayload['offlineReason'];
  }
  if (typeof o.presenceVersion === 'number' && Number.isFinite(o.presenceVersion)) out.presenceVersion = o.presenceVersion;
  return out;
}

// ---------------------------------------------------------------------------------------------
// session_sync bekçisi

/**
 * Bağlıyken güncel durum istenmeli mi: bağlantının session_sync'i gelmedi (`syncPending`) veya pasif isteği
 * sonucu bilinmiyor (`offlinePending`). Servis bu koşul sürdükçe `session_sync_request` gönderir.
 */
export function needsSyncRequest(s: Pick<PresenceState, 'conn' | 'syncPending' | 'intent'>): boolean {
  return s.conn === 'connected' && (s.syncPending || s.intent === 'offlinePending');
}

/** Bekçi gecikmesi: bağlandıktan 5 sn sonra ilk istek, sonra 2, 4, 8 … en çok 30 sn. */
export function syncWatchDelayMs(attempt: number): number {
  return attempt === 0 ? SYNC_WATCH_FIRST_MS : backoffMs(attempt - 1);
}
