// Socket handler'ları için ortak ack yardımcıları.
import type { Logger } from 'pino';
import type { Ack } from '@duraknet/shared';
import { AppError } from './http/errors';

export const validationError = { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Geçersiz istek' } } as const;

export const rateLimitedError = { ok: false, error: { code: 'RATE_LIMITED', message: 'Çok fazla istek, biraz bekleyin' } } as const;

export function replyOf<T>(ack: unknown): (r: Ack<T>) => void {
  return typeof ack === 'function' ? (ack as (r: Ack<T>) => void) : () => {};
}

export function toAckError(err: unknown, log: Logger): Ack<never> {
  if (err instanceof AppError) return { ok: false, error: { code: err.code, message: err.message } };
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'socket handler hatası');
  return { ok: false, error: { code: 'INTERNAL', message: 'Sunucu hatası' } };
}
