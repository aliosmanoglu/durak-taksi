import { describe, expect, it } from 'vitest';
import { loginOutcome, validateLogin, validateRegister, type RegisterForm } from './forms';
import { T } from './texts';

describe('giriş formu', () => {
  it('telefonu normalize eder', () => {
    expect(validateLogin({ phone: '0532 123 45 67', password: 'x' })).toEqual({
      ok: true,
      phone: '+905321234567',
      password: 'x',
    });
  });
  it('alan hatalarını Türkçe metinlerle verir', () => {
    expect(validateLogin({ phone: '123', password: '' })).toEqual({
      ok: false,
      errors: { phone: T.login.errPhoneFormat, password: T.login.errPasswordEmpty },
    });
  });
});

describe('kayıt formu', () => {
  const ok: RegisterForm = {
    fullName: 'Mehmet Yılmaz',
    phone: '0532 123 45 67',
    password: 'gizli-sifre',
    plate: '34 abc 123',
    licenseNo: 'R-12345',
    vehicleModel: '',
    vehicleColor: '  ',
  };
  it('geçerli girdiyi sözleşmeye göre normalize eder, boş isteğe bağlı alanları atar', () => {
    const r = validateRegister(ok);
    expect(r).toEqual({
      ok: true,
      input: { fullName: 'Mehmet Yılmaz', phone: '+905321234567', password: 'gizli-sifre', plate: '34ABC123', licenseNo: 'R-12345' },
    });
  });
  it('her alan için tek hata', () => {
    const r = validateRegister({ ...ok, fullName: 'M', password: 'kisa', plate: 'XX', licenseNo: '1', vehicleModel: 'x'.repeat(81) });
    expect(r).toEqual({
      ok: false,
      errors: {
        fullName: T.register.errFullName,
        password: T.register.errPassword,
        plate: T.register.errPlate,
        licenseNo: T.register.errLicenseNo,
        vehicleModel: T.register.errTooLong,
      },
    });
  });
});

describe('giriş sonucu', () => {
  const err = (code: string, extra: object = {}) =>
    ({ ok: false, kind: 'http', status: 400, code, ...extra }) as Parameters<typeof loginOutcome>[0];
  it('koda göre tepki', () => {
    expect(loginOutcome({ ok: true, data: {} })).toEqual({ kind: 'ok' });
    expect(loginOutcome(err('ACCOUNT_PENDING'))).toEqual({ kind: 'pending' });
    expect(loginOutcome(err('INVALID_CREDENTIALS'))).toMatchObject({ text: T.login.errCredentials, clearPassword: true });
    expect(loginOutcome(err('ACCOUNT_SUSPENDED'))).toMatchObject({ tone: 'red', text: T.login.errSuspended });
    expect(loginOutcome(err('RATE_LIMITED', { retryAfterMs: 720_000 }))).toMatchObject({
      tone: 'yellow',
      text: 'Çok fazla deneme. 12 dk sonra tekrar deneyin.',
      lockMs: 720_000,
    });
    expect(loginOutcome(err('VALIDATION_ERROR'))).toMatchObject({ text: T.login.errPhoneFormat });
    expect(loginOutcome(err('INTERNAL'))).toMatchObject({ text: T.common.errServer });
    expect(loginOutcome({ ok: false, kind: 'network' })).toMatchObject({ text: T.common.errNetwork, retry: true });
  });
});
