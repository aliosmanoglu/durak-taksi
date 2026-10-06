// E4 Ana ekran (Home.dc.html). Tüm durum mantığı saf `deriveHome`'dadır; burası yalnızca çizer ve eylemleri bağlar.
import { useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatDistance, formatPlate } from '@/lib/format';
import { deriveHome, noticeView, type BannerAction, type HomeView } from '@/lib/presence/home-view';
import { T } from '@/lib/texts';
import { colors, sizes, tones } from '@/lib/theme';
import { enableGps, goOnlineFlow, openSettings } from '@/services/actions';
import * as presence from '@/services/presence';
import { Button, type ButtonVariant } from '@/ui/Button';
import { Banner, Chip, NoticeCard } from '@/ui/Cards';
import { useApp, useNow } from '@/ui/hooks';
import { PersonIcon, Spinner, WarnIcon } from '@/ui/Icons';
import { Txt } from '@/ui/Txt';

const ACCENT = { green: colors.green, red: colors.red, muted: colors.muted, blue: '#9CC8FF' } as const;
const TITLE_COLOR = { green: colors.green, red: colors.red, muted: colors.textSoft, blue: '#9CC8FF' } as const;
const BUTTON_VARIANT: Record<NonNullable<HomeView['button']>['style'], ButtonVariant> = {
  on: 'green',
  off: 'outline',
  light: 'light',
  disabled: 'disabled',
  wait: 'wait',
};

function StatusIcon({ view }: { view: HomeView }) {
  const c = view.accent === 'muted' && view.icon === 'empty' ? colors.ring : ACCENT[view.accent];
  switch (view.icon) {
    case 'filled':
      return (
        <View style={{ width: 96, height: 96, borderRadius: 48, borderWidth: 5, borderColor: c, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: c }} />
        </View>
      );
    case 'empty':
      return <View style={{ width: 96, height: 96, borderRadius: 48, borderWidth: 5, borderColor: c }} />;
    case 'warn':
      return <WarnIcon size={96} color={colors.red} strokeWidth={1.8} />;
    case 'spin':
      return <Spinner size={96} arc={colors.textSoft} strokeWidth={5} />;
  }
}

export default function HomeScreen() {
  const router = useRouter();
  const state = useApp((s) => s);
  const now = useNow(1000);
  const ride = state.activeRide;
  const view = useMemo(() => deriveHome(state, now, { hasActiveRide: ride != null }), [state, now, ride]);
  const notice = state.notice ? noticeView(state.notice) : null;
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  // İlk girişten sonra izin henüz sorulmadıysa E5 (tasarım 2).
  const askedPermission = useRef(false);
  useEffect(() => {
    if (askedPermission.current || state.perm !== 'undetermined' || state.server === 'unknown') return;
    askedPermission.current = true;
    router.push('/permissions');
  }, [state.perm, state.server, router]);

  // Durum değişimleri ekran okuyucuya duyurulur; kırmızı uyarıya geçişte bir kez titreşim.
  const lastTitle = useRef(view.title);
  useEffect(() => {
    if (lastTitle.current !== view.title) {
      lastTitle.current = view.title;
      AccessibilityInfo.announceForAccessibility(view.title);
    }
  }, [view.title]);
  const lastBannerTone = useRef(view.banner?.tone);
  useEffect(() => {
    const tone = view.banner?.tone;
    if (tone === 'red' && lastBannerTone.current !== 'red') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      AccessibilityInfo.announceForAccessibility(view.banner?.text ?? '');
    }
    lastBannerTone.current = tone;
  }, [view.banner?.tone, view.banner?.text]);

  function onButton() {
    switch (view.button?.action) {
      case 'goOnline':
        return void goOnlineFlow(router);
      case 'goOffline':
        return void presence.goOffline();
      case 'openSettings':
        return openSettings();
      default:
        return;
    }
  }

  function onBannerAction(kind: BannerAction) {
    if (kind === 'openSettings') return openSettings();
    if (kind === 'enableGps') return void enableGps();
    router.push('/permissions');
  }

  // Faz 3 (4.2): açık çağrılar alanı ve aktif yolculuk kartı.
  const liveRequests = state.requests.filter((r) => !r.taken);
  const nearest = liveRequests[0];
  const requestsCard =
    !ride && state.server === 'available' && nearest ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${T.ride.home.openRequests(liveRequests.length)}. ${nearest.pickupAddress}`}
        onPress={() => router.push('/requests')}
        style={({ pressed }) => ({
          gap: 6,
          padding: 18,
          borderRadius: 18,
          backgroundColor: tones.yellow.bg,
          borderWidth: 1,
          borderColor: tones.yellow.border,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <Txt bold size={24} color={tones.yellow.color}>
            {T.ride.home.openRequests(liveRequests.length)}
          </Txt>
          {state.unseen.length > 0 ? (
            <Txt bold size={16} color={colors.bg} style={{ backgroundColor: tones.yellow.color, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
              {T.ride.home.newBadge}
            </Txt>
          ) : null}
        </View>
        <Txt size={19} color={colors.textBody} numberOfLines={2}>
          {formatDistance(nearest.distanceM)} · {nearest.pickupAddress}
        </Txt>
      </Pressable>
    ) : null;
  const rideCard = ride ? (
    <View style={{ gap: 14, padding: 18, borderRadius: 18, backgroundColor: tones.blue.bg, borderWidth: 1, borderColor: tones.blue.border }}>
      <View style={{ gap: 4 }}>
        <Txt bold size={22} color={tones.blue.color}>
          {T.ride.home.activeRide(ride.shortCode)}
        </Txt>
        <Txt size={19} color={colors.textBody} numberOfLines={2}>
          {ride.pickupAddress}
        </Txt>
      </View>
      <Button label={T.ride.home.goToRide} variant="blue" height={88} fontSize={26} radius={22} onPress={() => router.push(`/ride/${ride.rideId}`)} />
    </View>
  ) : null;

  const plate = state.profile?.plate ? formatPlate(state.profile.plate) : '—';
  const updating = state.syncPending && state.conn === 'connected' && state.server !== 'unknown';

  const header = (
    <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 16, gap: 14, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ gap: 2 }}>
          <Txt size={16} color={colors.muted} style={{ letterSpacing: 1.1 }}>
            {T.home.plate}
            {updating ? `  ·  ${T.common.updating}` : ''}
          </Txt>
          <Txt bold size={26} style={{ letterSpacing: 1 }}>
            {plate}
          </Txt>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={T.home.account}
          onPress={() => router.push('/account')}
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
          <PersonIcon />
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {view.chips.map((c) => (
          <Chip key={c.label} chip={c} />
        ))}
      </View>
    </View>
  );

  const status = (
    <View
      style={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 16, minHeight: 220 }}
      accessibilityLiveRegion="polite"
    >
      <StatusIcon view={view} />
      <Txt bold size={sizes.title} color={TITLE_COLOR[view.accent]} accessibilityRole="header" style={{ textAlign: 'center', lineHeight: 44 }}>
        {view.title}
      </Txt>
      {view.sub ? (
        <Txt size={sizes.body} color={colors.textSoft} style={{ textAlign: 'center', lineHeight: 28, maxWidth: 320 }}>
          {view.sub}
        </Txt>
      ) : null}
    </View>
  );

  const button = view.button ? (
    <Button
      label={view.button.label}
      variant={BUTTON_VARIANT[view.button.style]}
      disabled={!view.button.enabled}
      height={sizes.homeButton}
      fontSize={28}
      radius={22}
      onPress={onButton}
      accessibilityLabel={T.home.buttonA11y(view.button.label, view.title)}
    />
  ) : null;

  const banner = view.banner ? (
    <Banner banner={view.banner} onAction={view.banner.action ? () => onBannerAction(view.banner!.action!.kind) : undefined} />
  ) : null;

  const noticeCard = notice ? <NoticeCard notice={notice} onClose={presence.dismissNotice} /> : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'left', 'right', 'bottom']}>
      {header}
      {landscape ? (
        <View style={{ flex: 1, flexDirection: 'row', padding: 20, gap: 20 }}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, gap: 20 }}>
            {noticeCard}
            {status}
          </ScrollView>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', gap: 20 }}>
            {rideCard}
            {requestsCard}
            {button}
            {banner}
          </ScrollView>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 20, gap: 20 }}>
          {noticeCard}
          {requestsCard}
          {status}
          {rideCard}
          {button}
          {banner}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
