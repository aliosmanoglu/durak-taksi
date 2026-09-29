import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { ErrorCode } from '@duraknet/shared';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const errors = {
  unauthorized: (m = 'Kimlik doğrulanamadı') => new AppError(401, 'UNAUTHORIZED', m),
  forbidden: (m = 'Bu işlem için yetkiniz yok') => new AppError(403, 'FORBIDDEN', m),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Kullanıcı bilgileri hatalı'),
  pending: () => new AppError(403, 'ACCOUNT_PENDING', 'Hesabınız yönetici onayı bekliyor'),
  suspended: () => new AppError(403, 'ACCOUNT_SUSPENDED', 'Hesabınız askıya alınmış'),
  notFound: (m = 'Kayıt bulunamadı') => new AppError(404, 'NOT_FOUND', m),
  conflict: (m: string) => new AppError(409, 'CONFLICT', m),
  validation: (m: string) => new AppError(400, 'VALIDATION_ERROR', m),
};

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw errors.validation(z.prettifyError(r.error));
  return r.data;
}

type HttpLikeError = { status?: unknown; expose?: unknown; type?: unknown };

// pg hatalarının `detail` / `where` alanları satır değerleri (telefon vb.) içerebilir; loga yazılmaz (KVKK).
function safeForLog(err: unknown) {
  if (!(err instanceof Error)) return { value: String(err) };
  const e = err as Error & { code?: unknown; constraint?: unknown; table?: unknown };
  return { name: e.name, message: e.message, code: e.code, constraint: e.constraint, table: e.table, stack: e.stack };
}

export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
      return;
    }
    // body-parser vb. istemci hataları (geçersiz JSON, çok büyük gövde, desteklenmeyen charset...)
    const h = err as HttpLikeError;
    if (typeof h?.status === 'number' && h.status >= 400 && h.status < 500 && h.expose === true) {
      const status = h.status === 413 ? 413 : 400;
      res.status(status).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Geçersiz istek gövdesi' } });
      return;
    }
    log.error({ err: safeForLog(err) }, 'beklenmeyen hata');
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Sunucu hatası' } });
  };
}
