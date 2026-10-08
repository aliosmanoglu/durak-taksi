// Ana ekranın (E4) türetilmiş durumu: tasarım 3.2 (A2–D3, ilk eşleşen kazanır), 4.4 (uyarı şeridi
// önceliği), durum çipleri ve bildirim kartı içerikleri. Saf fonksiyon; yalnızca `now` ile zamana bağlıdır.
import {
  DISCONNECT_QUIET_MS,
  LAST_SENT_WARN_MS,
  PROBABLY_OFFLINE_MS,
} from '../constants';
import { T } from '../texts';
import type { Tone } from '../theme';
import {
  fixQuality,
  hasLocationPermission,
  serverNeedsLocation,
  type Notice,
  type PresenceState,
} from './state';

export type HomeCode =
  | 'A2' | 'A3' | 'R' | 'A4' | 'A5' | 'B1'
  | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6'
  | 'D1' | 'D2' | 'D3';

export type Accent = 'green' | 'red' | 'muted' | 'blue';
export type ChipColor = 'green' | 'yellow' | 'red' | 'muted';
export type Icon = 'filled' | 'empty' | 'warn' | 'spin';

export type ButtonAction = 'goOnline' | 'goOffline' | 'openSettings' | 'none';
/** `on` yeşil dolgu · `off` çerçeveli · `light` açık dolgu · `disabled` soluk · `wait` döner gösterge. */
export type ButtonStyle = 'on' | 'off' | 'light' | 'disabled' | 'wait';
export type HomeButton = { action: ButtonAction; label: string; style: ButtonStyle; enabled: boolean };

export type BannerAction = 'openSettings' | 'enableGps' | 'fixPermission';
export type Banner = {
  priority: number;
  tone: Extract<Tone, 'red' | 'yellow'>;
  text: string;
  sub?: string;
  action?: { kind: BannerAction; label: string };
};

export type Chip = { label: string; color: ChipColor };

export type HomeView = {
  code: HomeCode;
  title: string;
  sub: string;
  accent: Accent;
  icon: Icon;
  button: HomeButton | null;
  banner: Banner | null;
  chips: Chip[];
};

export type NoticeView = { tone: Tone; title: string; text: string };

// ---------------------------------------------------------------------------------------------

type Timing = {
  /** Kopukluk 15 sn'yi geçti (uyarı gösterilir). */
  loudDisconnect: boolean;
  /** Son konumdan (yoksa kopma anından) bu yana ≥ 60 sn: sweeper muhtemelen düşürdü. */
  probablyOffline: boolean;
  /** Pasife düşmeye kalan tahmini saniye (T.warn.disconnected). */
  secondsLeft: number;
  /** Son gönderimden bu yana geçen ms (gönderim yoksa null). */
  sinceSent: number | null;
};

function timing(s: PresenceState, now: number): Timing {
  const disconnected = s.conn !== 'connected' && s.disconnectedAt != null;
  const discMs = disconnected ? now - (s.disconnectedAt as number) : 0;
  const contactAt = s.lastSentAt ?? s.disconnectedAt;
  const sinceContact = contactAt != null ? now - contactAt : 0;
  const loudDisconnect = disconnected && discMs >= DISCONNECT_QUIET_MS;
  return {
    loudDisconnect,
    probablyOffline: loudDisconnect && sinceContact >= PROBABLY_OFFLINE_MS,
    secondsLeft: Math.max(0, Math.ceil((PROBABLY_OFFLINE_MS - sinceContact) / 1000)),
    sinceSent: s.lastSentAt != null ? now - s.lastSentAt : null,
  };
}

/** Uyarı şeridi (4.4): en fazla bir adet, en yüksek öncelikli. Pasifken yalnızca 1 (ve 8). */
export function pickBanner(s: PresenceState, now: number): Banner | null {
  const t = timing(s, now);
  const active = serverNeedsLocation(s.server);
  const q = fixQuality(s.fix, now);
  const autoHint = s.wantsOnline ? T.warn.autoReactivateHint : undefined;

  if (!active) {
    if (s.perm === 'deniedForever') {
      return { priority: 1, tone: 'red', text: T.warn.permRevoked, action: { kind: 'openSettings', label: T.common.openSettings } };
    }
    // 8 (pil optimizasyonu) istemcide bilinemiyor: bağımlılık yok (tasarım S13).
    return null;
  }
  if (!hasLocationPermission(s.perm)) {
    return {
      priority: 1,
      tone: 'red',
      text: T.warn.permRevoked,
      action:
        s.perm === 'deniedForever'
          ? { kind: 'openSettings', label: T.common.openSettings }
          : { kind: 'fixPermission', label: T.warn.fixPermission },
    };
  }
  if (s.gps === 'off') {
    return { priority: 2, tone: 'red', text: T.warn.gpsOff, action: { kind: 'enableGps', label: T.warn.gpsOn } };
  }
  if (t.probablyOffline) return { priority: 3, tone: 'red', text: T.warn.probablyOffline, sub: autoHint };
  if (t.loudDisconnect) return { priority: 4, tone: 'yellow', text: T.warn.disconnected(t.secondsLeft), sub: autoHint };
  if (q === 'stale' || (t.sinceSent != null && t.sinceSent > LAST_SENT_WARN_MS)) {
    return { priority: 5, tone: 'yellow', text: T.warn.locationStale };
  }
  if (s.perm === 'foreground') {
    return {
      priority: 6,
      tone: 'yellow',
      text: T.warn.foregroundOnly,
      sub: T.warn.foregroundOnlySub,
      action: { kind: 'fixPermission', label: T.warn.fixPermission },
    };
  }
  if (q === 'poor') return { priority: 7, tone: 'yellow', text: T.warn.poorAccuracy };
  return null;
}

export function deriveChips(s: PresenceState, now: number): Chip[] {
  const t = timing(s, now);
  const active = serverNeedsLocation(s.server);
  const chips: Chip[] = [];

  if (s.conn === 'connected') chips.push({ label: T.chip.connected, color: 'green' });
  else if (!t.loudDisconnect) chips.push({ label: T.chip.connecting, color: 'muted' });
  else chips.push({ label: T.chip.disconnected, color: active && t.probablyOffline ? 'red' : 'yellow' });

  if (!hasLocationPermission(s.perm)) chips.push({ label: T.chip.noPerm, color: 'red' });
  else if (s.gps === 'off') chips.push({ label: T.chip.gpsOff, color: 'red' });
  else {
    // Pasifken konum görevi çalışmaz: son bilinen konumun yaşı değil yalnızca doğruluğu anlamlıdır.
    const q = fixQuality(s.fix, now, !active);
    if (q === 'good') chips.push({ label: T.chip.locGood, color: 'green' });
    else if (q === 'poor') {
      const m = s.fix?.accuracy != null ? Math.round(s.fix.accuracy) : null;
      chips.push({ label: m != null ? T.chip.locPoor(m) : T.chip.locNone, color: 'yellow' });
    } else chips.push({ label: T.chip.locNone, color: active ? 'yellow' : 'muted' });
  }

  if (active && t.sinceSent != null) {
    const sec = Math.max(0, Math.floor(t.sinceSent / 1000));
    if (sec >= 60) chips.push({ label: T.chip.lastSentMin(Math.floor(sec / 60)), color: 'red' });
    else chips.push({ label: T.chip.lastSentSec(sec), color: sec * 1000 > LAST_SENT_WARN_MS ? 'yellow' : 'muted' });
  }
  return chips;
}

const ACTIVE = { title: T.home.active, sub: T.home.activeSub, accent: 'green', icon: 'filled' } as const;
const PASSIVE = { title: T.home.passive, sub: T.home.passiveSub, accent: 'muted', icon: 'empty' } as const;

/** Ana durum (3.2). */
export function deriveHome(s: PresenceState, now: number, opts: { hasActiveRide?: boolean } = {}): HomeView {
  const t = timing(s, now);
  const locked = now < s.toggleLockedUntil;
  const chips = deriveChips(s, now);
  const banner = pickBanner(s, now);
  const wait = (label: string): HomeButton => ({ action: 'none', label, style: 'wait', enabled: false });
  const goOffline: HomeButton = { action: 'goOffline', label: T.home.goOffline, style: 'off', enabled: !locked };
  const view = (v: Omit<HomeView, 'chips' | 'banner'> & { banner?: Banner | null }): HomeView => ({
    ...v,
    banner: v.banner === undefined ? banner : v.banner,
    chips,
  });

  // A1 (oturum yok) gezinme katmanında: bu ekran hiç açılmaz.
  if (s.server === 'unknown') {
    return view({
      code: 'A2',
      title: T.home.connecting,
      sub: T.home.connectingSub,
      accent: 'muted',
      icon: 'spin',
      button: { action: 'none', label: T.home.goOnline, style: 'disabled', enabled: false },
      banner: null,
    });
  }
  if (s.intent === 'goingOnline') {
    return view({
      code: 'A3',
      title: T.home.goingOnline,
      sub: T.home.goingOnlineSub,
      accent: 'muted',
      icon: 'spin',
      button: wait(s.goOnlineStep === 'fix' ? T.home.gettingFix : T.home.goingOnline),
      banner: null,
    });
  }
  if (s.intent === 'reactivating') {
    return view({
      code: 'R',
      title: T.home.reactivating,
      sub: T.home.reactivatingSub,
      accent: 'muted',
      icon: 'spin',
      button: wait(T.home.goingOnline),
      banner: null,
    });
  }
  if (s.intent === 'goingOffline') {
    return view({
      code: 'A4',
      title: T.home.goingOffline,
      sub: T.home.goingOfflineSub,
      accent: 'muted',
      icon: 'spin',
      button: wait(T.home.goingOffline),
      banner: null,
    });
  }
  if (s.intent === 'offlinePending') {
    return view({
      code: 'A5',
      title: T.home.offlinePendingTitle,
      sub: T.home.offlinePendingSub,
      accent: 'muted',
      icon: 'empty',
      button: { action: 'none', label: T.home.goOnline, style: 'disabled', enabled: false },
      banner: null,
    });
  }
  // Eşleşmiş yolculuk (sunucu `busy`, ya da yeniden girişte konum paylaşılmadığı için `offline`): AKTİF/PASİF yok.
  if (s.server === 'busy' || (opts.hasActiveRide && s.server === 'offline')) {
    return view({ code: 'B1', title: T.home.busy, sub: T.home.busySub, accent: 'blue', icon: 'filled', button: null });
  }
  if (s.server === 'available') {
    if (t.probablyOffline) {
      return view({ code: 'C1', title: T.home.unknown, sub: T.home.unknownSub, accent: 'red', icon: 'warn', button: goOffline });
    }
    let code: HomeCode = 'C6';
    const q = fixQuality(s.fix, now);
    if (t.loudDisconnect) code = 'C2';
    else if (!hasLocationPermission(s.perm) || s.gps === 'off') code = 'C3';
    else if (q === 'stale' || (t.sinceSent != null && t.sinceSent > LAST_SENT_WARN_MS)) code = 'C4';
    else if (q === 'poor' || s.perm === 'foreground') code = 'C5';
    return view({ code, ...ACTIVE, button: goOffline });
  }
  // server === 'offline'
  if (s.perm === 'deniedForever') {
    return view({
      code: 'D1',
      ...PASSIVE,
      button: { action: 'openSettings', label: T.common.openSettings, style: 'light', enabled: true },
    });
  }
  if (s.conn !== 'connected') {
    // Soluk görünür ama dokunulabilir: dokununca "Bağlantı yok" açıklaması çıkar.
    return view({
      code: 'D2',
      ...PASSIVE,
      button: { action: 'goOnline', label: T.home.goOnline, style: 'disabled', enabled: !locked },
    });
  }
  return view({
    code: 'D3',
    ...PASSIVE,
    button: { action: 'goOnline', label: T.home.goOnline, style: 'on', enabled: !locked },
  });
}

/** Bildirim kartı içeriği (onaylı tasarım: Home.dc.html varyantları). */
export function noticeView(n: Notice): NoticeView {
  switch (n.kind) {
    case 'reactivated':
      return { tone: 'green', title: T.sync.reactivatedTitle, text: T.sync.reactivated };
    case 'reactivateFailed': {
      const [reason, fix] = T.reactivateReason[n.reason];
      return { tone: 'red', title: T.sync.droppedTitle, text: T.sync.reactivateFailed(reason, fix) };
    }
    case 'droppedLong':
      return { tone: 'blue', title: T.sync.droppedTitle, text: T.sync.droppedLong };
    case 'droppedRepeated':
      return { tone: 'blue', title: T.sync.droppedTitle, text: T.sync.droppedRepeated };
    case 'dropped':
      return { tone: 'blue', title: T.sync.droppedTitle, text: T.sync.droppedGeneric };
    case 'stillActive':
      return { tone: 'green', title: T.sync.stillActiveTitle, text: T.sync.stillActive };
    case 'forcedOfflineNoPerm':
      return { tone: 'red', title: T.sync.droppedTitle, text: T.sync.forcedOfflineNoPerm };
  }
}
