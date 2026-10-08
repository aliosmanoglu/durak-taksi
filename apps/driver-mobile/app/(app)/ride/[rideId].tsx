// D2 Kabul/Detay (faz3 4.5): alış noktasına gitmek ve müşteriyi alınca yolculuğu kapatmak.
// - NAVİGASYON bağlantıdan bağımsızdır (alış koordinatı yerelde); harici harita uygulaması `src/lib/navigation.ts`
//   üzerinden açılır, uygulama içinde rota çizilmez.
// - TAMAMLA ve "Çağrıyı iptal et" sunucu onayı gerektirir; çevrimdışı / sync beklenirken devre dışıdır.
// - "Çağrıyı iptal et" birincil hedeflerden ayrık ve onay diyaloglu; müşteri adı/telefonu gösterilmez.
import { useMemo, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NavApp } from '@/lib/navigation';
import { deriveDetail } from '@/lib/rides/ride-view';
import { T } from '@/lib/texts';
import { colors, tones } from '@/lib/theme';
import { goOnlineFlow } from '@/services/actions';
import { launchNavigation, planNavigation } from '@/services/navigation';
import { cancelActiveRide, clearRideNotice, completeRide } from '@/services/rides';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Cards';
import { useApp } from '@/ui/hooks';
import { BackIcon, WarnIcon } from '@/ui/Icons';
import { Sheet } from '@/ui/Sheet';
import { Txt } from '@/ui/Txt';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

type Dialog = null | 'complete' | 'cancel' | 'nav';

function Strip({ tone, text, action }: { tone: 'yellow' | 'blue'; text: string; action?: { label: string; onPress: () => void; disabled?: boolean } }) {
  const t = tones[tone];
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{ gap: 12, padding: 14, borderRadius: 14, backgroundColor: t.bg, borderWidth: 1, borderColor: t.border }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <WarnIcon color={t.color} />
        <Txt bold size={17} color={t.color} style={{ flex: 1 }}>
          {text}
        </Txt>
      </View>
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !!action.disabled }}
          disabled={action.disabled}
          onPress={action.onPress}
          style={({ pressed }) => ({ minHeight: 56, borderRadius: 14, backgroundColor: t.color, alignItems: 'center', justifyContent: 'center', opacity: action.disabled ? 0.5 : pressed ? 0.8 : 1 })}
        >
          <Txt bold size={19} color={colors.bg} style={{ letterSpacing: 0.8 }}>
            {action.label}
          </Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function RideDetailScreen() {
  const router = useRouter();
  const state = useApp((s) => s);
  const view = useMemo(() => deriveDetail(state), [state]);
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const ride = state.activeRide;

  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [navApps, setNavApps] = useState<NavApp[]>([]);
  const [makeDefault, setMakeDefault] = useState(false);
  const [navFailed, setNavFailed] = useState(false);
  const [sharing, setSharing] = useState(false);

  // Yolculuk bittiyse RideNavigator ekranı kapatır (D3 / ana ekran); o ana kadar boş zemin.
  if (!ride) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} />;

  async function go(app?: NavApp, asDefault = false) {
    setDialog(null);
    const res = await launchNavigation(ride!.pickup, app, asDefault);
    setNavFailed(res === 'failed');
  }

  async function onNavigate() {
    setNavFailed(false);
    const d = await planNavigation(ride!.pickup);
    if (d.kind === 'choose') {
      setNavApps(d.apps);
      setMakeDefault(false);
      setDialog('nav');
    } else await go(d.kind === 'open' ? d.app : undefined);
  }

  function onCallStand() {
    void Linking.openURL(`tel:${ride!.stand.phone}`).catch(() => {});
  }

  async function onShareLocation() {
    setSharing(true);
    try {
      await goOnlineFlow(router);
    } finally {
      setSharing(false);
    }
  }

  const connChip =
    state.conn === 'connected'
      ? { label: T.chip.connected, color: 'green' as const }
      : state.conn === 'connecting'
        ? { label: T.chip.connecting, color: 'muted' as const }
        : { label: T.chip.disconnected, color: 'yellow' as const };
  const shareChip = view.sharing
    ? { label: T.ride.detail.sharingLocation, color: 'green' as const }
    : { label: T.ride.detail.notSharing, color: 'yellow' as const };

  const header = (
    <View style={{ gap: 12, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={T.common.back}
          onPress={() => router.back()}
          style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }}
        >
          <BackIcon />
        </Pressable>
        <Txt bold size={32} style={{ fontFamily: MONO, letterSpacing: 2, flex: 1 }}>
          {ride.shortCode}
        </Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 40, borderRadius: 12, backgroundColor: tones.blue.bg, borderWidth: 1, borderColor: tones.blue.border }}>
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: tones.blue.color }} />
          <Txt bold size={16} color={tones.blue.color}>
            {T.ride.detail.matched}
          </Txt>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Chip chip={connChip} />
        <Chip chip={shareChip} />
      </View>
    </View>
  );

  const label = (t: string) => (
    <Txt bold size={16} color={colors.muted} style={{ letterSpacing: 1.1 }}>
      {t}
    </Txt>
  );

  const info = (
    <View style={{ gap: 14, opacity: view.loading ? 0.6 : 1 }}>
      {view.loading ? <Strip tone="blue" text={T.ride.detail.updating} /> : null}
      <View style={{ gap: 6 }}>
        {label(T.ride.detail.pickup)}
        <Txt bold size={28} style={{ lineHeight: 34 }}>
          {ride.pickupAddress}
        </Txt>
      </View>
      {ride.dropoffAddress ? (
        <View style={{ gap: 6 }}>
          {label(T.ride.detail.dropoff)}
          <Txt size={22} color={colors.textSoft} style={{ lineHeight: 28 }}>
            → {ride.dropoffAddress}
          </Txt>
        </View>
      ) : null}
      {ride.notes ? (
        <View style={{ gap: 6 }}>
          {label(T.ride.detail.note)}
          <Txt size={20} color={colors.textBody} style={{ lineHeight: 26 }}>
            {ride.notes}
          </Txt>
        </View>
      ) : null}
      <View style={{ gap: 6 }}>
        {label(T.ride.detail.stand)}
        <Txt size={20} color={colors.textBody}>
          {ride.stand.name}
        </Txt>
      </View>
    </View>
  );

  const strips = (
    <View style={{ gap: 12 }}>
      {view.offline ? <Strip tone="yellow" text={T.ride.detail.offline} /> : null}
      {view.noLocation ? (
        <Strip
          tone="yellow"
          text={T.ride.detail.noLocation}
          action={{ label: T.ride.detail.shareLocation, onPress: () => void onShareLocation(), disabled: sharing || state.intent !== 'none' }}
        />
      ) : null}
    </View>
  );

  const actions = (
    <View style={{ gap: 16 }}>
      <Button
        label={T.ride.detail.navigate}
        variant="blue"
        disabled={!view.navigateEnabled}
        height={112}
        fontSize={30}
        radius={24}
        onPress={() => void onNavigate()}
      />
      {navFailed ? (
        <Txt size={17} color={tones.yellow.color} accessibilityLiveRegion="polite">
          {T.ride.detail.navFailed}
        </Txt>
      ) : null}
      <Button
        label={view.completing ? T.ride.detail.completing : T.ride.detail.complete}
        variant={view.completing ? 'wait' : view.serverActionsEnabled ? 'green' : 'disabled'}
        disabled={!view.serverActionsEnabled}
        height={88}
        fontSize={24}
        radius={22}
        onPress={() => setDialog('complete')}
      />
      {view.callStandEnabled ? (
        <Button label={T.ride.detail.callStand} variant="secondary" height={56} fontSize={19} radius={16} onPress={onCallStand} />
      ) : null}
      {state.rideMessage ? (
        <Pressable onPress={clearRideNotice} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Txt size={17} color={colors.textSoft} style={{ lineHeight: 24 }}>
            {state.rideMessage}
          </Txt>
        </Pressable>
      ) : null}
    </View>
  );

  const cancel = (
    <Button
      label={view.cancelling ? T.ride.detail.cancelling : T.ride.detail.cancel}
      variant={view.cancelling ? 'wait' : 'ghost'}
      disabled={!view.serverActionsEnabled}
      height={56}
      fontSize={18}
      radius={14}
      onPress={() => {
        setReason(null);
        setDialog('cancel');
      }}
    />
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      {header}
      {landscape ? (
        <View style={{ flex: 1, flexDirection: 'row', gap: 20, padding: 20 }}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 16, paddingBottom: 8 }}>
            {info}
            {strips}
            <View style={{ height: 24 }} />
            {cancel}
          </ScrollView>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
            {actions}
          </ScrollView>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 20, gap: 20 }}>
          {info}
          {strips}
          {actions}
          <View style={{ flexGrow: 1, minHeight: 48 }} />
          {/* NAVİGASYON ve TAMAMLA'dan ayrık, en altta */}
          {cancel}
        </ScrollView>
      )}

      <Sheet visible={dialog === 'complete'} onClose={() => setDialog(null)} title={T.ride.complete.title} body={T.ride.complete.confirm}>
        {/* VAZGEÇ varsayılan ve baskın seçenektir. */}
        <Button label={T.ride.complete.cancel} height={80} fontSize={24} onPress={() => setDialog(null)} />
        <Button
          label={T.ride.complete.cta}
          variant="secondary"
          height={64}
          fontSize={21}
          radius={18}
          onPress={() => {
            setDialog(null);
            completeRide();
          }}
        />
      </Sheet>

      <Sheet visible={dialog === 'cancel'} onClose={() => setDialog(null)} title={T.ride.cancel.title} body={T.ride.cancel.body}>
        <Txt size={17} color={colors.muted}>
          {T.ride.cancel.reasonLabel}
        </Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {T.ride.cancel.reasons.map((r) => {
            const on = reason === r;
            return (
              <Pressable
                key={r}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setReason(on ? null : r)}
                style={{ minHeight: 56, paddingHorizontal: 16, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? colors.light : 'transparent', borderWidth: 1.5, borderColor: on ? colors.light : colors.outlineSoft }}
              >
                <Txt bold={on} size={18} color={on ? colors.bg : colors.text}>
                  {r}
                </Txt>
              </Pressable>
            );
          })}
        </View>
        <Button label={T.ride.cancel.keep} height={80} fontSize={24} onPress={() => setDialog(null)} />
        <Button
          label={T.ride.cancel.cta}
          variant="danger"
          height={64}
          fontSize={20}
          radius={18}
          onPress={() => {
            setDialog(null);
            cancelActiveRide(reason ?? undefined);
          }}
        />
      </Sheet>

      <Sheet visible={dialog === 'nav'} onClose={() => setDialog(null)} title={T.ride.detail.navChoose}>
        {navApps.map((a) => (
          <Button key={a.id} label={a.label} variant="blue" height={72} fontSize={22} radius={18} onPress={() => void go(a, makeDefault)} />
        ))}
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: makeDefault }}
          onPress={() => setMakeDefault((v) => !v)}
          style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12 }}
        >
          <View style={{ width: 28, height: 28, borderRadius: 8, borderWidth: 2, borderColor: colors.outline, backgroundColor: makeDefault ? colors.green : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
            {makeDefault ? <Txt bold size={18} color={colors.greenInk}>✓</Txt> : null}
          </View>
          <Txt size={18}>{T.ride.detail.navDefault}</Txt>
        </Pressable>
        <Button label={T.ride.detail.navCancel} variant="ghost" height={56} fontSize={19} onPress={() => setDialog(null)} />
      </Sheet>

    </SafeAreaView>
  );
}
