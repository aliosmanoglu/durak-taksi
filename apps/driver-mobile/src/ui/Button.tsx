import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, sizes } from '@/lib/theme';
import { Spinner } from './Icons';
import { Txt } from './Txt';

export type ButtonVariant = 'green' | 'blue' | 'outline' | 'light' | 'disabled' | 'wait' | 'danger' | 'ghost' | 'secondary';

const V: Record<ButtonVariant, { bg: string; border: string; color: string }> = {
  green: { bg: colors.green, border: colors.green, color: colors.greenInk },
  blue: { bg: '#9CC8FF', border: '#9CC8FF', color: colors.bg },
  outline: { bg: colors.bg, border: colors.outline, color: colors.text },
  light: { bg: colors.light, border: colors.light, color: colors.bg },
  disabled: { bg: colors.surface, border: colors.border, color: colors.disabledText },
  wait: { bg: colors.surface, border: colors.border, color: colors.muted },
  danger: { bg: 'transparent', border: colors.red, color: colors.redSoft },
  ghost: { bg: 'transparent', border: 'transparent', color: colors.textSoft },
  secondary: { bg: 'transparent', border: colors.outlineSoft, color: colors.text },
};

type Props = {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  height?: number;
  fontSize?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  radius?: number;
};

/** Birincil düğme varsayılan 88 dp; ikincil hedefler en az 56 dp (tasarım 4). */
export function Button({
  label,
  onPress,
  variant = 'light',
  disabled,
  height = sizes.primaryButton,
  fontSize = 26,
  accessibilityLabel,
  style,
  radius = 20,
}: Props) {
  const v = V[variant];
  const busy = variant === 'wait';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: height,
          borderRadius: radius,
          backgroundColor: v.bg,
          borderWidth: 2,
          borderColor: v.border,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 16,
          opacity: pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        {busy ? <Spinner size={28} /> : null}
        <Txt bold size={fontSize} color={v.color} style={{ letterSpacing: fontSize * 0.04, textAlign: 'center' }}>
          {label}
        </Txt>
      </View>
    </Pressable>
  );
}
