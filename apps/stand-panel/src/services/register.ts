import type { StandRegisterInput } from '@duraknet/shared';
import { api } from './http';

/** `POST /auth/stand/register` (hesap `pending` açılır). */
export function registerStand(input: StandRegisterInput) {
  return api<{ id: string; status: string }>('POST', '/auth/stand/register', { body: input });
}
