// Ride event'lerinin istemcilere çıkışı. Hiçbir kod socket.id listesi tutmaz; yalnızca odalara yayın yapılır.
// Servis bu arayüze bağlıdır: API node'unda Socket.io sunucusu (redis-adapter ile tüm node'lara dağılır),
// worker'da redis-emitter uygular.
import type { Server } from 'socket.io';
import { NAMESPACES, rooms } from '@duraknet/shared';

export interface RideEventSink {
  toDriver(driverId: string, event: string, payload: unknown): void;
  toStand(standId: string, event: string, payload: unknown): void;
  /** `/stand` namespace'indeki `ride:{rideId}` odası (eşleşen aracın canlı konumu). */
  toStandRide(rideId: string, event: string, payload: unknown): void;
  /** Eşleşmede ilgili şoförün (`/driver`) ve durağın (`/stand`) tüm soketlerini `ride:{rideId}` odasına alır. */
  joinRide(rideId: string, parties: { driverId?: string; standId?: string }): void;
  /** Soketleri `ride:{rideId}` odasından çıkarır. `which`: hangi tarafın odası boşaltılacak. */
  leaveRide(rideId: string, which: 'driver' | 'stand' | 'both'): void;
}

export function createIoSink(io: Server): RideEventSink {
  const drv = () => io.of(NAMESPACES.driver);
  const std = () => io.of(NAMESPACES.stand);
  return {
    toDriver: (id, event, payload) => void drv().to(rooms.driver(id)).emit(event, payload),
    toStand: (id, event, payload) => void std().to(rooms.stand(id)).emit(event, payload),
    toStandRide: (rideId, event, payload) => void std().to(rooms.ride(rideId)).emit(event, payload),
    joinRide(rideId, p) {
      const room = rooms.ride(rideId);
      if (p.driverId) drv().in(rooms.driver(p.driverId)).socketsJoin(room);
      if (p.standId) std().in(rooms.stand(p.standId)).socketsJoin(room);
    },
    leaveRide(rideId, which) {
      const room = rooms.ride(rideId);
      if (which !== 'stand') drv().in(room).socketsLeave(room);
      if (which !== 'driver') std().in(room).socketsLeave(room);
    },
  };
}

/** Yayın yapmayan sink (yalnızca test/kimlik kurulumları). */
export const noopSink: RideEventSink = {
  toDriver() {}, toStand() {}, toStandRide() {}, joinRide() {}, leaveRide() {},
};
