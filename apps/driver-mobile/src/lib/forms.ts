// Giriş ve kayıt formlarının istemci doğrulaması: sözleşme şemaları (`@duraknet/shared`) çalıştırılır,
// hatalar alan bazında Türkçe metinlere eşlenir (sunucu mesajı gösterilmez).
import { driverRegisterSchema, loginSchema, type DriverRegisterInput } from '@duraknet/shared';
import type { ApiResult } from './api-result';
import { RATE_LIMIT_FALLBACK_MS } from './constants';
import { formatWait } from './format';
import { T } from './texts';

export type LoginForm = { phone: string; password: string };
export type LoginErrors = Partial<Record<keyof LoginForm, string>>;

export function validateLogin(f: LoginForm): { ok: true; phone: string; password: string } | { ok: false; errors: LoginErrors } {
  const r = loginSchema.safeParse({ role: 'driver', phone: f.phone, password: f.password });
  if (r.success && r.data.role === 'driver') return { ok: true, phone: r.data.phone, password: r.data.password };
  const errors: LoginErrors = {};
  for (const issue of r.success ? [] : r.error.issues) {
    const k = issue.path[0];
    if (k === 'phone') errors.phone = T.login.errPhoneFormat;
    if (k === 'password') errors.password = T.login.errPasswordEmpty;
  }
  return { ok: false, errors };
}

export type RegisterForm = {
  fullName: string;
  phone: string;
  password: string;
  plate: string;
  licenseNo: string;
  vehicleModel: string;
  vehicleColor: string;
  kvkk: boolean;
};
export type RegisterErrors = Partial<Record<keyof RegisterForm, string>>;

const REGISTER_MESSAGES: Record<keyof RegisterForm, string> = {
  kvkk: T.register.errKvkk,
  fullName: T.register.errFullName,
  phone: T.login.errPhoneFormat,
  password: T.register.errPassword,
  plate: T.register.errPlate,
  licenseNo: T.register.errLicenseNo,
  vehicleModel: T.register.errTooLong,
  vehicleColor: T.register.errTooLong,
};

export function validateRegister(
  f: RegisterForm,
): { ok: true; input: DriverRegisterInput } | { ok: false; errors: RegisterErrors } {
  const opt = (v: string) => (v.trim().length > 0 ? v : undefined);
  const r = driverRegisterSchema.safeParse({
    fullName: f.fullName,
    phone: f.phone,
    password: f.password,
    plate: f.plate,
    licenseNo: f.licenseNo,
    vehicleModel: opt(f.vehicleModel),
    vehicleColor: opt(f.vehicleColor),
    kvkkAccepted: f.kvkk ? true : undefined,
  });
  if (r.success) return { ok: true, input: r.data };
  const errors: RegisterErrors = {};
  for (const issue of r.error.issues) {
    const k = issue.path[0] === 'kvkkAccepted' ? 'kvkk' : issue.path[0];
    if (typeof k === 'string' && k in REGISTER_MESSAGES) {
      const key = k as keyof RegisterForm;
      errors[key] ??= REGISTER_MESSAGES[key];
    }
  }
  return { ok: false, errors };
}

export type LoginOutcome =
  | { kind: 'ok' }
  | { kind: 'pending' }
  | { kind: 'error'; tone: 'red' | 'yellow'; text: string; clearPassword?: boolean; lockMs?: number; retry?: boolean };

/** `POST /auth/login` sonucunun E1 tepkisi (tasarım E1 durum tablosu ve Bölüm 5). */
export function loginOutcome(r: ApiResult<unknown>): LoginOutcome {
  if (r.ok) return { kind: 'ok' };
  if (r.kind === 'network') return { kind: 'error', tone: 'red', text: T.common.errNetwork, retry: true };
  switch (r.code) {
    case 'INVALID_CREDENTIALS':
      return { kind: 'error', tone: 'red', text: T.login.errCredentials, clearPassword: true };
    case 'ACCOUNT_PENDING':
      return { kind: 'pending' };
    case 'ACCOUNT_SUSPENDED':
      return { kind: 'error', tone: 'red', text: T.login.errSuspended };
    case 'RATE_LIMITED': {
      const ms = r.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS;
      return { kind: 'error', tone: 'yellow', text: T.login.errRateLimited(formatWait(ms)), lockMs: ms };
    }
    case 'VALIDATION_ERROR':
      return { kind: 'error', tone: 'red', text: T.login.errPhoneFormat };
    default:
      return { kind: 'error', tone: 'red', text: T.common.errServer };
  }
}
