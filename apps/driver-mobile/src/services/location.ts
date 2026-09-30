// expo-location sarmalayıcıları ve arka plan konum görevi. Koordinatlar loglanmaz.
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { GO_ONLINE_FIX_TIMEOUT_MS, LOCATION_INTERVAL_MS } from '@/lib/constants';
import { log } from '@/lib/log';
import type { Fix, Gps, Perm } from '@/lib/presence/state';
import { T } from '@/lib/texts';
import { colors } from '@/lib/theme';

export const LOCATION_TASK = 'duraknet-location';

type LocationListener = (fix: Fix) => void;
let listener: LocationListener | null = null;

/** Konum görevinden gelen her konum bu dinleyiciye verilir (presence servisi kaydeder). */
export function setLocationListener(fn: LocationListener | null) {
  listener = fn;
}

export function toFix(l: Location.LocationObject): Fix {
  const h = l.coords.heading;
  return {
    at: l.timestamp || Date.now(),
    lat: l.coords.latitude,
    lng: l.coords.longitude,
    accuracy: l.coords.accuracy ?? null,
    heading: h != null && h >= 0 && h <= 360 ? h : undefined,
  };
}

// Görev modül seviyesinde tanımlanmalıdır (uygulama girişinde import edilir: app/_layout.tsx).
TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    log('location.task_error', { code: error.code });
    return;
  }
  const locations = data?.locations ?? [];
  const last = locations[locations.length - 1];
  if (last && listener) listener(toFix(last));
});

export async function readPermission(): Promise<{ perm: Perm; precise: boolean }> {
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    const precise = Platform.OS === 'android' ? fg.android?.accuracy !== 'coarse' : fg.ios?.accuracy !== 'reduced';
    if (fg.status !== 'granted') {
      if (fg.status === 'undetermined' && fg.canAskAgain) return { perm: 'undetermined', precise };
      return { perm: fg.canAskAgain ? 'denied' : 'deniedForever', precise };
    }
    const bg = await Location.getBackgroundPermissionsAsync();
    return { perm: bg.status === 'granted' ? 'background' : 'foreground', precise };
  } catch {
    return { perm: 'undetermined', precise: true };
  }
}

export async function readGps(): Promise<Gps> {
  try {
    return (await Location.hasServicesEnabledAsync()) ? 'on' : 'off';
  } catch {
    return 'unknown';
  }
}

/** Android: sistem "konumu aç" diyaloğu. Kullanıcı reddederse hata fırlatır → false. */
export async function requestEnableGps(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    await Location.enableNetworkProviderAsync();
    return true;
  } catch {
    return false;
  }
}

/** Yüksek doğrulukla tek konum; 10 sn içinde gelmezse null. */
export async function getFreshFix(timeoutMs = GO_ONLINE_FIX_TIMEOUT_MS): Promise<Fix | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const loc = await Promise.race([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }), timeout]);
    return loc ? toFix(loc) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Son bilinen konum (GPS'i çalıştırmaz); pasifken konum çipinin doğruluğu için. */
export async function getLastKnownFix(): Promise<Fix | null> {
  try {
    const loc = await Location.getLastKnownPositionAsync();
    return loc ? toFix(loc) : null;
  } catch {
    return null;
  }
}

export async function isTracking(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    return false;
  }
}

/**
 * Konum görevini başlatır (Android: kalıcı foreground service bildirimi; iOS: arka plan konumu).
 * Zaten çalışıyorsa dokunmaz.
 */
export async function startTracking(): Promise<boolean> {
  try {
    if (await isTracking()) return true;
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: LOCATION_INTERVAL_MS,
      distanceInterval: 0,
      showsBackgroundLocationIndicator: true,
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.AutomotiveNavigation,
      foregroundService: {
        notificationTitle: T.fgs.title,
        notificationBody: T.fgs.body,
        notificationColor: colors.green,
        killServiceOnDestroy: false,
      },
    });
    return true;
  } catch (e) {
    log('location.start_failed', { error: e instanceof Error ? e.name : 'unknown' });
    return false;
  }
}

export async function stopTracking(): Promise<void> {
  try {
    if (await isTracking()) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch (e) {
    log('location.stop_failed', { error: e instanceof Error ? e.name : 'unknown' });
  }
}
