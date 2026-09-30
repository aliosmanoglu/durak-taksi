// Yerel bildirimler (uygulama arka plandayken: pasife düşme, oturum sonu). Push Faz 5'tedir.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

const CHANNEL = 'status';
let prepared = false;

async function prepare() {
  if (prepared) return;
  prepared = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'Durum',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
}

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
