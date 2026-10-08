// D1 Gelen çağrılar (faz3 4.3). Odaklı kart + diğer çağrılar listesi; KABUL yukarıda büyük, REDDET altında ikincil
// (ret geri alınamadığı için yanlış dokunma riski düşük tutulur; 4 sn GERİ AL penceresi).
// Geri sayım yoktur: süre sınırı olmadığı için yalnızca geçen süre gösterilir, renk "aciliyet" uydurmaz.
// Tüm durum mantığı saf `deriveRequests` / `src/lib/rides`'tadır; burası yalnızca çizer ve eylemleri bağlar.
import { useEffect, useMemo } from 'react';
import { AccessibilityInfo, Platform, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatDistance } from '@/lib/format';
import { deriveRequests, type RequestsView } from '@/lib/rides/ride-view';
import { T } from '@/lib/texts';
import { colors, tones } from '@/lib/theme';
import { acceptRide, declineRide, focusOnRequest, markRequestsViewed, undoDeclineRide } from '@/services/rides';
import { stopRing } from '@/services/ringer';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Cards';
import { useApp, useNow } from '@/ui/hooks';
import { BackIcon, ChevronIcon, WarnIcon } from '@/ui/Icons';
import { Txt } from '@/ui/Txt';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

function FocusedCard({ view }: { view: RequestsView }) {
  const r = view.focused!;
  return (
    <View
      accessibilityLabel={`${T.ride.req.focusA11y(view.focusIndex, view.total)}. ${r.shortCode}. ${T.ride.req.distance(view.distanceText)}. ${r.pickupAddress}. ${r.standName}. ${view.elapsedA11y}`}
      accessible
      style={{ gap: 12, padding: 20, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Txt bold size={30} style={{ fontFamily: MONO, letterSpacing: 2 }}>
          {r.shortCode}
        </Txt>
        {view.focusedIsNew ? (
          <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: tones.yellow.bg, borderWidth: 1, borderColor: tones.yellow.border }}>
            <Txt bold size={16} color={tones.yellow.color}>
              {T.ride.req.new}
            </Txt>
          </View>
        ) : null}
      </View>
      <View>
        <Txt bold size={48} style={{ lineHeight: 54 }}>
          {T.ride.req.distance(view.distanceText)}
        </Txt>
        <Txt size={16} color={colors.muted}>
          {T.ride.req.distanceHint}
        </Txt>
      </View>
      <Txt bold size={28} style={{ lineHeight: 34 }}>
        {r.pickupAddress}
      </Txt>
      {r.dropoffAddress ? (
        <Txt size={22} color={colors.textSoft} style={{ lineHeight: 28 }}>
          → {r.dropoffAddress}
        </Txt>
      ) : null}
      {r.notes ? (
        <Txt size={20} color={colors.textBody} style={{ lineHeight: 26, fontStyle: 'italic' }}>
          “{r.notes}”
        </Txt>
      ) : null}
      <Txt size={18} color={colors.muted}>
        {r.standName} · {view.elapsedText}
      </Txt>
    </View>
  );
}

function OtherRow({ r, onPress, isNew }: { r: RequestsView['others'][number]; onPress: () => void; isNew: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${r.shortCode}, ${formatDistance(r.distanceM)}, ${r.pickupAddress}`}
      disabled={!!r.taken}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 64,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 16,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        opacity: r.taken ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Txt bold size={18} style={{ fontFamily: MONO }}>
            {r.shortCode}
          </Txt>
          <Txt size={18} color={colors.textSoft}>
            · {formatDistance(r.distanceM)}
          </Txt>
          {isNew ? (
            <Txt bold size={16} color={tones.yellow.color}>
              {T.ride.req.new}
            </Txt>
          ) : null}
        </View>
        <Txt size={17} color={colors.textSoft} numberOfLines={2}>
          {r.taken ? T.ride.req.taken : r.pickupAddress}
        </Txt>
      </View>
      <ChevronIcon />
    </Pressable>
  );
}

export default function RequestsScreen() {
  useKeepAwake(); // D1 açıkken ekran uyanık kalır (kapanınca serbest)
  const router = useRouter();
  const state = useApp((s) => s);
  const now = useNow(250);
  const view = useMemo(() => deriveRequests(state, now), [state, now]);
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const focusedId = state.focusedId;

  // Odağa alınan çağrı görülmüş sayılır (YENİ rozeti kalkar).
  useEffect(() => {
    markRequestsViewed();
  }, [focusedId, state.requests.length]);

  // D1'den çıkılınca ses/titreşim anında durur.
  useEffect(() => stopRing, []);

  // Odaklı kart değişince ekran okuyucuya "Çağrı i/n" duyurulur.
  useEffect(() => {
    if (focusedId && view.total > 1) AccessibilityInfo.announceForAccessibility(T.ride.req.focusA11y(view.focusIndex, view.total));
    // yalnızca odak değişince
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedId]);

  const r = view.focused;
  const pending = state.pendingDecline;
  const taken = !!r?.taken;

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={T.common.back}
        onPress={() => router.back()}
        style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }}
      >
        <BackIcon />
      </Pressable>
      <Txt bold size={26} accessibilityRole="header" style={{ flex: 1 }}>
        {view.total > 0 ? T.ride.req.openCount(view.total) : T.ride.req.title}
      </Txt>
      <Chip chip={state.conn === 'connected' ? { label: T.chip.connected, color: 'green' } : { label: T.chip.disconnected, color: 'yellow' }} />
    </View>
  );

  const offlineStrip = view.offline ? (
    <View
      accessibilityRole="alert"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 20, padding: 14, borderRadius: 14, backgroundColor: tones.yellow.bg, borderWidth: 1, borderColor: tones.yellow.border }}
    >
      <WarnIcon color={tones.yellow.color} />
      <Txt bold size={17} color={tones.yellow.color} style={{ flex: 1 }}>
        {T.ride.req.offlineStrip}
      </Txt>
    </View>
  ) : null;

  const content = (
    <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 20, gap: 16 }} style={{ opacity: view.offline ? 0.6 : 1 }}>
      {r ? <FocusedCard view={view} /> : <Txt size={20} color={colors.muted}>{T.ride.req.closedToast}</Txt>}
      {view.others.length > 0 ? (
        <View style={{ gap: 10 }}>
          <Txt bold size={16} color={colors.muted} style={{ letterSpacing: 1.1 }}>
            {T.ride.req.others(view.others.length + view.moreCount)}
          </Txt>
          {view.others.map((o) => (
            <OtherRow key={o.rideId} r={o} isNew={state.unseen.includes(o.rideId)} onPress={() => focusOnRequest(o.rideId)} />
          ))}
          {view.moreCount > 0 ? (
            <Txt size={17} color={colors.muted}>
              {T.ride.req.more(view.moreCount)}
            </Txt>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );

  const declineStrip = pending ? (
    <View
      accessibilityLiveRegion="polite"
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingLeft: 16, paddingRight: 8, minHeight: 64, borderRadius: 16, backgroundColor: tones.blue.bg, borderWidth: 1, borderColor: tones.blue.border }}
    >
      <Txt bold size={18} color={tones.blue.color}>
        {T.ride.req.declined}
      </Txt>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={T.ride.req.undo}
        onPress={undoDeclineRide}
        style={({ pressed }) => ({ minHeight: 56, paddingHorizontal: 20, borderRadius: 12, backgroundColor: tones.blue.color, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.8 : 1 })}
      >
        <Txt bold size={18} color={colors.bg}>
          {T.ride.req.undo}
        </Txt>
      </Pressable>
    </View>
  ) : null;

  const actions = r ? (
    taken ? (
      <View accessibilityLiveRegion="polite" style={{ padding: 18, borderRadius: 16, backgroundColor: tones.blue.bg, borderWidth: 1, borderColor: tones.blue.border }}>
        <Txt bold size={20} color={tones.blue.color} style={{ textAlign: 'center' }}>
          {T.ride.req.taken}
        </Txt>
      </View>
    ) : (
      <>
        <Button
          label={view.waiting ? T.ride.req.waiting : view.accepting ? T.ride.req.accepting : T.ride.req.accept}
          variant={view.accepting ? 'wait' : view.canAct ? 'green' : 'disabled'}
          disabled={!view.canAct}
          height={96}
          fontSize={30}
          radius={22}
          accessibilityLabel={T.ride.req.acceptA11y(r.shortCode, view.distanceText, r.pickupAddress)}
          onPress={() => acceptRide(r.rideId)}
        />
        {/* ≥ 24 dp boşluk; REDDET ikincil stilde ve KABUL'ün altında (yanında değil). */}
        <View style={{ height: 8 }} />
        <Button
          label={T.ride.req.decline}
          variant={view.canAct ? 'secondary' : 'disabled'}
          disabled={!view.canAct}
          height={64}
          fontSize={22}
          radius={18}
          accessibilityLabel={T.ride.req.declineA11y(r.shortCode)}
          onPress={() => declineRide(r.rideId)}
        />
      </>
    )
  ) : null;

  return (
    // Ekrana herhangi bir dokunuş çağrı sesini/titreşimini durdurur (4.4).
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} onTouchStart={stopRing}>
      {header}
      {offlineStrip}
      {landscape ? (
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ flex: 1.2 }}>{content}</View>
          <View style={{ flex: 1, padding: 20, gap: 16, justifyContent: 'center' }}>
            {declineStrip}
            {actions}
          </View>
        </View>
      ) : (
        <>
          <View style={{ flex: 1 }}>{content}</View>
          {/* KABUL/REDDET ekranın altına yapışıktır; kaydırmaya girmez. */}
          <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16, gap: 16 }}>
            {declineStrip}
            {actions}
          </View>
        </>
      )}
    </SafeAreaView>
  );
}
