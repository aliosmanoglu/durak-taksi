import { z } from 'zod';
import { latLngSchema } from './schemas';

// Türkiye telefon numarası: "0532 123 45 67", "+905321234567", "5321234567" → "+905321234567"
export const phoneSchema = z
  .string()
  .transform((s) => s.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^(\+90|0)?[2-5]\d{9}$/, 'Geçersiz telefon numarası'))
  .transform((s) => `+90${s.slice(-10)}`);

// Plaka: "34 abc 123" → "34ABC123"
export const plateSchema = z
  .string()
  .transform((s) => s.replace(/\s/g, '').toUpperCase())
  .pipe(z.string().regex(/^(0[1-9]|[1-7]\d|8[01])[A-Z]{1,3}\d{2,4}$/, 'Geçersiz plaka'));

export const passwordSchema = z.string().min(8, 'Şifre en az 8 karakter olmalı').max(128);

export const ROLES = ['driver', 'stand', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ACCOUNT_STATUSES = ['pending', 'approved', 'suspended'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const driverRegisterSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: phoneSchema,
  password: passwordSchema,
  plate: plateSchema,
  licenseNo: z.string().trim().min(3).max(40),
  vehicleModel: z.string().trim().max(80).optional(),
  vehicleColor: z.string().trim().max(30).optional(),
  homeStandId: z.uuid().optional(),
  kvkkAccepted: z.literal(true),
});
export type DriverRegisterInput = z.infer<typeof driverRegisterSchema>;

export const RADIUS_LIMITS = { min: 500, max: 30_000 } as const;

export const standRegisterSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: phoneSchema,
  address: z.string().trim().max(300).optional(),
  location: latLngSchema,
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,60}$/, 'Kullanıcı adı 3-60 karakter: harf, rakam, . _ -'),
  password: passwordSchema,
  kvkkAccepted: z.literal(true),
});
export type StandRegisterInput = z.infer<typeof standRegisterSchema>;

export const loginSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('driver'), phone: phoneSchema, password: z.string().min(1).max(128) }),
  z.object({
    role: z.literal('stand'),
    username: z.string().trim().toLowerCase().min(1).max(60),
    password: z.string().min(1).max(128),
  }),
  z.object({ role: z.literal('admin'), username: z.string().trim().min(1).max(60), password: z.string().min(1).max(128) }),
]);
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });

export const standSettingsSchema = z
  .object({
    initialRadiusM: z.number().int().min(RADIUS_LIMITS.min).max(RADIUS_LIMITS.max),
    maxRadiusM: z.number().int().min(RADIUS_LIMITS.min).max(RADIUS_LIMITS.max),
  })
  .refine((v) => v.maxRadiusM >= v.initialRadiusM, {
    message: 'Maksimum yarıçap başlangıç yarıçapından küçük olamaz',
    path: ['maxRadiusM'],
  });

export type AuthTokens = { accessToken: string; refreshToken: string; accessExpiresIn: number };
