import { Text, type TextProps } from 'react-native';
import { colors, fonts } from '@/lib/theme';

type Props = TextProps & { bold?: boolean; size?: number; color?: string };

/** Atkinson Hyperlegible metni. Hiçbir metin 16 sp altında değildir (tasarım 4). */
export function Txt({ bold, size = 18, color = colors.text, style, ...rest }: Props) {
  return (
    <Text
      maxFontSizeMultiplier={2}
      {...rest}
      style={[{ fontFamily: bold ? fonts.bold : fonts.regular, fontSize: Math.max(16, size), color }, style]}
    />
  );
}
