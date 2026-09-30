// Onaylı tasarımdaki (*.dc.html) SVG ikonları.
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { colors } from '@/lib/theme';

type P = { size?: number; color?: string };

export const WarnIcon = ({ size = 24, color = colors.red, strokeWidth = 2.2 }: P & { strokeWidth?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <Path d="M12 9v4" />
    <Path d="M12 17h.01" />
  </Svg>
);

export const InfoIcon = ({ size = 24, color = colors.red }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <Circle cx="12" cy="12" r="10" />
    <Path d="M12 7v6" />
    <Path d="M12 17h.01" />
  </Svg>
);

export const PersonIcon = ({ size = 26, color = colors.text }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <Circle cx="12" cy="8" r="4" />
    <Path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
  </Svg>
);

export const BackIcon = ({ size = 24, color = colors.text }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M15 5l-7 7 7 7" />
  </Svg>
);

export const ChevronIcon = ({ size = 20, color = colors.muted }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M9 5l7 7-7 7" />
  </Svg>
);

export const CloseIcon = ({ size = 20, color = colors.textBody }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round">
    <Path d="M6 6l12 12" />
    <Path d="M18 6L6 18" />
  </Svg>
);

export const CheckIcon = ({ size = 24, color = colors.green }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M5 12l5 5 9-10" />
  </Svg>
);

export const PinIcon = ({ size = 52, color = colors.green }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z" />
    <Circle cx="12" cy="9" r="2.6" />
  </Svg>
);

export const ClockIcon = ({ size = 88, color = colors.yellow }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <Circle cx="12" cy="12" r="10" />
    <Path d="M12 6v6l4 2" />
  </Svg>
);

/** Döner gösterge. "Hareketi azalt" açıksa döndürülmez (tasarım 8). */
export function Spinner({
  size = 28,
  track = colors.border,
  arc = colors.muted,
  strokeWidth = 6,
}: {
  size?: number;
  track?: string;
  arc?: string;
  strokeWidth?: number;
}) {
  const [spin] = useState(() => new Animated.Value(0));
  useEffect(() => {
    let loop: Animated.CompositeAnimation | undefined;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled || reduce) return;
      loop = Animated.loop(
        Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
      );
      loop.start();
    });
    return () => {
      cancelled = true;
      loop?.stop();
    };
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const r = 24 - strokeWidth / 2 - 1;
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
      <Svg width={size} height={size} viewBox="0 0 48 48" fill="none" strokeWidth={strokeWidth} strokeLinecap="round">
        <Circle cx="24" cy="24" r={r} stroke={track} />
        <Path d={`M24 ${24 - r}a${r} ${r} 0 0 1 ${r} ${r}`} stroke={arc} />
      </Svg>
    </Animated.View>
  );
}
