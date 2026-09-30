// CLAUDE.md Bölüm 6 — event adları. Yeni event önce buraya, sonra CLAUDE.md'ye eklenir.

export const NAMESPACES = { driver: '/driver', stand: '/stand' } as const;

export const COMMON_EVENTS = {
  authRefresh: 'auth_refresh',
  authExpired: 'auth_expired',
  sessionSync: 'session_sync',
} as const;

export const DRIVER_EVENTS = {
  goOnline: 'driver_go_online',
  /** C → S `{}`; ack `Ack<DriverSessionSync>`. Bağlıyken güncel durumu istemek için (ör. arka plandan dönüş). */
  sessionSyncRequest: 'session_sync_request',
  goOffline: 'driver_go_offline',
  locationUpdate: 'driver_location_update',
  rideRequested: 'ride_requested',
  rideAccept: 'ride_accept',
  rideAccepted: 'ride_accepted',
  rideDecline: 'ride_decline',
  rideTaken: 'ride_taken',
  rideDriverCancel: 'ride_driver_cancel',
  rideComplete: 'ride_complete',
  /** S → C `RideCompletedEvent`. Yalnızca durak tamamladığında şoföre gider (şoför kendi ack'ini alır). */
  rideCompleted: 'ride_completed',
  rideCancelled: 'ride_cancelled',
} as const;

export const STAND_EVENTS = {
  rideCreate: 'ride_create',
  rideSearching: 'ride_searching',
  rideMatched: 'ride_matched',
  rideDriverCancelled: 'ride_driver_cancelled',
  /** C → S `{ rideId, version }`, ack; eşleşmiş ride'ı durak da tamamlayabilir. */
  rideComplete: 'ride_complete',
  rideCompleted: 'ride_completed',
  rideStillOpen: 'ride_still_open',
  rideCancel: 'ride_cancel',
  rideCancelled: 'ride_cancelled',
  nearbyDrivers: 'stand_nearby_drivers',
} as const;

export const RIDE_ROOM_EVENTS = {
  driverLocation: 'ride_driver_location',
} as const;

// Oda adları — hiçbir kod socket.id listesi tutmaz, yalnızca odalara yayın yapar.
export const rooms = {
  driver: (id: string) => `driver:${id}`,
  stand: (id: string) => `stand:${id}`,
  ride: (id: string) => `ride:${id}`,
} as const;
