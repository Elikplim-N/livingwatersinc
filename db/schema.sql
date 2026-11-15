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
