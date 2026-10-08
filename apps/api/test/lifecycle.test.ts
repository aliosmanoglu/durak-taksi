// createGracefulShutdown (Faz 5): ikinci sinyalde zorla çıkış; zaman aşımı. Docker gerektirmez.
import type { Server } from 'node:http';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createGracefulShutdown } from '../src/lifecycle';

function fakes() {
  const exits: number[] = [];
  const httpServer = { close: (cb?: () => void) => cb?.(), closeIdleConnections: () => undefined } as unknown as Server;
  const io = { close: (cb?: () => void) => cb?.() };
  return { exits, httpServer, io };
}

describe('createGracefulShutdown', () => {
  it('ikinci sinyalde hemen exit(1) çağrılır; ilk kapanış yine temiz biter', async () => {
    const { exits, httpServer, io } = fakes();
    const g = createGracefulShutdown({
      log: pino({ level: 'silent' }), drainMs: 100, timeoutMs: 5000, httpServer, io,
      closeResources: async () => undefined, exit: (c) => exits.push(c),
    });
    expect(g.isShuttingDown()).toBe(false);
    const first = g.shutdown('SIGTERM');
    expect(g.isShuttingDown()).toBe(true);
    await g.shutdown('SIGINT');
    expect(exits).toEqual([1]); // drain bitmeden zorla çıkış
    await first;
    expect(exits).toEqual([1, 0]);
  });

  it('tek sinyal: temiz kapanış exit(0), kaynaklar bir kez kapatılır', async () => {
    const { exits, httpServer, io } = fakes();
    let closed = 0;
    const g = createGracefulShutdown({
      log: pino({ level: 'silent' }), drainMs: 10, timeoutMs: 5000, httpServer, io,
      closeResources: async () => void closed++, exit: (c) => exits.push(c),
    });
    await g.shutdown('SIGTERM');
    expect(exits).toEqual([0]);
    expect(closed).toBe(1);
  });

  it('zaman aşımı: kaynak kapatma takılırsa exit(1)', async () => {
    const { exits, httpServer, io } = fakes();
    const g = createGracefulShutdown({
      log: pino({ level: 'silent' }), drainMs: 10, timeoutMs: 200, httpServer, io,
      closeResources: () => new Promise<void>(() => undefined), exit: (c) => exits.push(c),
    });
    void g.shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 600));
    expect(exits).toEqual([1]);
  });
});
