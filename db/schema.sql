-- LWI Street Tracker schema. Safe to run more than once.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS profiles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name  text NOT NULL,
  role       text NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_credentials (
  user_id       uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL
);

CREATE TABLE IF NOT EXISTS streets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  osm_ids    bigint[] NOT NULL DEFAULT '{}',
  name       text NOT NULL,
  district   text NOT NULL,
  geometry   jsonb NOT NULL,
  length_m   numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  street_id    uuid NOT NULL REFERENCES streets(id) ON DELETE CASCADE,
  visit_date   date NOT NULL,
  team_members text[] NOT NULL DEFAULT '{}',
  attendance   integer NOT NULL DEFAULT 0,
  decisions    integer NOT NULL DEFAULT 0,
  follow_ups   integer NOT NULL DEFAULT 0,
  notes        text NOT NULL DEFAULT '',
  photo_urls   text[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS visits_street_id_idx ON visits(street_id);

-- People who gave their lives to Christ during outreach (details for follow-up)
CREATE TABLE IF NOT EXISTS converts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  street_id      text,                        -- streets.id (kept as text so it works with any id type)
  full_name      text NOT NULL,
  age            integer,
  phone          text NOT NULL DEFAULT '',
  location       text NOT NULL DEFAULT '',    -- house no., landmark, directions
  latitude       double precision,
  longitude      double precision,
  accuracy_m     integer,
  notes          text NOT NULL DEFAULT '',
  decision_date  date NOT NULL DEFAULT current_date,
  followed_up_at date,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS converts_street_id_idx ON converts(street_id);

-- Field collectors: sign in with just name + phone (no password)
CREATE TABLE IF NOT EXISTS collectors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  phone        text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE converts ADD COLUMN IF NOT EXISTS collector_name  text;
ALTER TABLE converts ADD COLUMN IF NOT EXISTS collector_phone text;
ALTER TABLE converts ADD COLUMN IF NOT EXISTS client_id       text;  -- prevents duplicates when an offline entry is retried
CREATE UNIQUE INDEX IF NOT EXISTS converts_client_id_idx ON converts(client_id);

-- App settings (centre pin, zone sizes, Mapbox style) edited by the admin
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
