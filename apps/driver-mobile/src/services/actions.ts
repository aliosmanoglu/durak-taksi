// Ekranların ortak kullanıcı eylemleri (izin, GPS, ayarlar). Diyaloglar Türkçe metinlerle.
import { Alert, Linking, Platform } from 'react-native';
import type { useRouter } from 'expo-router';
import { T } from '@/lib/texts';
import { requestEnableGps } from './location';
import * as presence from './presence';

type Router = ReturnType<typeof useRouter>;

export function openSettings() {
  void Linking.openSettings().catch(() => {});
}

export function alertDeniedForever() {
  Alert.alert(T.perm.deniedForever, undefined, [
    { text: T.perm.later, style: 'cancel' },
    { text: T.common.openSettings, onPress: openSettings },
  ]);
}

/** GPS kapalı: Android sistem diyaloğu; iOS'ta ayarlara yönlendirme. `then` açıldıktan sonra çalışır. */
export async function enableGps(then?: () => void) {
  if (Platform.OS === 'android') {
    if (await requestEnableGps()) {
      await presence.refreshDeviceState();
      then?.();
    }
    return;
  }
  Alert.alert(T.gps.offIos, undefined, [
    { text: T.perm.later, style: 'cancel' },
    { text: T.common.openSettings, onPress: openSettings },
  ]);
}

/** AKTİF OL (E4 etkileşim adımları 1–7). */
export async function goOnlineFlow(router: Router) {
  const r = await presence.goOnline();
  if (r.ok) return;
  switch (r.block) {
    case 'perm':
      router.push({ pathname: '/permissions', params: { resume: 'goOnline' } });
      return;
    case 'deniedForever':
      alertDeniedForever();
      return;
    case 'gps':
      await enableGps(() => void goOnlineFlow(router));
      return;
    default:
      // 'conn': kısa bildirim servis tarafından gösterildi; 'busy': zaten bir geçiş sürüyor.
      return;
  }
}
