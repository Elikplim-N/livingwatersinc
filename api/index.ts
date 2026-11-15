import { VercelRequest, VercelResponse } from '@vercel/node';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3
});

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret');

interface AuthUser {
  userId: string;
  email: string;
  role: string;
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

function requireAuth(req: VercelRequest): AuthUser {
  if (!JWT_SECRET) throw new HttpError(500, 'Server misconfigured: JWT_SECRET is not set');
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Please sign in');
  try {
    const auth = jwt.verify(token, JWT_SECRET) as AuthUser;
    if (auth.role === 'admin') return auth;
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
    s.id, s.name, s.district, s.geometry, s.length_m,
    COALESCE(
      json_agg(
        json_build_object(
          'id', v.id,
          'visit_date', v.visit_date,
          'team_members', v.team_members,
          'attendance', v.attendance,
          'decisions', v.decisions,
          'follow_ups', v.follow_ups,
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
        await client.query('TRUNCATE visits, streets, auth_credentials, profiles RESTART IDENTITY CASCADE');
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
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const v = await client.query('DELETE FROM visits');
        const s = await client.query('DELETE FROM streets');
        await client.query('DELETE FROM auth_credentials WHERE user_id <> $1', [auth.userId]);
        const a = await client.query('DELETE FROM profiles WHERE id <> $1', [auth.userId]);
        await client.query(`UPDATE profiles SET role = 'admin' WHERE id = $1`, [auth.userId]);
        await client.query('COMMIT');
        return res.json({ visits: v.rowCount, streets: s.rowCount, accounts: a.rowCount });
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

      if (method === 'GET' && !id) {
        const result = await pool.query(`${STREET_SELECT} GROUP BY s.id ORDER BY s.name`);
        return res.json(result.rows);
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
        await pool.query('DELETE FROM visits WHERE street_id = $1', [id]);
        const result = await pool.query('DELETE FROM streets WHERE id = $1', [id]);
        if (!result.rowCount) throw new HttpError(404, 'Street not found');
        return res.json({ ok: true });
      }
    }

    // ---- Visits ----
    if (resource === 'visits') {
      const auth = requireAuth(req);

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
