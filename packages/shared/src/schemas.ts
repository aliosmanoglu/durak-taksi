import { z } from 'zod';
import { RIDE_STATUSES } from './types';

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const authRefreshSchema = z.object({ token: z.string().min(1) });

export const goOnlineSchema = z.object({ location: latLngSchema });

/** `driver_go_offline` ve `session_sync_request` gövdesi: boş nesne (fazla alan yok sayılır). */
export const emptyPayloadSchema = z.object({});

export const locationUpdateSchema = z.object({
  location: latLngSchema,
  heading: z.number().min(0).max(360).optional(),
  accuracy: z.number().nonnegative().optional(),
  ts: z.number().int().positive(),
});

export const rideIdSchema = z.object({ rideId: z.uuid() });

export const rideDeclineSchema = rideIdSchema;
export const rideAcceptSchema = rideIdSchema;

export const rideDriverCancelSchema = z.object({
  rideId: z.uuid(),
  reason: z.string().max(120).optional(),
  version: z.number().int().nonnegative(),
});

export const rideCompleteSchema = z.object({
  rideId: z.uuid(),
  version: z.number().int().nonnegative(),
});

export const rideCreateSchema = z.object({
  pickup: latLngSchema,
  pickupAddress: z.string().min(1).max(300),
  dropoff: latLngSchema.optional(),
  dropoffAddress: z.string().max(300).optional(),
  notes: z.string().max(280).optional(),
});

export const rideCancelSchema = z.object({
  rideId: z.uuid(),
  reason: z.string().max(120).optional(),
  version: z.number().int().nonnegative(),
});

// ===== Sunucu → istemci payload'ları (Bölüm 6) =====
// Ride içeren her event `version` taşır; istemci elindekinden düşük sürümlüyü yok sayar.

const versionSchema = z.number().int().nonnegative();
const isoDateSchema = z.iso.datetime();

export const rideStatusSchema = z.enum(RIDE_STATUSES);

export const rideRequestSchema = z.object({
  rideId: z.uuid(),
  shortCode: z.string().min(1).max(8),
  pickup: latLngSchema,
  pickupAddress: z.string(),
  dropoffAddress: z.string().optional(),
  notes: z.string().optional(),
  standName: z.string(),
  distanceM: z.number().nonnegative(),
  createdAt: isoDateSchema,
  version: versionSchema,
  /** Sunucu saati (ISO-8601 `Z`) — üretildiği an; istemci `createdAt` ile cihaz saati farkını giderir. */
  serverNow: isoDateSchema,
});
export type RideRequest = z.infer<typeof rideRequestSchema>;

export const rideSnapshotSchema = z.object({
  rideId: z.uuid(),
  shortCode: z.string().min(1).max(8),
  status: rideStatusSchema,
  version: versionSchema,
  stand: z.object({ id: z.uuid(), name: z.string(), phone: z.string(), location: latLngSchema }),
  pickup: latLngSchema,
  pickupAddress: z.string(),
  dropoff: latLngSchema.optional(),
  dropoffAddress: z.string().optional(),
  notes: z.string().optional(),
  driver: z
    .object({
      id: z.uuid(),
      name: z.string(),
      plate: z.string(),
      vehicle: z.string().optional(),
      phone: z.string(),
      location: latLngSchema.optional(),
    })
    .optional(),
  createdAt: isoDateSchema,
  matchedAt: isoDateSchema.optional(),
});
export type RideSnapshot = z.infer<typeof rideSnapshotSchema>;

/** `ride_create` ack verisi. */
export const rideCreateResultSchema = z.object({ rideId: z.uuid(), shortCode: z.string() });
export type RideCreateResult = z.infer<typeof rideCreateResultSchema>;

/** `/driver` `ride_taken`: başkası aldı veya çağrı kapandı (durak iptali dahil); ekrandan kaldırılır. */
export const rideTakenSchema = z.object({ rideId: z.uuid() });
export type RideTakenEvent = z.infer<typeof rideTakenSchema>;

/** `/stand` `ride_searching`: her dalga/taramada. */
export const rideSearchingSchema = z.object({
  rideId: z.uuid(),
  wave: z.number().int().nonnegative(),
  radiusM: z.number().int().positive(),
  notifiedCount: z.number().int().nonnegative(),
  searchingSince: isoDateSchema,
  version: versionSchema,
});
export type RideSearchingEvent = z.infer<typeof rideSearchingSchema>;

/** `/stand` `ride_matched`. */
export const rideMatchedSchema = z.object({
  rideId: z.uuid(),
  driver: z.object({
    id: z.uuid(),
    name: z.string(),
    plate: z.string(),
    vehicle: z.string().optional(),
    phone: z.string(),
  }),
  distanceM: z.number().nonnegative(),
  version: versionSchema,
});
export type RideMatchedEvent = z.infer<typeof rideMatchedSchema>;

/** `/stand` `ride_driver_cancelled`: eşleşen şoför vazgeçti veya askıya alındı; arama yeniden başladı. */
export const rideDriverCancelledSchema = z.object({
  rideId: z.uuid(),
  reason: z.string().optional(),
  driverName: z.string(),
  plate: z.string(),
  version: versionSchema,
});
export type RideDriverCancelledEvent = z.infer<typeof rideDriverCancelledSchema>;

/** `/stand` `ride_still_open`: yalnızca bildirim; çağrıyı iptal etmez. */
export const rideStillOpenSchema = z.object({
  rideId: z.uuid(),
  searchingSince: isoDateSchema,
  minutesOpen: z.number().int().nonnegative(),
  version: versionSchema,
});
export type RideStillOpenEvent = z.infer<typeof rideStillOpenSchema>;

/**
 * `ride_completed`: hem `/stand`'a (şoför veya durak tamamlamasında) hem de `/driver`'a gider.
 * Şoföre yalnızca durak tamamladığında gönderilir (şoför kendi tamamlamasında ack alır).
 */
export const rideCompletedSchema = z.object({
  rideId: z.uuid(),
  completedAt: isoDateSchema,
  version: versionSchema,
});
export type RideCompletedEvent = z.infer<typeof rideCompletedSchema>;

/** `ride_cancelled`: `/driver`'a (eşleşmiş şoföre) ve `/stand`'a (iptalin onayı; diğer tabletler) gider. */
export const rideCancelledSchema = z.object({
  rideId: z.uuid(),
  reason: z.string().max(120).optional(),
  version: versionSchema,
});
export type RideCancelledEvent = z.infer<typeof rideCancelledSchema>;

/** `/stand` `stand_nearby_drivers`: 10 sn'de bir, `max_radius_m` içindeki `available` şoförler. */
export const nearbyDriversSchema = z.object({
  drivers: z.array(z.object({ id: z.uuid(), location: latLngSchema })),
});
export type NearbyDriversEvent = z.infer<typeof nearbyDriversSchema>;

/** Ride odası `ride_driver_location`. */
export const rideDriverLocationSchema = z.object({
  rideId: z.uuid(),
  location: latLngSchema,
  heading: z.number().min(0).max(360).optional(),
  ts: z.number().int().positive(),
});
export type RideDriverLocationEvent = z.infer<typeof rideDriverLocationSchema>;

/** `ride_complete` (durak → sunucu): şoför şemasıyla aynı gövde. */
export const standRideCompleteSchema = rideCompleteSchema;

/** `dn:events:ride` Pub/Sub mesajı (bilgilendirme; kritik iş BullMQ'dadır). */
export const rideEventMessageSchema = z.object({
  rideId: z.uuid(),
  from: rideStatusSchema,
  to: rideStatusSchema,
  version: versionSchema,
});
export type RideEventMessage = z.infer<typeof rideEventMessageSchema>;
