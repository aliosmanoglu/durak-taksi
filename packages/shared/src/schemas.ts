import { z } from 'zod';

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
