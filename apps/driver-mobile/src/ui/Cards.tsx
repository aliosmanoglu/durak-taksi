// Uyarı şeridi (kapatılamaz), bildirim kartı (kapatılabilir), durum çipi ve form şeridi.
import { Pressable, View } from 'react-native';
import type { Banner as BannerModel, Chip as ChipModel, NoticeView } from '@/lib/presence/home-view';
import { colors, tones } from '@/lib/theme';
import { T } from '@/lib/texts';
import { CloseIcon, InfoIcon, WarnIcon } from './Icons';
import { Txt } from './Txt';

export function Banner({ banner, onAction }: { banner: BannerModel; onAction?: () => void }) {
  const t = tones[banner.tone];
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{ gap: 12, padding: 16, borderRadius: 16, backgroundColor: t.bg, borderWidth: 1, borderColor: t.border }}
    >
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
        <View style={{ marginTop: 1 }}>
          <WarnIcon color={t.color} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Txt bold size={18} color={t.color} style={{ lineHeight: 24 }}>
            {banner.text}
          </Txt>
          {banner.sub ? (
            <Txt size={16} color={colors.textBody} style={{ lineHeight: 22 }}>
              {banner.sub}
            </Txt>
          ) : null}
        </View>
      </View>
      {banner.action ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          style={({ pressed }) => ({
            minHeight: 56,
            borderRadius: 14,
            backgroundColor: t.color,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Txt bold size={19} color={colors.bg} style={{ letterSpacing: 0.8 }}>
            {banner.action.label}
          </Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

export function NoticeCard({ notice, onClose }: { notice: NoticeView; onClose: () => void }) {
  const t = tones[notice.tone];
  return (
    <View
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        gap: 12,
        alignItems: 'flex-start',
        padding: 16,
        borderRadius: 16,
        backgroundColor: t.bg,
        borderWidth: 1,
        borderColor: t.border,
      }}
    >
      <View style={{ flex: 1, gap: 6 }}>
        <Txt bold size={20} color={t.color}>
          {notice.title}
        </Txt>
        <Txt size={17} color={colors.textBody} style={{ lineHeight: 24 }}>
          {notice.text}
        </Txt>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={T.home.dismissNotice}
        onPress={onClose}
        hitSlop={4}
        style={{
          width: 48,
          height: 48,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <CloseIcon />
      </Pressable>
    </View>
  );
}

const chipColor = { green: colors.green, yellow: colors.yellow, red: colors.red, muted: colors.muted } as const;

export function Chip({ chip }: { chip: ChipModel }) {
  const c = chipColor[chip.color];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 36,
        paddingHorizontal: 12,
        borderRadius: 18,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c }} />
      <Txt size={16} color={c}>
        {chip.label}
      </Txt>
    </View>
  );
}

/** Giriş ekranı şeridi (daire içinde ünlem). */
export function FormBanner({ tone, text }: { tone: 'red' | 'yellow' | 'blue'; text: string }) {
  const t = tones[tone];
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        gap: 12,
        alignItems: 'flex-start',
        padding: 16,
        borderRadius: 16,
        backgroundColor: t.bg,
        borderWidth: 1,
        borderColor: t.border,
      }}
    >
      <View style={{ marginTop: 1 }}>
        <InfoIcon color={t.color} />
      </View>
      <Txt bold size={18} color={t.color} style={{ flex: 1, lineHeight: 24 }}>
        {text}
      </Txt>
    </View>
  );
}
