// KVKK aydınlatma metni ekranı (taslak). Kayıt ekranından açılır; geri ile dönülür.
import { ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KVKK_DRAFT_LABEL, KVKK_NOTICE_PARAGRAPHS, KVKK_NOTICE_TITLE, KVKK_NOTICE_VERSION } from '@/lib/kvkk';
import { colors } from '@/lib/theme';
import { T } from '@/lib/texts';
import { Button } from '@/ui/Button';
import { TopBar } from '@/ui/Form';
import { Txt } from '@/ui/Txt';

export default function KvkkScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 16, gap: 16 }}>
        <TopBar title={`${KVKK_NOTICE_TITLE} (${KVKK_DRAFT_LABEL})`} onBack={() => router.back()} />
        {KVKK_NOTICE_PARAGRAPHS.map((p, i) => (
          <Txt key={i} size={18} color={colors.textBody}>
            {p}
          </Txt>
        ))}
        <Txt size={16} color={colors.muted}>
          Sürüm: {KVKK_NOTICE_VERSION}
        </Txt>
        <Button label={T.common.back.toUpperCase()} variant="light" height={64} fontSize={22} onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
