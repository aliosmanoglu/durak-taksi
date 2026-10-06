import type { AccountStatus, LatLng } from '@duraknet/shared';

/** `GET /me` (stand rolü). */
export type Me = {
  role: 'stand';
  id: string;
  name: string;
  phone: string;
  address: string | null;
  username: string;
  status: AccountStatus;
  initialRadiusM: number;
  maxRadiusM: number;
  location: LatLng;
};

export type LoginResult = {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
  role: string;
  id: string;
};

export type TokenPair = { accessToken: string; refreshToken: string; accessExpiresIn: number };
