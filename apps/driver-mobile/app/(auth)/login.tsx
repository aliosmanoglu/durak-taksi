// E1 Giriş (Main.dc.html).
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatClock, formatPhoneInput } from '@/lib/format';
import { loginOutcome, validateLogin, type LoginErrors } from '@/lib/forms';
import { store } from '@/lib/store';
import { T } from '@/lib/texts';
import { colors } from '@/lib/theme';
import { login } from '@/services/session';
import { Button } from '@/ui/Button';
import { FormBanner } from '@/ui/Cards';
import { Field } from '@/ui/Form';
import { useApp, useNow } from '@/ui/hooks';
import { Txt } from '@/ui/Txt';

type BannerState = { tone: 'red' | 'yellow' | 'blue'; text: string; retry?: boolean } | null;

const SESSION_BANNER = {
  ended: { tone: 'blue', text: T.session.ended },
  suspended: { tone: 'red', text: T.session.suspended },
  loggedOutElsewhere: { tone: 'blue', text: T.session.loggedOutElsewhere },
} as const;

export default function LoginScreen() {
  const router = useRouter();
  const sessionEnded = useApp((s) => s.sessionEnded);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<LoginErrors>({});
  const [banner, setBanner] = useState<BannerState>(sessionEnded ? SESSION_BANNER[sessionEnded] : null);
  const [submitting, setSubmitting] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const passwordRef = useRef<TextInput>(null);
  const now = useNow(1000);

  // Oturum sonu şeridi bir kez gösterilir.
  useEffect(() => {
    if (sessionEnded) store.setState({ sessionEnded: null });
  }, [sessionEnded]);

  const locked = now < lockedUntil;

  async function submit() {
    if (submitting || locked) return;
    const v = validateLogin({ phone, password });
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setSubmitting(true);
    const r = await login(v.phone, v.password);
    setSubmitting(false);
    const o = loginOutcome(r);
    if (o.kind === 'ok') return; // Oturum kapısı (app)'e geçirir.
    if (o.kind === 'pending') {
      setBanner(null);
      router.push('/pending');
      return;
    }
    setBanner({ tone: o.tone, text: o.text, retry: o.retry });
    if (o.clearPassword) {
      setPassword('');
      passwordRef.current?.focus();
    }
    if (o.lockMs) setLockedUntil(Date.now() + o.lockMs);
  }

  const buttonLabel = locked
    ? T.login.lockedButton(formatClock(lockedUntil - now))
    : submitting
      ? T.login.submitting
      : T.login.submit;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 24, gap: 24 }} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 32 }}>
            <View
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                backgroundColor: colors.yellow,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Txt bold size={22} color={colors.bg}>
                DN
              </Txt>
            </View>
            <View style={{ gap: 2 }}>
              <Txt bold size={26} accessibilityRole="header">
                {T.login.brand}
              </Txt>
              <Txt size={17} color={colors.muted}>
                {T.login.title}
              </Txt>
            </View>
          </View>

          {banner ? (
            <View style={{ gap: 12 }}>
              <FormBanner tone={banner.tone} text={banner.text} />
              {banner.retry ? (
                <Button label={T.common.retry} variant="secondary" height={56} fontSize={19} radius={16} onPress={submit} />
              ) : null}
            </View>
          ) : null}

          <View style={{ gap: 20 }}>
            <Field
              label={T.login.phone}
              value={phone}
              onChangeText={(t) => setPhone(formatPhoneInput(t))}
              placeholder={T.login.phonePlaceholder}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoComplete="tel"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              editable={!submitting}
              error={errors.phone}
              style={{ letterSpacing: 0.9 }}
            />
            <Field
              ref={passwordRef}
              label={T.login.password}
              value={password}
              onChangeText={setPassword}
              placeholder={T.login.passwordPlaceholder}
              secureTextEntry={!showPassword}
              textContentType="password"
              autoComplete="current-password"
              autoCapitalize="none"
              returnKeyType="go"
              onSubmitEditing={submit}
              editable={!submitting}
              error={errors.password}
              style={banner?.text === T.login.errCredentials ? { borderColor: colors.red } : undefined}
              trailing={
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setShowPassword((v) => !v)}
                  style={{
                    width: 88,
                    minHeight: 60,
                    borderRadius: 14,
                    backgroundColor: colors.surface,
                    borderWidth: 1.5,
                    borderColor: colors.inputBorder,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Txt bold size={17} color={colors.textSoft}>
                    {showPassword ? T.login.hide : T.login.show}
                  </Txt>
                </Pressable>
              }
            />
            <Button
              label={buttonLabel}
              variant={locked ? 'disabled' : submitting ? 'wait' : 'light'}
              disabled={locked}
              onPress={submit}
              style={{ marginTop: 8 }}
            />
          </View>

          <View style={{ flexGrow: 1 }} />

          <View style={{ gap: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <Txt size={17} color={colors.muted} style={{ flexShrink: 1 }}>
                {T.login.noAccount}
              </Txt>
              <Button
                label={T.login.register}
                variant="secondary"
                height={56}
                fontSize={18}
                radius={16}
                onPress={() => router.push('/register')}
              />
            </View>
            <Txt size={16} color={colors.muted}>
              {T.login.forgot}
            </Txt>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
