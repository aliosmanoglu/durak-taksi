// clientIpOf (Faz 5 handshake IP sınırı): proxy-addr + net.isIP. Docker gerektirmez.
import { describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '@duraknet/shared';
import { clientIpOf } from '../src/rate-limits';

const req = (remote: string, xff?: string) =>
  ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as Parameters<typeof clientIpOf>[0];

describe('clientIpOf', () => {
  it('trust proxy false: X-Forwarded-For hiç okunmaz', () => {
    expect(clientIpOf(req('203.0.113.7', '1.2.3.4'), false)).toBe('203.0.113.7');
    expect(clientIpOf(req('127.0.0.1', '1.2.3.4'), false)).toBe('127.0.0.1');
  });

  it('güvenilen eşten gelen geçerli XFF kullanılır', () => {
    expect(clientIpOf(req('127.0.0.1', '198.51.100.9'), 'loopback')).toBe('198.51.100.9');
    expect(clientIpOf(req('127.0.0.1', 'spoof, 9.9.9.9'), 1)).toBe('9.9.9.9');
  });

  it('güvenilmeyen doğrudan eş XFF taklidi yapsa da bağlantı adresi sayılır', () => {
    expect(clientIpOf(req('203.0.113.7', '1.2.3.4'), 'loopback')).toBe('203.0.113.7');
    expect(clientIpOf(req('203.0.113.7', '1.2.3.4, 5.6.7.8'), 'loopback')).toBe('203.0.113.7');
  });

  it('XFF\'te geçersiz değer: bağlantı adresine düşer (anahtar şişirilemez)', () => {
    expect(clientIpOf(req('127.0.0.1', 'not-an-ip'), 'loopback')).toBe('127.0.0.1');
    expect(clientIpOf(req('127.0.0.1', 'a'.repeat(300)), 'loopback')).toBe('127.0.0.1');
    expect(clientIpOf(req('127.0.0.1', '999.1.1.1'), 'loopback')).toBe('127.0.0.1');
  });

  it('XFF yoksa bağlantı adresi', () => {
    expect(clientIpOf(req('127.0.0.1'), 'loopback')).toBe('127.0.0.1');
  });

  it('handshake varsayılan sınırı 600/dk', () => {
    expect(RATE_LIMITS.socketHandshakeIp).toEqual({ limit: 600, windowMs: 60_000 });
  });
});
