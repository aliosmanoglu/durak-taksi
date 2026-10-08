// Ön plan / arka plan (tasarım 4.7) ve izin/GPS yoklaması.
import { AppState, type AppStateStatus } from 'react-native';
import { BACKGROUND_RESYNC_MS } from '@/lib/constants';
import { isConnected } from '@/lib/realtime';
import { navigationFlagOnForeground, shouldResyncOnForeground } from '@/lib/session-policy';
import { store } from '@/lib/store';
import * as presence from './presence';

/** Ön plandayken izin/GPS bu aralıkla yeniden okunur (hızlı ayarlardan GPS kapatma AppState değiştirmez). */
const DEVICE_POLL_MS = 5_000;

let backgroundSince: number | null = null;
/** Harici navigasyon açıldığı an (en çok 2 dk geçerli): dönüşte süreye bakmadan session_sync_request gönderilir. */
let navigationLaunchedAt: number | null = null;
/** Bayrak kurulduktan sonra gerçek background görüldü mü (sahte inactive -> active geçişlerini ayıklar). */
let sawBackground = false;

export function markNavigationLaunched() {
  navigationLaunchedAt = Date.now();
  sawBackground = false;
}

export function cancelNavigationMark() {
  navigationLaunchedAt = null;
}
let pollTimer: ReturnType<typeof setInterval> | undefined;

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => void presence.refreshDeviceState(), DEVICE_POLL_MS);
}

function onChange(next: AppStateStatus) {
  const active = next === 'active';
  store.setState({ appActive: active });
  if (!active) {
    if (next === 'background') {
      backgroundSince ??= Date.now();
      sawBackground = true;
    }
    clearInterval(pollTimer);
    return;
  }
  const away = backgroundSince != null ? Date.now() - backgroundSince : 0;
  backgroundSince = null;
  startPolling();
  // İzin ve GPS yeniden okunur: kullanıcı ayarlardan kapatmış olabilir (C3).
  void presence.refreshDeviceState();
  // S3: socket yeniden kurulmaz; bağlıysa güncel durum istenir.
  const flag = navigationFlagOnForeground(navigationLaunchedAt, Date.now(), sawBackground);
  if (flag !== 'keep') navigationLaunchedAt = null;
  const resync = shouldResyncOnForeground(away, flag === 'resync', BACKGROUND_RESYNC_MS);
  if (resync && isConnected()) void presence.requestSync();
}

/** (app) düzeni bağlanınca çağrılır; dönen fonksiyon aboneliği kaldırır. */
export function startLifecycle(): () => void {
  store.setState({ appActive: AppState.currentState === 'active' });
  if (AppState.currentState === 'active') startPolling();
  const sub = AppState.addEventListener('change', onChange);
  return () => {
    sub.remove();
    clearInterval(pollTimer);
  };
}
