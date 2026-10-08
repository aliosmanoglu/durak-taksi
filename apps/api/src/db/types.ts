import type { ColumnType, Generated } from 'kysely';
import type { AccountStatus, RideStatus } from '@duraknet/shared';

// geography(Point) kolonları doğrudan seçilmez; ST_Y/ST_X ile okunur, ST_MakePoint ile yazılır.
type Geography = ColumnType<unknown, unknown, unknown>;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface StandsTable {
  id: Generated<string>;
  name: string;
  phone: string;
  address: string | null;
  location: Geography;
  username: string;
  password_hash: string;
  token_version: Generated<number>;
  status: Generated<AccountStatus>;
  initial_radius_m: Generated<number>;
  max_radius_m: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface DriversTable {
  id: Generated<string>;
  full_name: string;
  phone: string;
  password_hash: string;
  token_version: Generated<number>;
  status: Generated<AccountStatus>;
  home_stand_id: string | null;
  plate: string;
  license_no: string;
  vehicle_model: string | null;
  vehicle_color: string | null;
  push_token: string | null;
  approved_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface RidesTable {
  id: Generated<string>;
  short_code: string;
  stand_id: string;
  driver_id: string | null;
  status: Generated<RideStatus>;
  version: Generated<number>;
  pickup_location: Geography;
  pickup_address: string;
  dropoff_location: Geography | null;
  dropoff_address: string | null;
  notes: string | null;
  dispatch_wave: Generated<number>;
  current_radius_m: number | null;
  notified_count: Generated<number>;
  cancel_reason: string | null;
  client_request_id: string | null;
  created_at: Generated<Timestamp>;
  searching_at: Timestamp | null;
  matched_at: Timestamp | null;
  completed_at: Timestamp | null;
  cancelled_at: Timestamp | null;
}

export interface Database {
  stands: StandsTable;
  drivers: DriversTable;
  rides: RidesTable;
}
