// Oturum şart. Ön plan/arka plan yaşam döngüsünü başlatır; E5 ve D1 modal sunulur; çağrı/yolculuk rotaları
// RideNavigator tarafından açılıp kapatılır.
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';
import { startLifecycle } from '@/services/lifecycle';
import { RideNavigator } from '@/ui/RideNavigator';

export const unstable_settings = { initialRouteName: 'index' };

export default function AppLayout() {
  useEffect(() => startLifecycle(), []);
  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="permissions" options={{ presentation: 'modal' }} />
        <Stack.Screen name="requests" options={{ presentation: 'modal' }} />
        <Stack.Screen name="account" />
        <Stack.Screen name="ride/[rideId]" />
        <Stack.Screen name="ride/closed" options={{ gestureEnabled: false }} />
      </Stack>
      <RideNavigator />
    </>
  );
}
