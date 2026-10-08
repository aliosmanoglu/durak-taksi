-- Up Migration

-- Faz 5: aynı Expo token'ı en fazla bir şoförde kayıtlı olabilir (PUT /me/push-token eskisini NULL'lar).
CREATE UNIQUE INDEX uq_drivers_push_token ON drivers (push_token) WHERE push_token IS NOT NULL;

-- Faz 5: ride_create idempotency (aynı durak + aynı clientRequestId tek ride üretir).
ALTER TABLE rides ADD COLUMN client_request_id uuid;
CREATE UNIQUE INDEX uq_rides_stand_client_request ON rides (stand_id, client_request_id) WHERE client_request_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS uq_rides_stand_client_request;
ALTER TABLE rides DROP COLUMN IF EXISTS client_request_id;
DROP INDEX IF EXISTS uq_drivers_push_token;
