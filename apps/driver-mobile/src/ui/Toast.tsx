import { useEffect } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOAST_MS } from '@/lib/constants';
import { store } from '@/lib/store';
import { colors } from '@/lib/theme';
import { useApp } from './hooks';
import { Txt } from './Txt';

/** Kısa bildirim (ör. "Bağlantı yok. Bağlanınca tekrar deneyin."); 4 sn sonra kalkar. */
export function Toast() {
  const toast = useApp((s) => s.toast);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!toast) return;
    AccessibilityInfo.announceForAccessibility(toast.text);
    const t = setTimeout(() => {
      if (store.getState().toast?.id === toast.id) store.setState({ toast: null });
    }, toast.ms ?? TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 16, alignItems: 'center' }}
    >
      <View
        accessibilityLiveRegion="polite"
        style={{
          paddingVertical: 14,
          paddingHorizontal: 18,
          borderRadius: 16,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.inputBorder,
        }}
      >
        <Txt bold size={18} style={{ textAlign: 'center' }}>
          {toast.text}
        </Txt>
      </View>
    </View>
  );
}
