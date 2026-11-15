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
    return jwt.verify(token, JWT_SECRET) as AuthUser;
  } catch {
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }
}

function toCount(value: unknown): number {
  const n = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 0;
}

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

      const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, {
        expiresIn: '30d'
      });
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
