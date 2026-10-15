// Durak kayıt formunun doğrulaması: sözleşme şeması çalıştırılır, hatalar alan bazında Türkçe metne eşlenir.
import { standRegisterSchema, type StandRegisterInput } from '@duraknet/shared';
import { TA } from './texts-admin';

export type StandRegisterForm = {
  name: string;
  phone: string;
  address: string;
  username: string;
  password: string;
  lat: string;
  lng: string;
  kvkk: boolean;
};
export type StandRegisterField = 'name' | 'phone' | 'username' | 'password' | 'location' | 'kvkk';
export type StandRegisterErrors = Partial<Record<StandRegisterField, string>>;

const MESSAGES: Record<StandRegisterField, string> = {
  name: TA.register.errName,
  phone: TA.register.errPhone,
  username: TA.register.errUsername,
  password: TA.register.errPassword,
  location: TA.register.errLocation,
  kvkk: TA.register.kvkkRequired,
};

/** "41,0082" ve "41.0082" kabul edilir; boş/sayı olmayan NaN döner. */
export function parseCoord(s: string): number {
  const t = s.trim().replace(',', '.');
  return t === '' ? NaN : Number(t);
}

export function validateStandRegister(
  f: StandRegisterForm,
): { ok: true; input: StandRegisterInput } | { ok: false; errors: StandRegisterErrors } {
  const lat = parseCoord(f.lat);
  const lng = parseCoord(f.lng);
  const r = standRegisterSchema.safeParse({
    name: f.name,
    phone: f.phone,
    address: f.address.trim() === '' ? undefined : f.address,
    location: { lat, lng },
    username: f.username,
    password: f.password,
    kvkkAccepted: f.kvkk ? true : undefined,
  });
  if (r.success) return { ok: true, input: r.data };
  const errors: StandRegisterErrors = {};
  for (const issue of r.error.issues) {
    const k = issue.path[0];
    const field: StandRegisterField | null =
      k === 'location' ? 'location' : k === 'kvkkAccepted' ? 'kvkk' : k === 'name' || k === 'phone' || k === 'username' || k === 'password' ? k : null;
    if (field) errors[field] ??= MESSAGES[field];
  }
  return { ok: false, errors };
}
