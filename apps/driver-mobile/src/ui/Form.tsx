import { forwardRef } from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import { T } from '@/lib/texts';
import { BackIcon } from './Icons';
import { Txt } from './Txt';

type FieldProps = TextInputProps & {
  label: string;
  error?: string | null;
  height?: number;
  fontSize?: number;
  /** Sağdaki ek düğme (ör. şifre "Göster"). */
  trailing?: React.ReactNode;
};

/** Görünür etiketli alan (placeholder'a güvenilmez); hata alan altında. */
export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { label, error, height = 60, fontSize = 22, trailing, style, ...rest },
  ref,
) {
  return (
    <View style={{ gap: 8 }}>
      <Txt size={17} color={colors.textSoft} nativeID={`label-${label}`}>
        {label}
      </Txt>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          accessibilityLabelledBy={`label-${label}`}
          placeholderTextColor={colors.disabledText}
          selectionColor={colors.green}
          maxFontSizeMultiplier={2}
          {...rest}
          style={[
            {
              flex: 1,
              minWidth: 0,
              minHeight: height,
              paddingHorizontal: 16,
              borderRadius: 14,
              backgroundColor: colors.surface,
              borderWidth: 1.5,
              borderColor: error ? colors.red : colors.inputBorder,
              color: colors.text,
              fontSize,
              fontFamily: fonts.regular,
            },
            style,
          ]}
        />
        {trailing}
      </View>
      {error ? (
        <Txt size={16} color={colors.redSoft} accessibilityLiveRegion="polite">
          {error}
        </Txt>
      ) : null}
    </View>
  );
});

/** Geri düğmeli başlık (E2, E6). */
export function TopBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={T.common.back}
        onPress={onBack}
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <BackIcon />
      </Pressable>
      <Txt bold size={28} accessibilityRole="header">
        {title}
      </Txt>
    </View>
  );
}
