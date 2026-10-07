// D3 Yolculuk kapandı (faz3 4.6): durak iptal etti / durak tamamladı / kendi tamamlamam. İptal kendiliğinden
// kapanmaz (kaçırılmasın); tamamlamada 4 sn sonra ana ekrana dönülür. TAMAM → ana ekran.
import { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CLOSED_AUTO_DISMISS_MS } from '@/lib/constants';
import { T } from '@/lib/texts';
import { colors } from '@/lib/theme';
import { dismissClosed } from '@/services/rides';
import { Button } from '@/ui/Button';
import { useApp } from '@/ui/hooks';
import { CheckIcon, WarnIcon } from '@/ui/Icons';
import { Txt } from '@/ui/Txt';

export default function ClosedScreen() {
  const router = useRouter();
  const closed = useApp((s) => s.closed);
  const cancelled = closed?.kind === 'cancelled';

  function done() {
    dismissClosed();
    router.dismissTo('/');
  }

  // Tamamlama bildirimi kendiliğinden kapanır; iptal kapanmaz.
  useEffect(() => {
    if (!closed || cancelled) return;
    const t = setTimeout(done, CLOSED_AUTO_DISMISS_MS);
    return () => clearTimeout(t);
    // yalnızca bildirim değişince yeniden kurulur
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed, cancelled]);

  if (!closed) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} />;

  const suspended = closed.kind === 'cancelled' && closed.standSuspended === true;
  const title = suspended
    ? T.ride.closed.standSuspendedTitle
    : cancelled
      ? T.ride.closed.cancelledTitle
      : T.ride.closed.completedTitle;
  const body = suspended
    ? T.ride.closed.standSuspended
    : cancelled
      ? T.ride.closed.cancelled
      : closed.kind === 'completedByStand'
      ? T.ride.closed.completedByStand
      : T.ride.closed.completed;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1, padding: 24, alignItems: 'center', justifyContent: 'center', gap: 20 }} accessibilityLiveRegion="polite">
        {cancelled ? <WarnIcon size={96} color={colors.yellow} strokeWidth={1.8} /> : <CheckIcon size={96} />}
        <Txt bold size={40} accessibilityRole="header" style={{ textAlign: 'center', lineHeight: 46 }}>
          {title}
        </Txt>
        <Txt bold size={22} color={colors.muted}>
          {closed.shortCode}
        </Txt>
        <Txt size={22} color={colors.textSoft} style={{ textAlign: 'center', lineHeight: 30, maxWidth: 360 }}>
          {body}
        </Txt>
        {cancelled && closed.reason ? (
          <Txt size={20} color={colors.textBody} style={{ textAlign: 'center' }}>
            {T.ride.closed.cancelledReason(closed.reason)}
          </Txt>
        ) : null}
      </View>
      <View style={{ padding: 20 }}>
        <Button label={T.ride.closed.ok} variant="light" height={88} fontSize={28} radius={22} onPress={done} />
      </View>
    </SafeAreaView>
  );
}
