import { VercelRequest, VercelResponse } from '@vercel/node';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3
});

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret');

interface AuthUser {
  userId: string;
  email?: string;
  role: string;
  name?: string;
  phone?: string;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function setCORS(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function requireAuth(req: VercelRequest, roles: string[] = ['admin']): AuthUser {
  if (!JWT_SECRET) throw new HttpError(500, 'Server misconfigured: JWT_SECRET is not set');
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Please sign in');
  try {
    const auth = jwt.verify(token, JWT_SECRET) as AuthUser;
    if (roles.includes(auth.role)) return auth;
  } catch {
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }
  throw new HttpError(401, 'Only admins can use this app.');
}

function toCount(value: unknown): number {
  const n = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 0;
}

const SCHEMA_SQL = `
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

-- "Up next": streets planned for the next outreach (null = not planned)
ALTER TABLE streets ADD COLUMN IF NOT EXISTS planned_at timestamptz;

-- Exact stage point on a street (where the stage is mounted) + optional street rep
ALTER TABLE streets ADD COLUMN IF NOT EXISTS stage_lat double precision;
ALTER TABLE streets ADD COLUMN IF NOT EXISTS stage_lng double precision;
ALTER TABLE streets ADD COLUMN IF NOT EXISTS stage_accuracy_m integer;
ALTER TABLE streets ADD COLUMN IF NOT EXISTS rep_name text;
ALTER TABLE streets ADD COLUMN IF NOT EXISTS rep_phone text;

-- Retention: converts from an outreach who came to church afterwards
ALTER TABLE visits ADD COLUMN IF NOT EXISTS sunday_count integer;    -- Qodesh City Church (following Sunday)
ALTER TABLE visits ADD COLUMN IF NOT EXISTS saturday_count integer;  -- Saturday Night Revival (following Saturday)
ALTER TABLE converts ADD COLUMN IF NOT EXISTS came_sunday boolean NOT NULL DEFAULT false;
ALTER TABLE converts ADD COLUMN IF NOT EXISTS came_saturday boolean NOT NULL DEFAULT false;

-- Road distance from the centre (Qodesh), worked out once via OSRM (OpenStreetMap roads) and stored
ALTER TABLE streets ADD COLUMN IF NOT EXISTS road_dist_m integer;
ALTER TABLE streets ADD COLUMN IF NOT EXISTS road_time_s integer;
ALTER TABLE streets ADD COLUMN IF NOT EXISTS road_from text;   -- centre the numbers were computed from ("lat,lng")
`;

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await pool.query(SCHEMA_SQL);
  schemaReady = true;
}

async function adminCount(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM profiles p JOIN auth_credentials ac ON ac.user_id = p.id WHERE p.role = 'admin'`
  );
  return rows[0].n;
}

const signToken = (u: { id: string; email: string; role: string }) =>
  jwt.sign({ userId: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '30d' });

const STREET_SELECT = `
  SELECT
    s.id, s.name, s.district, s.geometry, s.length_m, s.planned_at,
    s.stage_lat, s.stage_lng, s.stage_accuracy_m, s.rep_name, s.rep_phone, s.road_dist_m, s.road_time_s,
    COALESCE(
      json_agg(
        json_build_object(
          'id', v.id,
          'visit_date', v.visit_date,
          'team_members', v.team_members,
          'attendance', v.attendance,
          'decisions', v.decisions,
          'follow_ups', v.follow_ups,
          'sunday_count', v.sunday_count,
          'saturday_count', v.saturday_count,
          'notes', v.notes,
          'created_at', v.created_at
        ) ORDER BY v.visit_date DESC, v.created_at DESC
      ) FILTER (WHERE v.id IS NOT NULL),
      '[]'
    ) AS visits
  FROM streets s
  LEFT JOIN visits v ON s.id = v.street_id
`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Normalise "/api/streets/123?x=y" -> ["streets", "123"]
  const path = (req.url || '').split('?')[0].replace(/^\/api/, '').replace(/\/+$/, '');
  const [resource, id] = path.split('/').filter(Boolean);
  const method = req.method || 'GET';

  try {
    if (!resource || resource === 'health') {
      return res.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // ---- First-time setup: create tables + the single admin account ----
    if (resource === 'setup' && method === 'GET') {
      await ensureSchema();
      return res.json({ needs_setup: (await adminCount()) === 0 });
    }

    if (resource === 'setup' && method === 'POST') {
      if (!JWT_SECRET) throw new HttpError(500, 'Server misconfigured: JWT_SECRET is not set');
      await ensureSchema();
      const { email, full_name, password, setup_key } = req.body || {};
      const keyOk = !!process.env.SETUP_KEY && setup_key === process.env.SETUP_KEY;
      if ((await adminCount()) > 0 && !keyOk) throw new HttpError(403, 'Setup is already done. Sign in instead.');
      if (!email?.trim() || !full_name?.trim()) throw new HttpError(400, 'Name and email are required');
      if (String(password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Start clean: remove all old data and accounts, leaving only this admin
        await client.query('TRUNCATE converts, collectors, visits, streets, auth_credentials, profiles RESTART IDENTITY CASCADE');
        const p = await client.query(`INSERT INTO profiles (full_name, role) VALUES ($1, 'admin') RETURNING id`, [full_name.trim()]);
        await client.query('INSERT INTO auth_credentials (user_id, email, password_hash) VALUES ($1, $2, $3)', [
          p.rows[0].id, email.trim(), await bcrypt.hash(String(password), 10)
        ]);
        await client.query('COMMIT');
        const user = { id: p.rows[0].id, email: email.trim(), full_name: full_name.trim(), role: 'admin' };
        return res.status(201).json({ token: signToken(user), user });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // ---- Admin account & data control ----
    if (resource === 'account' && method === 'PUT') {
      const auth = requireAuth(req);
      const { current_password, email, full_name, new_password } = req.body || {};
      const cur = await pool.query('SELECT password_hash FROM auth_credentials WHERE user_id = $1', [auth.userId]);
      if (!cur.rows[0] || !(await bcrypt.compare(String(current_password || ''), cur.rows[0].password_hash))) {
        throw new HttpError(400, 'Current password is incorrect');
      }
      if (new_password && String(new_password).length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
      if (email?.trim()) await pool.query('UPDATE auth_credentials SET email = $1 WHERE user_id = $2', [email.trim(), auth.userId]);
      if (full_name?.trim()) await pool.query('UPDATE profiles SET full_name = $1 WHERE id = $2', [full_name.trim(), auth.userId]);
      if (new_password) await pool.query('UPDATE auth_credentials SET password_hash = $1 WHERE user_id = $2', [await bcrypt.hash(String(new_password), 10), auth.userId]);
      const u = await pool.query(
        `SELECT p.id, ac.email, p.full_name, p.role FROM profiles p JOIN auth_credentials ac ON ac.user_id = p.id WHERE p.id = $1`,
        [auth.userId]
      );
      return res.json({ token: signToken(u.rows[0]), user: u.rows[0] });
    }

    if (resource === 'admin' && id === 'reset' && method === 'POST') {
      const auth = requireAuth(req);
      const cur = await pool.query('SELECT password_hash FROM auth_credentials WHERE user_id = $1', [auth.userId]);
      if (!cur.rows[0] || !(await bcrypt.compare(String(req.body?.password || ''), cur.rows[0].password_hash))) {
        throw new HttpError(400, 'Password is incorrect');
      }
      await ensureSchema();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const c = await client.query('DELETE FROM converts');
        await client.query('DELETE FROM collectors');
        const v = await client.query('DELETE FROM visits');
        const s = await client.query('DELETE FROM streets');
        await client.query('DELETE FROM auth_credentials WHERE user_id <> $1', [auth.userId]);
        const a = await client.query('DELETE FROM profiles WHERE id <> $1', [auth.userId]);
        await client.query(`UPDATE profiles SET role = 'admin' WHERE id = $1`, [auth.userId]);
        await client.query('COMMIT');
        return res.json({ converts: c.rowCount, visits: v.rowCount, streets: s.rowCount, accounts: a.rowCount });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // ---- Auth ----
    if (resource === 'auth' && id === 'login' && method === 'POST') {
      if (!JWT_SECRET) throw new HttpError(500, 'Server misconfigured: JWT_SECRET is not set');
      const { email, password } = req.body || {};
      if (!email || !password) throw new HttpError(400, 'Email and password are required');

      const result = await pool.query(
        `SELECT ac.user_id AS id, ac.email, ac.password_hash, p.full_name, p.role
         FROM auth_credentials ac
         JOIN profiles p ON ac.user_id = p.id
         WHERE lower(ac.email) = lower($1)`,
        [String(email).trim()]
      );

      const user = result.rows[0];
      if (!user || !(await bcrypt.compare(String(password), user.password_hash))) {
        throw new HttpError(401, 'Incorrect email or password');
      }
      if (user.role !== 'admin') throw new HttpError(403, 'Only admins can use this app.');

      const token = signToken(user);
      return res.json({
        token,
        user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role }
      });
    }

    if (resource === 'auth' && id === 'me' && method === 'GET') {
      const auth = requireAuth(req);
      const result = await pool.query(
        `SELECT p.id, ac.email, p.full_name, p.role
         FROM profiles p JOIN auth_credentials ac ON ac.user_id = p.id
         WHERE p.id = $1`,
        [auth.userId]
      );
      if (!result.rows[0]) throw new HttpError(401, 'Account not found');
      return res.json(result.rows[0]);
    }

    // ---- Streets ----
    if (resource === 'streets') {
      const auth = requireAuth(req);
      await ensureSchema();


      // Road distance + drive time from the centre (Qodesh) to each street, following real roads.
      // Computed in batches with OSRM's table service (OpenStreetMap data) and stored, so the app never
      // needs a routing API just to show it. Call repeatedly until `remaining` is 0.
      if (method === 'POST' && id === 'road-distances') {
        const cRes = await pool.query(`SELECT value FROM app_settings WHERE key = 'center'`);
        const c = cRes.rows[0]?.value || { lat: 5.587981, lng: -0.230065 };
        const key = `${Number(c.lat).toFixed(6)},${Number(c.lng).toFixed(6)}`;
        const todo = await pool.query(
          'SELECT id, geometry, stage_lat, stage_lng FROM streets WHERE road_from IS DISTINCT FROM $1 LIMIT 240', [key]
        );
        const pts = todo.rows.map((s: any) => {
          if (s.stage_lat != null && s.stage_lng != null) return { id: s.id, lat: Number(s.stage_lat), lng: Number(s.stage_lng) };
          const line = s.geometry?.coordinates?.[0];
          const mid = Array.isArray(line) && line.length ? line[Math.floor(line.length / 2)] : null;
          return mid ? { id: s.id, lat: Number(mid[1]), lng: Number(mid[0]) } : { id: s.id, lat: NaN, lng: NaN };
        });
        let updated = 0, failed = 0;
        for (let i = 0; i < pts.length; i += 80) {
          const chunk = pts.slice(i, i + 80);
          const ok = chunk.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
          let dist: (number | null)[] = [], dur: (number | null)[] = [];
          if (ok.length) {
            const coords = [`${c.lng},${c.lat}`, ...ok.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`)].join(';');
            const url = `https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&annotations=distance,duration`;
            const resp = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'lw-inc-street-campaign/1.0' } });
            const j: any = await resp.json().catch(() => ({}));
            if (!resp.ok || j.code !== 'Ok') throw new HttpError(502, 'The road-distance service is busy. Try again in a minute.');
            dist = j.distances?.[0]?.slice(1) || [];
            dur = j.durations?.[0]?.slice(1) || [];
          }
          for (const p of chunk) {
            const k = ok.indexOf(p);
            const d = k >= 0 ? dist[k] : null, s = k >= 0 ? dur[k] : null;
            if (d == null) failed++; else updated++;
            await pool.query('UPDATE streets SET road_dist_m = $2, road_time_s = $3, road_from = $4 WHERE id = $1',
              [p.id, d == null ? null : Math.round(d), s == null ? null : Math.round(s), key]);
          }
        }
        const left = await pool.query('SELECT count(*)::int AS n FROM streets WHERE road_from IS DISTINCT FROM $1', [key]);
        return res.json({ updated, failed, remaining: left.rows[0].n });
      }

      // Plan / unplan a street as "Up next"
      if (method === 'PUT' && id && req.url?.includes('/plan')) {
        const planned = !!req.body?.planned;
        const result = await pool.query(
          'UPDATE streets SET planned_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id::text = $1 RETURNING id, planned_at',
          [String(id), planned]
        );
        if (!result.rows[0]) throw new HttpError(404, 'Street not found');
        return res.json(result.rows[0]);
      }

      if (method === 'GET' && !id) {
        const result = await pool.query(`${STREET_SELECT} GROUP BY s.id ORDER BY s.name`);
        return res.json(result.rows);
      }

      // Update stage point and/or street rep
      if (method === 'PUT' && id) {
        const b = req.body || {};
        const sets: string[] = [], vals: unknown[] = [];
        const add = (col: string, v: unknown) => { vals.push(v); sets.push(col + ' = $' + vals.length); };
        if (b.stage !== undefined) {
          add('road_from', null);   // stage moved: recompute road distance
          if (b.stage === null) { add('stage_lat', null); add('stage_lng', null); add('stage_accuracy_m', null); }
          else {
            const lat = Number(b.stage.lat), lng = Number(b.stage.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'Stage location is not valid');
            add('stage_lat', lat); add('stage_lng', lng);
            add('stage_accuracy_m', b.stage.accuracy_m == null ? null : Math.round(Number(b.stage.accuracy_m)) || null);
          }
        }
        if (b.rep_name !== undefined) add('rep_name', String(b.rep_name || '').trim().slice(0, 100) || null);
        if (b.rep_phone !== undefined) add('rep_phone', String(b.rep_phone || '').trim().slice(0, 40) || null);
        if (!sets.length) throw new HttpError(400, 'Nothing to update');
        vals.push(String(id));
        const result = await pool.query('UPDATE streets SET ' + sets.join(', ') + ' WHERE id::text = $' + vals.length + ' RETURNING id', vals);
        if (!result.rows[0]) throw new HttpError(404, 'Street not found');
        const full = await pool.query(STREET_SELECT + ' WHERE s.id::text = $1 GROUP BY s.id', [String(id)]);
        return res.json(full.rows[0]);
      }

      if (method === 'POST' && !id) {
        const { name, district } = req.body || {};
        const latitude = Number(req.body?.latitude);
        const longitude = Number(req.body?.longitude);
        if (!name?.trim() || !district?.trim()) throw new HttpError(400, 'Street name and district are required');
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
          throw new HttpError(400, 'A valid map location is required');
        }

        const geometry = {
          type: 'MultiLineString',
          coordinates: [[[longitude, latitude], [longitude + 0.0001, latitude + 0.0001]]]
        };
        const inserted = await pool.query(
          `INSERT INTO streets (osm_ids, name, district, geometry, length_m)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [[0], name.trim(), district.trim(), JSON.stringify(geometry), 10]
        );
        const result = await pool.query(`${STREET_SELECT} WHERE s.id = $1 GROUP BY s.id`, [inserted.rows[0].id]);
        return res.status(201).json(result.rows[0]);
      }

      if (method === 'POST' && id === 'import') {
        if (auth.role !== 'admin') throw new HttpError(403, 'Only admins can import streets');
        const input = Array.isArray(req.body?.streets) ? req.body.streets.slice(0, 500) : [];
        const isLine = (l: unknown) => Array.isArray(l) && l.length > 1 && l.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
        const rows = input.filter((s: any) =>
          typeof s?.name === 'string' && s.name.trim() && typeof s?.district === 'string' && s.district.trim() &&
          s.geometry?.type === 'MultiLineString' && Array.isArray(s.geometry.coordinates) && s.geometry.coordinates.length && s.geometry.coordinates.every(isLine)
        );

        const existing = await pool.query('SELECT lower(name) AS name, lower(district) AS district FROM streets');
        const seen = new Set(existing.rows.map(r => `${r.name}|${r.district}`));
        const client = await pool.connect();
        let added = 0;
        try {
          await client.query('BEGIN');
          for (const s of rows) {
            const key = `${s.name.trim().toLowerCase()}|${s.district.trim().toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const osmIds = (Array.isArray(s.osm_ids) ? s.osm_ids : []).map(Number).filter(Number.isSafeInteger);
            await client.query(
              'INSERT INTO streets (osm_ids, name, district, geometry, length_m) VALUES ($1, $2, $3, $4, $5)',
              [osmIds, s.name.trim().slice(0, 200), s.district.trim().slice(0, 200), JSON.stringify(s.geometry), Math.max(0, Number(s.length_m) || 0)]
            );
            added++;
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
        return res.status(201).json({ added, skipped: input.length - added });
      }

      if (method === 'DELETE' && id) {
        if (auth.role !== 'admin') throw new HttpError(403, 'Only admins can delete streets');
        await ensureSchema();
        await pool.query('UPDATE converts SET street_id = NULL WHERE street_id = $1', [String(id)]);
        await pool.query('DELETE FROM visits WHERE street_id = $1', [id]);
        const result = await pool.query('DELETE FROM streets WHERE id = $1', [id]);
        if (!result.rowCount) throw new HttpError(404, 'Street not found');
        return res.json({ ok: true });
      }
    }

    // ---- Field collectors (name + phone, no password) ----
    if (resource === 'collect' && id === 'join' && method === 'POST') {
      if (!JWT_SECRET) throw new HttpError(500, 'Server misconfigured: JWT_SECRET is not set');
      await ensureSchema();
      const name = String(req.body?.name || '').trim().slice(0, 100);
      const phone = String(req.body?.phone || '').replace(/[^\d+]/g, '').slice(0, 20);
      if (name.length < 2) throw new HttpError(400, 'Please enter your full name');
      if (phone.replace(/\D/g, '').length < 9) throw new HttpError(400, 'Please enter a valid phone number');
      const result = await pool.query(
        `INSERT INTO collectors (name, phone) VALUES ($1, $2)
         ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, last_seen_at = now()
         RETURNING id, name, phone`,
        [name, phone]
      );
      const c = result.rows[0];
      const token = jwt.sign({ userId: c.id, role: 'collector', name: c.name, phone: c.phone }, JWT_SECRET, { expiresIn: '365d' });
      return res.json({ token, collector: c });
    }

    if (resource === 'collect' && id === 'streets' && method === 'GET') {
      requireAuth(req, ['admin', 'collector']);
      const result = await pool.query('SELECT id, name, district FROM streets ORDER BY name');
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.json(result.rows);
    }

    if (resource === 'collect' && id === 'mine' && method === 'GET') {
      const auth = requireAuth(req, ['collector']);
      await ensureSchema();
      const result = await pool.query(
        `SELECT c.id, c.client_id, c.full_name, c.age, c.phone, c.location, c.latitude, c.longitude, c.decision_date, c.created_at,
                s.name AS street_name
         FROM converts c LEFT JOIN streets s ON s.id::text = c.street_id
         WHERE c.created_by = $1 ORDER BY c.created_at DESC LIMIT 200`,
        [String(auth.userId)]
      );
      return res.json(result.rows);
    }

    // ---- Public map config (Mapbox public token is safe to expose; restrict it by URL in your Mapbox account) ----
    if (resource === 'config' && method === 'GET') {
      let saved: Record<string, unknown> = {};
      try {
        const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key = 'mapbox_style'`);
        saved = Object.fromEntries(rows.map(r => [r.key, r.value]));
      } catch { /* table not created yet */ }
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        mapbox_token: process.env.MAPBOX_TOKEN || '',
        mapbox_style: process.env.MAPBOX_STYLE || saved.mapbox_style || '',
        google_maps_key: process.env.GOOGLE_MAPS_KEY || ''
      });
    }


    // ---- Public read-only overview (needs the secret link key; totals only, no personal details) ----
    if (resource === 'overview' && method === 'GET') {
      await ensureSchema();
      const key = String(req.query?.k || '');
      const saved = await pool.query(`SELECT value FROM app_settings WHERE key = 'overview_key'`);
      const want = saved.rows[0]?.value ? String(saved.rows[0].value) : '';
      const ok = !!want && key.length === want.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(want));
      if (!ok) throw new HttpError(401, 'This overview link is not valid. Ask the admin for a new link.');

      const streetsRes = await pool.query(`${STREET_SELECT} GROUP BY s.id ORDER BY s.name`);
      const convRes = await pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE came_sunday)::int AS sun, count(*) FILTER (WHERE came_saturday)::int AS sat,
                                               count(*) FILTER (WHERE followed_up_at IS NOT NULL)::int AS followed FROM converts`);
      const centerRes = await pool.query(`SELECT value FROM app_settings WHERE key = 'center'`);

      const point = (s: any): [number, number] | null => {
        if (s.stage_lat != null && s.stage_lng != null) return [Number(s.stage_lat), Number(s.stage_lng)];
        const line = s.geometry?.coordinates?.[0];
        if (!line?.length) return null;
        const [lng, lat] = line[Math.floor(line.length / 2)];
        return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
      };
      let visited = 0, people = 0, converts = 0, outreaches = 0, sun = 0, sunOf = 0, sat = 0, satOf = 0;
      const districts: Record<string, { streets: number; visited: number; converts: number }> = {};
      const recent: any[] = [];
      const streets = streetsRes.rows.map((s: any) => {
        const v = Array.isArray(s.visits) ? s.visits : [];
        const sumConv = v.reduce((a: number, x: any) => a + (Number(x.decisions) || 0), 0);
        if (v.length) visited++;
        people += v.reduce((a: number, x: any) => a + (Number(x.attendance) || 0), 0);
        converts += sumConv;
        outreaches += v.length;
        const d = (districts[s.district] ||= { streets: 0, visited: 0, converts: 0 });
        d.streets++; if (v.length) d.visited++; d.converts += sumConv;
        for (const x of v) {
          const n = Number(x.decisions) || 0;
          if (n && x.sunday_count != null) { sun += x.sunday_count; sunOf += n; }
          if (n && x.saturday_count != null) { sat += x.saturday_count; satOf += n; }
          recent.push({ street: s.name, district: s.district, date: String(x.visit_date).slice(0, 10), reached: Number(x.attendance) || 0,
                        converts: n, sunday: x.sunday_count, saturday: x.saturday_count });
        }
        return { id: String(s.id), name: s.name, district: s.district, point: point(s), visited: v.length > 0,
                 planned: !!s.planned_at, planned_at: s.planned_at, last_visit: v[0] ? String(v[0].visit_date).slice(0, 10) : null,
                 visits: v.length, converts: sumConv, rep: s.rep_name || null,
                 road_dist_m: s.road_dist_m ?? null, road_time_s: s.road_time_s ?? null,
                 line: (s.geometry?.coordinates || []).filter((l: any) => Array.isArray(l) && l.length > 1) };
      });
      recent.sort((a, b) => b.date.localeCompare(a.date));
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        generated_at: new Date().toISOString(),
        center: centerRes.rows[0]?.value || null,
        totals: { streets: streets.length, visited, people, converts, outreaches, converts_recorded: convRes.rows[0].n, followed_up: convRes.rows[0].followed },
        retention: { sunday: sun, sunday_of: sunOf, saturday: sat, saturday_of: satOf },
        districts: Object.entries(districts).map(([name, d]) => ({ name, ...d })).sort((a, b) => b.streets - a.streets),
        up_next: streets.filter(s => s.planned).sort((a, b) => String(a.planned_at).localeCompare(String(b.planned_at))).map(s => ({ name: s.name, district: s.district, rep: s.rep })),
        recent: recent.slice(0, 12),
        streets
      });
    }

    // ---- App settings (admin) ----
    if (resource === 'settings') {
      requireAuth(req);
      await ensureSchema();
      if (method === 'GET') {
        const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key <> 'mapbox_token'`);
        return res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
      }
      if (method === 'PUT') {
        const b = req.body || {};
        const out: Record<string, unknown> = {};
        if (b.center !== undefined) {
          const lat = Number(b.center?.lat), lng = Number(b.center?.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'Centre coordinates are not valid');
          out.center = { lat, lng, name: String(b.center?.name || 'Qodesh').slice(0, 60) };
        }
        for (const k of ['zone1_m', 'zone2_m']) {
          if (b[k] === undefined) continue;
          const v = Math.round(Number(b[k]));
          if (!Number.isFinite(v) || v < 100 || v > 20000) throw new HttpError(400, 'Zone sizes must be between 100 m and 20 km');
          out[k] = v;
        }
        if (b.overview_key === 'new') out.overview_key = crypto.randomBytes(18).toString('base64url');
        if (b.mapbox_style !== undefined) {
          const st = String(b.mapbox_style || '').trim();
          if (st && !/^mapbox:\/\/styles\/[\w.-]+\/[\w-]+$/.test(st)) throw new HttpError(400, 'Style URL should look like mapbox://styles/yourname/styleid');
          out.mapbox_style = st;
        }
        for (const [k, v] of Object.entries(out)) {
          await pool.query(
            `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [k, JSON.stringify(v)]
          );
        }
        const { rows } = await pool.query('SELECT key, value FROM app_settings');
        return res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
      }
    }

    if (resource === 'collectors' && method === 'GET') {
      requireAuth(req);
      await ensureSchema();
      const result = await pool.query(
        `SELECT k.id, k.name, k.phone, k.created_at, k.last_seen_at, count(c.id)::int AS converts
         FROM collectors k LEFT JOIN converts c ON c.created_by = k.id::text
         GROUP BY k.id ORDER BY k.last_seen_at DESC`
      );
      return res.json(result.rows);
    }

    // ---- Converts ----
    if (resource === 'converts') {
      const auth = requireAuth(req, method === 'POST' && !id ? ['admin', 'collector'] : ['admin']);
      await ensureSchema();

      if (method === 'GET' && !id) {
        const result = await pool.query(
          `SELECT c.*, s.name AS street_name, s.district AS street_district
           FROM converts c LEFT JOIN streets s ON s.id::text = c.street_id
           ORDER BY c.decision_date DESC, c.created_at DESC`
        );
        return res.json(result.rows);
      }

      if ((method === 'POST' && !id) || (method === 'PUT' && id)) {
        const b = req.body || {};
        const clientId = b.client_id ? String(b.client_id).slice(0, 64) : null;
        if (method === 'POST' && clientId) {
          const dup = await pool.query('SELECT * FROM converts WHERE client_id = $1', [clientId]);
          if (dup.rows[0]) return res.status(200).json(dup.rows[0]); // already received (offline retry)
        }
        const fullName = String(b.full_name || '').trim().slice(0, 200);
        if (!fullName) throw new HttpError(400, 'Full name is required');
        const age = b.age === '' || b.age == null ? null : Number.parseInt(String(b.age), 10);
        if (age !== null && (!Number.isFinite(age) || age < 0 || age > 120)) throw new HttpError(400, 'Age must be between 0 and 120');
        const lat = b.latitude == null || b.latitude === '' ? null : Number(b.latitude);
        const lng = b.longitude == null || b.longitude === '' ? null : Number(b.longitude);
        if ((lat === null) !== (lng === null)) throw new HttpError(400, 'Give both latitude and longitude, or neither');
        if (lat !== null && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng as number) > 180)) {
          throw new HttpError(400, 'Coordinates are not valid');
        }
        const date = (v: unknown) => (v && !Number.isNaN(Date.parse(String(v))) ? String(v).slice(0, 10) : null);
        const values = [
          b.street_id ? String(b.street_id) : null,
          fullName,
          age,
          String(b.phone || '').trim().slice(0, 40),
          String(b.location || '').trim().slice(0, 500),
          lat,
          lng,
          b.accuracy_m == null || b.accuracy_m === '' ? null : Math.round(Number(b.accuracy_m)) || null,
          String(b.notes || '').trim().slice(0, 2000),
          date(b.decision_date) || new Date().toISOString().slice(0, 10),
          date(b.followed_up_at)
        ];
        const result = method === 'POST'
          ? await pool.query(
              `INSERT INTO converts (street_id, full_name, age, phone, location, latitude, longitude, accuracy_m, notes, decision_date, followed_up_at,
                                     created_by, collector_name, collector_phone, client_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               ON CONFLICT (client_id) DO UPDATE SET client_id = EXCLUDED.client_id
               RETURNING *`,
              [...values, String(auth.userId), auth.role === 'collector' ? auth.name : 'Admin', auth.role === 'collector' ? auth.phone : null, clientId]
            )
          : await pool.query(
              `UPDATE converts SET street_id=$1, full_name=$2, age=$3, phone=$4, location=$5, latitude=$6, longitude=$7,
                 accuracy_m=$8, notes=$9, decision_date=$10, followed_up_at=$11
               WHERE id = $12 RETURNING *`,
              [...values, id]
            );
        if (!result.rows[0]) throw new HttpError(404, 'Convert not found');
        return res.status(method === 'POST' ? 201 : 200).json(result.rows[0]);
      }

      if (method === 'DELETE' && id) {
        const result = await pool.query('DELETE FROM converts WHERE id = $1', [id]);
        if (!result.rowCount) throw new HttpError(404, 'Convert not found');
        return res.json({ ok: true });
      }
    }

    // ---- Visits ----
    if (resource === 'visits') {
      const auth = requireAuth(req);
      await ensureSchema();

      // Retention: how many converts from this outreach came to church afterwards
      if (method === 'PUT' && id && req.url?.includes('/retention')) {
        const b = req.body || {};
        const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : toCount(v));
        const result = await pool.query(
          'UPDATE visits SET sunday_count = $2, saturday_count = $3 WHERE id::text = $1 RETURNING id, sunday_count, saturday_count',
          [String(id), num(b.sunday_count), num(b.saturday_count)]
        );
        if (!result.rows[0]) throw new HttpError(404, 'Outreach not found');
        for (const m of Array.isArray(b.marks) ? b.marks.slice(0, 500) : []) {
          await pool.query('UPDATE converts SET came_sunday = $2, came_saturday = $3 WHERE id::text = $1', [String(m.id), !!m.came_sunday, !!m.came_saturday]);
        }
        return res.json(result.rows[0]);
      }

      if (method === 'POST' && !id) {
        const { street_id, visit_date, team_members, notes } = req.body || {};
        if (!street_id || !visit_date) throw new HttpError(400, 'Street and visit date are required');
        if (Number.isNaN(Date.parse(visit_date))) throw new HttpError(400, 'Invalid visit date');

        const members = Array.isArray(team_members)
          ? team_members.map((m: unknown) => String(m).trim()).filter(Boolean).slice(0, 50)
          : [];

        const result = await pool.query(
          `INSERT INTO visits (street_id, visit_date, team_members, attendance, decisions, follow_ups, notes, photo_urls, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            street_id,
            visit_date,
            members,
            toCount(req.body?.attendance),
            toCount(req.body?.decisions),
            toCount(req.body?.follow_ups),
            String(notes || '').slice(0, 2000),
            [],
            auth.userId
          ]
        );
        await pool.query('UPDATE streets SET planned_at = NULL WHERE id = $1', [street_id]).catch(() => {});
        return res.status(201).json(result.rows[0]);
      }

      if (method === 'DELETE' && id) {
        const result = await pool.query(
          auth.role === 'admin'
            ? 'DELETE FROM visits WHERE id = $1'
            : 'DELETE FROM visits WHERE id = $1 AND created_by = $2',
          auth.role === 'admin' ? [id] : [id, auth.userId]
        );
        if (!result.rowCount) throw new HttpError(404, 'Visit not found or you cannot delete it');
        return res.json({ ok: true });
      }
    }

    throw new HttpError(404, 'Not found');
  } catch (error: any) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('API error:', error);
    return res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  }
}
