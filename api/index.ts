import { VercelRequest, VercelResponse } from '@vercel/node';
import pg from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// CORS headers
function setCORS(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Get the path from the URL
  const url = req.url || '';
  const path = url.split('?')[0]; // Remove query string
  
  try {
    // Health check
    if (path === '/health' || path === '/api/health' || path === '/') {
      return res.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // Auth routes
    if (path === '/api/auth/login' || path === '/auth/login') {
      const { email, password } = req.body;
      
      const result = await pool.query(
        'SELECT p.*, ac.password_hash FROM profiles p JOIN auth_credentials ac ON p.id = ac.user_id WHERE p.email = $1',
        [email]
      );
      
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      const user = result.rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      const token = jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: '30d' }
      );
      
      return res.json({
        token,
        user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role }
      });
    }

    // Get streets
    if ((path === '/api/streets' || path === '/streets') && req.method === 'GET') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return res.status(403).json({ error: 'Access token required' });
      }
      
      try {
        jwt.verify(token, process.env.JWT_SECRET || 'secret');
      } catch {
        return res.status(403).json({ error: 'Invalid token' });
      }
      
      const result = await pool.query(`
        SELECT 
          s.*,
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
              ) ORDER BY v.visit_date DESC
            ) FILTER (WHERE v.id IS NOT NULL),
            '[]'
          ) as visits,
          false as planned
        FROM streets s
        LEFT JOIN visits v ON s.id = v.street_id
        GROUP BY s.id
        ORDER BY s.name
      `);
      
      return res.json(result.rows);
    }

    // Add street
    if ((path === '/api/streets' || path === '/streets') && req.method === 'POST') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return res.status(403).json({ error: 'Access token required' });
      }
      
      try {
        jwt.verify(token, process.env.JWT_SECRET || 'secret');
      } catch {
        return res.status(403).json({ error: 'Invalid token' });
      }
      
      const { name, district, latitude, longitude } = req.body;
      
      if (!name || !district || !latitude || !longitude) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const geometry = {
        type: 'MultiLineString',
        coordinates: [[
          [longitude, latitude],
          [longitude + 0.0001, latitude + 0.0001]
        ]]
      };

      const result = await pool.query(`
        INSERT INTO streets (osm_ids, name, district, geometry, length_m)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [
        [0],
        name,
        district,
        JSON.stringify(geometry),
        10
      ]);

      return res.status(201).json(result.rows[0]);
    }

    // Add visit
    if ((path === '/api/visits' || path === '/visits') && req.method === 'POST') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return res.status(403).json({ error: 'Access token required' });
      }
      
      let userId;
      try {
        const decoded: any = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        userId = decoded.userId;
      } catch {
        return res.status(403).json({ error: 'Invalid token' });
      }
      
      const { street_id, visit_date, team_members, attendance, decisions, follow_ups, notes, photo_urls } = req.body;
      
      const result = await pool.query(`
        INSERT INTO visits (street_id, visit_date, team_members, attendance, decisions, follow_ups, notes, photo_urls, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [
        street_id,
        visit_date,
        team_members || [],
        attendance || 0,
        decisions || 0,
        follow_ups || 0,
        notes || '',
        photo_urls || [],
        userId
      ]);

      return res.status(201).json(result.rows[0]);
    }

    res.status(404).json({ error: 'Not found' });
  } catch (error: any) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
