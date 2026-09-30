// E2 Kayıt (Register.dc.html). Minimal; `homeStandId` yok (tasarım S9). Başarıda E3; otomatik giriş yok.
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View, type TextInputProps } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RATE_LIMIT_FALLBACK_MS } from '@/lib/constants';
import { formatPhoneInput, formatWait } from '@/lib/format';
import { validateRegister, type RegisterErrors, type RegisterForm } from '@/lib/forms';
import { T } from '@/lib/texts';
import { colors } from '@/lib/theme';
import { register } from '@/services/session';
import { Button } from '@/ui/Button';
import { FormBanner } from '@/ui/Cards';
import { Field, TopBar } from '@/ui/Form';
import { Txt } from '@/ui/Txt';

const EMPTY: RegisterForm = {
  fullName: '',
  phone: '',
  password: '',
  plate: '',
  licenseNo: '',
  vehicleModel: '',
  vehicleColor: '',
};

const FIELDS: { key: keyof RegisterForm; label: string; props: TextInputProps }[] = [
  { key: 'fullName', label: T.register.fullName, props: { autoComplete: 'name', textContentType: 'name', autoCapitalize: 'words' } },
  { key: 'phone', label: T.register.phone, props: { keyboardType: 'phone-pad', placeholder: T.login.phonePlaceholder, autoComplete: 'tel' } },
  { key: 'password', label: T.register.password, props: { secureTextEntry: true, autoCapitalize: 'none', autoComplete: 'new-password', textContentType: 'newPassword' } },
  { key: 'plate', label: T.register.plate, props: { autoCapitalize: 'characters', placeholder: T.register.platePlaceholder } },
  { key: 'licenseNo', label: T.register.licenseNo, props: { autoCapitalize: 'characters' } },
  { key: 'vehicleModel', label: T.register.vehicleModel, props: {} },
  { key: 'vehicleColor', label: T.register.vehicleColor, props: {} },
];

export default function RegisterScreen() {
  const router = useRouter();
  const [form, setForm] = useState<RegisterForm>(EMPTY);
  const [errors, setErrors] = useState<RegisterErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof RegisterForm, v: string) =>
    setForm((f) => ({ ...f, [key]: key === 'phone' ? formatPhoneInput(v) : key === 'plate' ? v.toUpperCase() : v }));

  async function submit() {
    if (submitting) return;
    const v = validateRegister(form);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setBanner(null);
    setSubmitting(true);
    const r = await register(v.input);
    setSubmitting(false);
    if (r.ok) {
      setForm(EMPTY);
      router.replace('/pending');
      return;
    }
    if (r.kind === 'network') return setBanner(T.common.errNetwork);
    switch (r.code) {
      case 'CONFLICT':
        return setBanner(T.register.errConflict);
      case 'RATE_LIMITED':
        return setBanner(T.login.errRateLimited(formatWait(r.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS)));
      case 'VALIDATION_ERROR':
        // Sunucu mesajı gösterilmez; istemci şeması zaten alanları denetledi.
        return setBanner(T.login.errPhoneFormat);
      default:
        return setBanner(T.common.errServer);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 16, gap: 18 }} keyboardShouldPersistTaps="handled">
          <TopBar title={T.register.title} onBack={() => router.back()} />
          <Txt size={17} color={colors.muted}>
            {T.register.intro}
          </Txt>
          {banner ? <FormBanner tone="red" text={banner} /> : null}
          <View style={{ gap: 14 }}>
            {FIELDS.map((f) => (
              <Field
                key={f.key}
                label={f.label}
                value={form[f.key]}
                onChangeText={(t) => set(f.key, t)}
                editable={!submitting}
                error={errors[f.key]}
                height={56}
                fontSize={20}
                {...f.props}
              />
            ))}
            <Button
              label={submitting ? T.register.submitting : T.register.submit}
              variant={submitting ? 'wait' : 'light'}
              onPress={submit}
              style={{ marginTop: 8 }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
