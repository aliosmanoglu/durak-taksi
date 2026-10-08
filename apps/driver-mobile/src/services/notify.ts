// Bildirim altyapısı: yerel bildirimler (pasife düşme, oturum sonu), Android kanalları ve ön plan işleyicisi.
// Push kaydı / dokunma: push.ts.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { PUSH } from '@duraknet/shared';
import { shouldPresentInForeground } from '@/lib/push';
import { isConnected } from '@/lib/realtime';

const CHANNEL = 'status';
let prepared: Promise<void> | null = null;

/** İşleyici ve Android kanalları (`status`, `rides`); idempotent. Push kaydından önce de çağrılır. */
export function prepareNotifications(): Promise<void> {
  prepared ??= (async () => {
    Notifications.setNotificationHandler({
      handleNotification: async (n) => {
        // Ön plandayken ride_requested push'u yalnızca socket bağlıyken gösterilmez (çağrıyı socket getirir); yerel
        // bildirimler (veri yok) ve diğer tipler eskisi gibi gösterilir.
        const show = shouldPresentInForeground(n.request.content.data, isConnected());
        return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: false, shouldSetBadge: false };
      },
    });
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: 'Durum',
        importance: Notifications.AndroidImportance.HIGH,
      });
      await Notifications.setNotificationChannelAsync(PUSH.ANDROID_CHANNEL, {
        name: 'Çağrılar',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
        vibrationPattern: [0, 400, 200, 400],
      });
    }
  })();
  return prepared;
}

const prepare = prepareNotifications;

export async function notifyLocal(body: string) {
  try {
    await prepare();
    await Notifications.scheduleNotificationAsync({
      content: { title: 'DurakNet', body },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
    });
  } catch {
    // Bildirim izni yoksa sessizce geçilir.
  }
}

export async function readNotificationPermission(): Promise<'granted' | 'denied' | 'undetermined'> {
  try {
    const p = await Notifications.getPermissionsAsync();
    return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'undetermined';
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  try {
    await prepare();
    return (await Notifications.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}
