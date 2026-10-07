// Kök: oturum kapısı (booting → (auth) | (app)) ve koyu tema. Konum görevi burada, modül seviyesinde
// tanımlanır (expo-task-manager şartı: görev uygulama girişinde kayıtlı olmalı).
import '@/services/location';
import { useEffect } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
// Yalnızca kullanılan iki kesim içe aktarılır (paket kökü italikleri de pakete ekler).
import { AtkinsonHyperlegible_400Regular } from '@expo-google-fonts/atkinson-hyperlegible/400Regular';
import { AtkinsonHyperlegible_700Bold } from '@expo-google-fonts/atkinson-hyperlegible/700Bold';
import { colors } from '@/lib/theme';
import { T } from '@/lib/texts';
import { boot } from '@/services/session';
import { useApp } from '@/ui/hooks';
import { Spinner } from '@/ui/Icons';
import { Txt } from '@/ui/Txt';
import { Toast } from '@/ui/Toast';

void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ AtkinsonHyperlegible_400Regular, AtkinsonHyperlegible_700Bold });
  const auth = useApp((s) => s.auth);

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    if (fontsLoaded) void SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {auth === 'booting' ? (
        <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 20 }}>
          <Spinner size={56} />
          <Txt size={20} color={colors.textSoft}>
            {T.common.loading}
          </Txt>
        </View>
      ) : (
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
          <Stack.Protected guard={auth === 'signedIn'}>
            <Stack.Screen name="(app)" />
          </Stack.Protected>
          <Stack.Protected guard={auth === 'signedOut'}>
            <Stack.Screen name="(auth)" />
          </Stack.Protected>
        </Stack>
      )}
      <Toast />
    </SafeAreaProvider>
  );
}
