import express from 'express';
import { query } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Get all areas (districts)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT id, name, ST_AsGeoJSON(geometry) as geometry, created_at
      FROM areas
      ORDER BY name
    `);

    const areas = result.rows.map(row => ({
      ...row,
      geometry: JSON.parse(row.geometry),
    }));

    res.json(areas);
  } catch (error) {
    console.error('Error fetching areas:', error);
    res.status(500).json({ message: 'Failed to fetch areas' });
  }
});

export default router;
