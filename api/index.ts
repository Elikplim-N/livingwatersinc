import { VercelRequest, VercelResponse } from '@vercel/node';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

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
  let auth: AuthUser & { otp?: boolean };
  try {
    auth = jwt.verify(token, JWT_SECRET) as AuthUser & { otp?: boolean };
  } catch {
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }
  // Only admins who completed the email code step may use the app
  if (auth.role !== 'admin' || !auth.otp) throw new HttpError(401, 'Please sign in again.');
  return auth;
}

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL = '12h';

const hashCode = (code: string) => crypto.createHmac('sha256', JWT_SECRET).update(code).digest('hex');

function maskEmail(email: string) {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}${'•'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

let otpTableReady = false;
async function ensureOtpTable() {
  if (otpTableReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS login_otps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    code_hash text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  otpTableReady = true;
}

async function sendOtpEmail(to: string, name: string, code: string) {
  const { SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_USER || !SMTP_PASS) {
    if (IS_PROD) throw new HttpError(500, 'Email is not set up on the server (SMTP_USER / SMTP_PASS).');
    console.log(`[dev] Login code for ${to}: ${code}`);
    return;
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  await transport.sendMail({
    from: process.env.MAIL_FROM || `LWI Street Tracker <${SMTP_USER}>`,
    to,
    subject: `${code} is your LWI Street Tracker login code`,
    text: `Hi ${name},\n\nYour login code is ${code}\n\nIt expires in ${OTP_TTL_MIN} minutes. If you did not try to sign in, change your password.\n`,
    html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px">
      <h2 style="margin:0 0 8px">LWI Street Tracker</h2>
      <p>Hi ${name.replace(/[<>&]/g, '')}, use this code to sign in:</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f4f4f5;padding:16px;text-align:center;border-radius:12px">${code}</p>
      <p style="color:#71717a;font-size:13px">It expires in ${OTP_TTL_MIN} minutes. If you did not try to sign in, change your password.</p>
    </div>`
  });
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
      if (user.role !== 'admin') throw new HttpError(403, 'Only admins can use this app.');

      await ensureOtpTable();
      const recent = await pool.query(
        `SELECT 1 FROM login_otps WHERE user_id = $1 AND created_at > now() - interval '30 seconds'`,
        [String(user.id)]
      );
      if (recent.rows.length) throw new HttpError(429, 'A code was just sent. Wait 30 seconds before asking for another.');

      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      await pool.query('DELETE FROM login_otps WHERE user_id = $1 OR expires_at < now()', [String(user.id)]);
      const otp = await pool.query(
        `INSERT INTO login_otps (user_id, code_hash, expires_at)
         VALUES ($1, $2, now() + interval '${OTP_TTL_MIN} minutes') RETURNING id`,
        [String(user.id), hashCode(code)]
      );
      try {
        await sendOtpEmail(user.email, user.full_name || 'there', code);
      } catch (err) {
        await pool.query('DELETE FROM login_otps WHERE id = $1', [otp.rows[0].id]);
        if (err instanceof HttpError) throw err;
        console.error('Email send failed:', err);
        throw new HttpError(502, 'Could not send the login code email. Please try again.');
      }
      return res.json({ otp_required: true, challenge: otp.rows[0].id, email_hint: maskEmail(user.email) });
    }

    if (resource === 'auth' && id === 'verify' && method === 'POST') {
      if (!JWT_SECRET) throw new HttpError(500, 'Server misconfigured: JWT_SECRET is not set');
      const challenge = String(req.body?.challenge || '');
      const code = String(req.body?.code || '').replace(/\D/g, '');
      if (!/^[0-9a-f-]{36}$/i.test(challenge) || code.length !== 6) throw new HttpError(400, 'Enter the 6-digit code from your email');

      await ensureOtpTable();
      const found = await pool.query(
        `UPDATE login_otps SET attempts = attempts + 1
         WHERE id = $1 AND expires_at > now() AND attempts < $2
         RETURNING user_id, code_hash`,
        [challenge, OTP_MAX_ATTEMPTS]
      );
      const row = found.rows[0];
      if (!row) throw new HttpError(401, 'This code has expired or had too many wrong tries. Sign in again to get a new one.');
      const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hashCode(code)));
      if (!ok) throw new HttpError(400, 'That code is not correct. Check the email and try again.');

      await pool.query('DELETE FROM login_otps WHERE id = $1', [challenge]);
      const result = await pool.query(
        `SELECT p.id, ac.email, p.full_name, p.role
         FROM profiles p JOIN auth_credentials ac ON ac.user_id = p.id WHERE p.id = $1`,
        [row.user_id]
      );
      const user = result.rows[0];
      if (!user || user.role !== 'admin') throw new HttpError(403, 'Only admins can use this app.');

      const token = jwt.sign({ userId: user.id, email: user.email, role: user.role, otp: true }, JWT_SECRET, {
        expiresIn: SESSION_TTL
      });
      return res.json({ token, user });
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
