// Oturum şart. Ön plan/arka plan yaşam döngüsünü başlatır; E5 modal sunulur.
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';
import { startLifecycle } from '@/services/lifecycle';

export const unstable_settings = { initialRouteName: 'index' };

export default function AppLayout() {
  useEffect(() => startLifecycle(), []);
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="permissions" options={{ presentation: 'modal' }} />
      <Stack.Screen name="account" />
    </Stack>
  );
}
