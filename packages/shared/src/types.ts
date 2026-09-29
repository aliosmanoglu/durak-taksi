// CLAUDE.md Bölüm 6 — ortak tipler. Sözleşmenin tek kaynağı burasıdır.

export const RIDE_STATUSES = ['created', 'searching', 'matched', 'completed', 'cancelled'] as const;
export type RideStatus = (typeof RIDE_STATUSES)[number];

export const TERMINAL_RIDE_STATUSES: readonly RideStatus[] = ['completed', 'cancelled'];

export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'RIDE_NOT_AVAILABLE',
  'NOT_A_CANDIDATE',
  'DRIVER_NOT_AVAILABLE',
  'INVALID_TRANSITION',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_PENDING',
  'ACCOUNT_SUSPENDED',
  'CONFLICT',
  'NOT_FOUND',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type LatLng = { lat: number; lng: number };

export type Ack<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: { code: ErrorCode; message: string } };

export type DriverStatus = 'offline' | 'available' | 'busy';

export type RideRequest = {
  rideId: string;
  shortCode: string;
  pickup: LatLng;
  pickupAddress: string;
  dropoffAddress?: string;
  notes?: string;
  standName: string;
  distanceM: number;
  createdAt: string;
  version: number;
};

export type RideSnapshot = {
  rideId: string;
  shortCode: string;
  status: RideStatus;
  version: number;
  stand: { id: string; name: string; phone: string; location: LatLng };
  pickup: LatLng;
  pickupAddress: string;
  dropoff?: LatLng;
  dropoffAddress?: string;
  notes?: string;
  driver?: { id: string; name: string; plate: string; vehicle?: string; phone: string; location?: LatLng };
  createdAt: string;
  matchedAt?: string;
};
