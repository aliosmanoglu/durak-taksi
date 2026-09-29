import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { AuthDeps } from '../src/auth/service';
import { createRealtime } from '../src/realtime';

// server.ts ile aynı bağlama sırası. Bu testler DB'ye ulaşmadan reddedilen handshake'leri kullanır;
// amaç taşıma katmanını (polling + websocket) ve Express/Socket.io birlikteliğini korumaktır.
const deps = {
  db: undefined,
  secrets: { accessSecret: 'a'.repeat(32), refreshSecret: 'b'.repeat(32) },
  admin: { username: 'admin', passwordHash: '', tokenVersion: 0 },
} as unknown as AuthDeps;

let httpServer: Server;
let url: string;

beforeAll(async () => {
  const { attach } = createRealtime(deps, pino({ level: 'silent' }), { corsOrigin: '*' });
  httpServer = createServer(createApp());
  attach(httpServer);
  await new Promise<void>((r) => httpServer.listen(0, r));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => httpServer.close(() => r())));

function connectError(nsp: string, opts: Parameters<typeof connect>[1]): Promise<{ message: string; data: unknown }> {
  return new Promise((resolve, reject) => {
    const s: Socket = connect(`${url}${nsp}`, { reconnection: false, ...opts });
    s.on('connect', () => {
      s.close();
      reject(new Error('beklenmedik bağlantı'));
    });
    s.on('connect_error', (err: Error & { data?: unknown }) => {
      s.close();
      resolve({ message: err.message, data: err.data });
    });
  });
}

describe('socket taşıma katmanı', () => {
  it.each([['polling'], ['websocket']])('%s ile token olmadan bağlanma UNAUTHORIZED döner (HTTP 404 değil)', async (transport) => {
    const err = await connectError('/driver', { transports: [transport], auth: {} });
    expect(err.message).toBe('UNAUTHORIZED');
    expect(err.data).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('geçersiz token reddedilir', async () => {
    const err = await connectError('/stand', { auth: { token: 'sahte' } });
    expect(err.message).toBe('UNAUTHORIZED');
  });

  it('ana namespace kullanılamaz', async () => {
    const err = await connectError('/', { auth: {} });
    expect(err.message).toBe('FORBIDDEN');
  });

  it('Express uçları socket.io ile birlikte çalışmaya devam eder', async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
  });
});
