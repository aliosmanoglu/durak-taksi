import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { store } from '@/lib/store';
import { colors } from '@/lib/theme';
import { useApp } from '@/ui/hooks';

export const unstable_settings = { initialRouteName: 'login' };

export default function AuthLayout() {
  const router = useRouter();
  const showPending = useApp((s) => s.showPending);

  // Oturum ACCOUNT_PENDING ile bittiyse giriş yerine E3.
  useEffect(() => {
    if (!showPending) return;
    store.setState({ showPending: false });
    router.push('/pending');
  }, [showPending, router]);

  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
