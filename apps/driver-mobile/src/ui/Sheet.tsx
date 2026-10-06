// Alttan açılan onay penceresi (Hesap'taki çıkış diyaloğuyla aynı görünüm). Güvenli seçenek (VAZGEÇ) çağıran
// tarafından büyük ve ilk sırada verilir; arka plana dokunmak ya da geri tuşu pencereyi kapatır (eylem yapmaz).
import { Modal, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '@/lib/theme';
import { Txt } from './Txt';

export function Sheet({
  visible,
  onClose,
  title,
  body,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  body?: string;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: 'rgba(3, 5, 8, 0.78)', justifyContent: 'flex-end', padding: 16 }}>
        <SafeAreaView edges={['bottom']}>
          <View
            accessibilityViewIsModal
            style={{ padding: 24, borderRadius: 24, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.inputBorder, gap: 16 }}
          >
            <Txt bold size={26} accessibilityRole="header">
              {title}
            </Txt>
            {body ? (
              <Txt size={19} color={colors.textSoft} style={{ lineHeight: 28 }}>
                {body}
              </Txt>
            ) : null}
            {children}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
