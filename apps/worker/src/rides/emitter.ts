// Worker'ın istemcilere yayını: Socket.io'ya doğrudan bağlı değildir; @socket.io/redis-emitter ile API node'larındaki
// redis-adapter'ın dinlediği kanallara yayın yapar. Hedefleme yalnızca odalarla; socket.id tutulmaz.
import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import { NAMESPACES, rooms } from '@duraknet/shared';

export interface WorkerEmitter {
  toDriver(driverId: string, event: string, payload: unknown): void;
  toStand(standId: string, event: string, payload: unknown): void;
}

export function createWorkerEmitter(redis: Redis): WorkerEmitter {
  const emitter = new Emitter(redis);
  return {
    toDriver: (id, event, payload) => void emitter.of(NAMESPACES.driver).to(rooms.driver(id)).emit(event, payload),
    toStand: (id, event, payload) => void emitter.of(NAMESPACES.stand).to(rooms.stand(id)).emit(event, payload),
  };
}
