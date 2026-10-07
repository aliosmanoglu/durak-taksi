// E6 Hesap (Account.dc.html + LogoutDialog.dc.html). Telefon maskeli; ücret/ödeme yok.
import { useEffect, useState } from 'react';
import { Linking, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatPlate, formatVehicle, maskPhone } from '@/lib/format';
import { T } from '@/lib/texts';
import { colors } from '@/lib/theme';
import { openSettings } from '@/services/actions';
import { readNotificationPermission } from '@/services/notify';
import { cancelLogout, logout } from '@/services/session';
import { Button } from '@/ui/Button';
import { ChevronIcon } from '@/ui/Icons';
import { TopBar } from '@/ui/Form';
import { useApp } from '@/ui/hooks';
import { Txt } from '@/ui/Txt';

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.divider,
      }}
    >
      <Txt size={17} color={colors.muted}>
        {k}
      </Txt>
      <Txt bold size={18} style={{ textAlign: 'right', flexShrink: 1 }}>
        {v}
      </Txt>
    </View>
  );
}

function LinkRow({ k, v, color, onPress }: { k: string; v: string; color: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${k}: ${v}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        minHeight: 64,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.divider,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Txt size={18}>{k}</Txt>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Txt bold size={17} color={color}>
          {v}
        </Txt>
        <ChevronIcon />
      </View>
    </Pressable>
  );
}

const card = { borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' } as const;

type Dialog = null | 'confirm' | 'working' | 'networkError';

export default function AccountScreen() {
  const router = useRouter();
  const profile = useApp((s) => s.profile);
  const perm = useApp((s) => s.perm);
  const server = useApp((s) => s.server);
  const [notif, setNotif] = useState<'granted' | 'denied' | 'undetermined'>('undetermined');
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    void readNotificationPermission().then(setNotif);
  }, []);

  const busy = server === 'busy';
  const active = server === 'available' || server === 'busy';
  const permValue =
    perm === 'background'
      ? { v: T.account.permAlways, c: colors.green }
      : perm === 'foreground'
        ? { v: T.account.permWhenInUse, c: '#FFD66B' }
        : perm === 'undetermined'
          ? { v: T.account.permAsk, c: '#FFD66B' }
          : { v: T.account.permNone, c: colors.red };
  const version = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '—';
  const build = Application.nativeBuildVersion ?? '—';

  async function doLogout(force: boolean) {
    setDialog('working');
    const ok = await logout(force);
    if (!ok) setDialog('networkError');
    // Başarıda oturum kapısı E1'e geçirir.
  }

  function closeDialog() {
    if (dialog === 'networkError') cancelLogout();
    setDialog(null);
  }

  function openBatterySettings() {
    if (Platform.OS !== 'android') return openSettings();
    void Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(openSettings);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24, gap: 20 }}>
        <TopBar title={T.account.title} onBack={() => router.back()} />

        <View style={card}>
          <Row k={T.account.fullName} v={profile?.fullName ?? '—'} />
          <Row k={T.account.plate} v={profile?.plate ? formatPlate(profile.plate) : '—'} />
          <Row k={T.account.vehicle} v={formatVehicle(profile?.vehicleColor, profile?.vehicleModel) ?? '—'} />
          <Row k={T.account.phone} v={profile?.phone ? maskPhone(profile.phone) : '—'} />
        </View>

        <View style={card}>
          <LinkRow
            k={T.account.locationPerm}
            v={permValue.v}
            color={permValue.c}
            onPress={() => (perm === 'deniedForever' ? openSettings() : router.push('/permissions'))}
          />
          <LinkRow
            k={T.account.notifPerm}
            v={notif === 'granted' ? T.account.notifOn : T.account.notifOff}
            color={notif === 'granted' ? colors.green : '#FFD66B'}
            onPress={openSettings}
          />
          {Platform.OS === 'android' ? (
            <LinkRow k={T.account.battery} v={T.account.batteryValue} color="#FFD66B" onPress={openBatterySettings} />
          ) : null}
        </View>

        <Txt size={16} color={colors.muted} style={{ paddingHorizontal: 4 }}>
          {T.account.version(version, build)}
        </Txt>
        <View style={{ flexGrow: 1 }} />
        {busy ? (
          <Txt size={16} color={colors.muted} style={{ textAlign: 'center' }}>
            {T.logout.busy}
          </Txt>
        ) : null}
        <Button
          label={T.logout.cta}
          variant={busy ? 'disabled' : 'danger'}
          disabled={busy}
          height={72}
          fontSize={22}
          onPress={() => setDialog('confirm')}
        />
      </ScrollView>

      <Modal visible={dialog != null} transparent animationType="fade" onRequestClose={closeDialog} statusBarTranslucent>
        <View style={{ flex: 1, backgroundColor: 'rgba(3, 5, 8, 0.78)', justifyContent: 'flex-end', padding: 16 }}>
          <SafeAreaView edges={['bottom']}>
            <View
              accessibilityViewIsModal
              style={{ padding: 24, borderRadius: 24, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.inputBorder, gap: 16 }}
            >
              <Txt bold size={26} accessibilityRole="header">
                {T.logout.title}
              </Txt>
              <Txt size={19} color={colors.textSoft} style={{ lineHeight: 28 }}>
                {dialog === 'networkError' ? T.logout.errNetwork : active ? T.logout.confirmActive : T.logout.confirm}
              </Txt>
              {dialog === 'networkError' ? (
                <>
                  <Button label={T.common.retry} height={80} fontSize={24} onPress={() => void doLogout(false)} />
                  <Button label={T.logout.forceCta} variant="danger" height={64} fontSize={21} radius={18} onPress={() => void doLogout(true)} />
                  <Button label={T.logout.cancel} variant="ghost" height={56} fontSize={19} onPress={closeDialog} />
                </>
              ) : (
                <>
                  {/* VAZGEÇ varsayılan ve baskın seçenektir. */}
                  <Button label={T.logout.cancel} height={80} fontSize={24} onPress={closeDialog} disabled={dialog === 'working'} />
                  <Button
                    label={T.logout.cta}
                    variant={dialog === 'working' ? 'wait' : 'danger'}
                    height={64}
                    fontSize={21}
                    radius={18}
                    onPress={() => void doLogout(false)}
                  />
                </>
              )}
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
