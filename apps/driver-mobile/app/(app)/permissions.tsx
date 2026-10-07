// E5 Konum izni akışı (Permission1/2.dc.html). Sistem diyaloğundan önce her zaman uygulamanın açıklaması
// gösterilir. Sıra: 1) ön plan konumu → 2) arka plan konumu → 3) bildirim (yalnızca Android 13+).
import { useEffect, useState } from 'react';
import { AppState, Platform, ScrollView, View } from 'react-native';
import * as Location from 'expo-location';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { T } from '@/lib/texts';
import { colors } from '@/lib/theme';
import { goOnlineFlow, openSettings } from '@/services/actions';
import { readPermission } from '@/services/location';
import { readNotificationPermission, requestNotificationPermission } from '@/services/notify';
import * as presence from '@/services/presence';
import { store } from '@/lib/store';
import { Button } from '@/ui/Button';
import { FormBanner } from '@/ui/Cards';
import { CheckIcon, PinIcon } from '@/ui/Icons';
import { Txt } from '@/ui/Txt';

type Step = 1 | 2 | 3;
const needsNotificationStep = Platform.OS === 'android' && Number(Platform.Version) >= 33;

function StepHeader({ step }: { step: 1 | 2 }) {
  return (
    <View style={{ gap: 10, paddingTop: 12 }}>
      <Txt size={16} color={colors.muted} style={{ letterSpacing: 1 }}>
        {T.perm.step(step)}
      </Txt>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.green }} />
        <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: step === 2 ? colors.green : colors.border }} />
      </View>
    </View>
  );
}

export default function PermissionsScreen() {
  const router = useRouter();
  const { resume } = useLocalSearchParams<{ resume?: string }>();
  const [step, setStep] = useState<Step | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [deniedForever, setDeniedForever] = useState(false);
  const [busy, setBusy] = useState(false);

  async function nextStepAfterForeground(): Promise<Step | null> {
    const { perm } = await readPermission();
    if (perm !== 'background') return 2;
    return afterBackground();
  }

  async function afterBackground(): Promise<Step | null> {
    return needsNotificationStep && (await readNotificationPermission()) === 'undetermined' ? 3 : null;
  }

  async function finish() {
    await presence.refreshDeviceState();
    if (router.canGoBack()) router.back();
    else router.replace('/');
    const { perm } = store.getState();
    if (resume === 'goOnline' && (perm === 'foreground' || perm === 'background')) void goOnlineFlow(router);
  }

  async function go(next: Step | null) {
    if (next == null) return finish();
    setStep(next);
  }

  // Giriş noktası: verilmiş izinler atlanır.
  useEffect(() => {
    void (async () => {
      const { perm, precise } = await readPermission();
      if (perm === 'foreground' || perm === 'background') {
        if (!precise) {
          setWarning(T.perm.coarse);
          setStep(1);
          return;
        }
        const n = await nextStepAfterForeground();
        if (n == null) return finish();
        setStep(n);
        return;
      }
      setDeniedForever(perm === 'deniedForever');
      setStep(1);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Android 11+: arka plan izni ayar sayfasında verilir; dönüşte izin tekrar okunur.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      void presence.refreshDeviceState();
      if (step === 2) {
        void readPermission().then(async ({ perm }) => {
          if (perm === 'background') await go(await afterBackground());
        });
      }
      if (step === 1 && deniedForever) {
        void readPermission().then(async ({ perm, precise }) => {
          if ((perm === 'foreground' || perm === 'background') && precise) {
            setDeniedForever(false);
            await go(await nextStepAfterForeground());
          }
        });
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, deniedForever]);

  async function requestForeground() {
    if (deniedForever) return openSettings();
    setBusy(true);
    const r = await Location.requestForegroundPermissionsAsync().catch(() => null);
    setBusy(false);
    await presence.refreshDeviceState();
    if (!r || r.status !== 'granted') {
      if (r && !r.canAskAgain) {
        setDeniedForever(true);
        setWarning(T.perm.deniedForever);
      }
      return;
    }
    const coarse = Platform.OS === 'android' ? r.android?.accuracy === 'coarse' : r.ios?.accuracy === 'reduced';
    if (coarse) {
      // "Yaklaşık konum" seçildi: şerit + tekrar isteme (Android yükseltme diyaloğu gösterir).
      setWarning(T.perm.coarse);
      return;
    }
    setWarning(null);
    await go(await nextStepAfterForeground());
  }

  async function requestBackground() {
    setBusy(true);
    const r = await Location.requestBackgroundPermissionsAsync().catch(() => null);
    setBusy(false);
    await presence.refreshDeviceState();
    if (!r || r.status !== 'granted') {
      // iOS soruyu ertelediyse/göstermediyse ayarlar alternatifi; Android'de ayar sayfası zaten açıldı.
      if (Platform.OS === 'ios' && r && !r.canAskAgain) setWarning(T.perm.deniedForever);
      if (Platform.OS === 'ios') return;
    }
    await go(await afterBackground());
  }

  async function requestNotifications() {
    setBusy(true);
    await requestNotificationPermission();
    setBusy(false);
    await finish();
  }

  if (step == null) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 24, gap: 20 }}>
        {step === 1 ? (
          <>
            <StepHeader step={1} />
            <View style={{ flexGrow: 1, justifyContent: 'center', gap: 20 }}>
              <View style={{ width: 96, height: 96, borderRadius: 28, backgroundColor: '#0F2A1C', alignItems: 'center', justifyContent: 'center' }}>
                <PinIcon />
              </View>
              <Txt bold size={34} accessibilityRole="header" style={{ lineHeight: 39 }}>
                {T.perm.step1Title}
              </Txt>
              <Txt size={20} color={colors.textSoft} style={{ lineHeight: 29 }}>
                {T.perm.step1Body}
              </Txt>
              <View style={{ gap: 12 }}>
                {T.perm.step1Points.map((p) => (
                  <View key={p} style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                    <CheckIcon />
                    <Txt size={18} style={{ flexShrink: 1 }}>
                      {p}
                    </Txt>
                  </View>
                ))}
              </View>
              {warning ? <FormBanner tone={deniedForever ? 'red' : 'yellow'} text={warning} /> : null}
            </View>
            <Button
              label={deniedForever ? T.common.openSettings : T.perm.step1Cta}
              variant={busy ? 'wait' : 'green'}
              onPress={requestForeground}
            />
            <Button label={T.perm.later} variant="ghost" height={56} fontSize={19} onPress={() => void finish()} />
          </>
        ) : step === 2 ? (
          <>
            <StepHeader step={2} />
            <Txt bold size={32} accessibilityRole="header" style={{ marginTop: 8, lineHeight: 37 }}>
              {T.perm.step2Title}
            </Txt>
            <Txt size={19} color={colors.textSoft} style={{ lineHeight: 28 }}>
              {T.perm.step2Body}
            </Txt>
            {Platform.OS === 'android' ? (
              <View style={{ gap: 12, padding: 16, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
                <Txt size={16} color={colors.muted} style={{ letterSpacing: 0.9 }}>
                  {T.perm.step2Settings}
                </Txt>
                <View style={{ gap: 4 }}>
                  {T.perm.step2Options.map((o, i) => (
                    <View
                      key={o}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        minHeight: i === 0 ? 48 : 44,
                        paddingHorizontal: 12,
                        borderRadius: 12,
                        backgroundColor: i === 0 ? '#0F2A1C' : 'transparent',
                        borderWidth: i === 0 ? 1.5 : 0,
                        borderColor: colors.green,
                      }}
                    >
                      <View
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          borderWidth: i === 0 ? 6 : 2,
                          borderColor: i === 0 ? colors.green : colors.ring,
                        }}
                      />
                      <Txt bold={i === 0} size={i === 0 ? 18 : 17} color={i === 0 ? colors.text : colors.muted}>
                        {o}
                      </Txt>
                    </View>
                  ))}
                </View>
                <Txt size={16} color={colors.muted}>
                  {T.perm.step2Back}
                </Txt>
              </View>
            ) : null}
            {warning ? <FormBanner tone="yellow" text={warning} /> : null}
            <View style={{ flexGrow: 1 }} />
            <Button
              label={warning && Platform.OS === 'ios' ? T.common.openSettings : T.perm.step2Cta}
              variant={busy ? 'wait' : 'green'}
              onPress={warning && Platform.OS === 'ios' ? openSettings : requestBackground}
            />
            <Button
              label={T.perm.later}
              variant="ghost"
              height={56}
              fontSize={19}
              onPress={() => void afterBackground().then(go)}
            />
          </>
        ) : (
          <>
            <View style={{ flexGrow: 1, justifyContent: 'center', gap: 20 }}>
              <Txt bold size={32} accessibilityRole="header">
                {T.perm.notifTitle}
              </Txt>
              <Txt size={20} color={colors.textSoft} style={{ lineHeight: 29 }}>
                {T.perm.notif}
              </Txt>
            </View>
            <Button label={T.perm.notifCta} variant={busy ? 'wait' : 'green'} onPress={requestNotifications} />
            <Button label={T.perm.later} variant="ghost" height={56} fontSize={19} onPress={() => void finish()} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
