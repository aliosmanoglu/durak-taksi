// E3 Onay bekleniyor (Pending.dc.html). Şifresiz durum sorgulama ucu olmadığı için yoklama yapılmaz (S8).
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { T } from '@/lib/texts';
import { colors } from '@/lib/theme';
import { Button } from '@/ui/Button';
import { ClockIcon } from '@/ui/Icons';
import { Txt } from '@/ui/Txt';

export default function PendingScreen() {
  const router = useRouter();
  const back = () => (router.canGoBack() ? router.back() : router.replace('/login'));
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, padding: 24, gap: 24 }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 }}>
        <ClockIcon />
        <Txt bold size={32} accessibilityRole="header" style={{ textAlign: 'center', lineHeight: 37 }}>
          {T.pending.title}
        </Txt>
        <Txt size={20} color={colors.textSoft} style={{ textAlign: 'center', lineHeight: 29 }}>
          {T.pending.body}
        </Txt>
      </View>
      <Button label={T.pending.back} onPress={back} />
      <Txt size={16} color={colors.muted} style={{ textAlign: 'center' }}>
        {T.pending.hint}
      </Txt>
    </SafeAreaView>
  );
}
