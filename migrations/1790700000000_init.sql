-- Up Migration

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE account_status AS ENUM ('pending', 'approved', 'suspended');
CREATE TYPE ride_status    AS ENUM ('created', 'searching', 'matched', 'completed', 'cancelled');

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===== Duraklar =====
CREATE TABLE stands (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              varchar(120) NOT NULL,
  phone             varchar(20)  NOT NULL,
  address           text,
  location          geography(Point, 4326) NOT NULL,
  username          varchar(60)  NOT NULL UNIQUE,
  password_hash     text         NOT NULL,
  token_version     integer      NOT NULL DEFAULT 0,
  status            account_status NOT NULL DEFAULT 'pending',
  initial_radius_m  integer NOT NULL DEFAULT 2000,
  max_radius_m      integer NOT NULL DEFAULT 8000,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (initial_radius_m > 0 AND max_radius_m >= initial_radius_m)
);
CREATE INDEX idx_stands_location ON stands USING GIST (location);
CREATE TRIGGER trg_stands_updated_at BEFORE UPDATE ON stands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===== Şoförler =====
CREATE TABLE drivers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         varchar(120) NOT NULL,
  phone             varchar(20)  NOT NULL UNIQUE,
  password_hash     text         NOT NULL,
  token_version     integer      NOT NULL DEFAULT 0,
  status            account_status NOT NULL DEFAULT 'pending',
  home_stand_id     uuid REFERENCES stands(id) ON DELETE SET NULL,
  plate             varchar(15)  NOT NULL UNIQUE,
  license_no        varchar(40)  NOT NULL,
  vehicle_model     varchar(80),
  vehicle_color     varchar(30),
  push_token        text,
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_drivers_updated_at BEFORE UPDATE ON drivers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===== Çağrılar (Faz 3'te kullanılacak) =====
CREATE TABLE rides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code        varchar(8)   NOT NULL UNIQUE,
  stand_id          uuid NOT NULL REFERENCES stands(id),
  driver_id         uuid REFERENCES drivers(id),
  status            ride_status  NOT NULL DEFAULT 'created',
  version           integer      NOT NULL DEFAULT 0,

  pickup_location   geography(Point, 4326) NOT NULL,
  pickup_address    text NOT NULL,
  dropoff_location  geography(Point, 4326),
  dropoff_address   text,
  notes             varchar(280),

  dispatch_wave     smallint NOT NULL DEFAULT 0,
  current_radius_m  integer,
  notified_count    integer  NOT NULL DEFAULT 0,

  cancel_reason     varchar(120),

  created_at        timestamptz NOT NULL DEFAULT now(),
  searching_at      timestamptz,
  matched_at        timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz
);
CREATE INDEX idx_rides_stand_status  ON rides (stand_id, status);
CREATE INDEX idx_rides_driver_status ON rides (driver_id, status);
CREATE INDEX idx_rides_created_at    ON rides (created_at DESC);
CREATE UNIQUE INDEX uq_driver_one_active_ride ON rides (driver_id) WHERE status = 'matched';

-- Down Migration

DROP TABLE IF EXISTS rides;
DROP TABLE IF EXISTS drivers;
DROP TABLE IF EXISTS stands;
DROP FUNCTION IF EXISTS set_updated_at();
DROP TYPE IF EXISTS ride_status;
DROP TYPE IF EXISTS account_status;
