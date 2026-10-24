import express from 'express';
import { query } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Get all streets with visits and planned status
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT
        s.*,
        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object(
              'id', v.id,
              'street_id', v.street_id,
              'visit_date', v.visit_date,
              'team_members', v.team_members,
              'attendance', v.attendance,
              'decisions', v.decisions,
              'follow_ups', v.follow_ups,
              'notes', v.notes,
              'photo_urls', v.photo_urls,
              'created_by', v.created_by,
              'created_at', v.created_at
            )
          ) FILTER (WHERE v.id IS NOT NULL),
          '[]'
        ) as visits,
        jsonb_build_object(
          'id', ps.id,
          'target_date', ps.target_date,
          'created_by', ps.created_by
        ) as planned
      FROM streets s
      LEFT JOIN visits v ON s.id = v.street_id
      LEFT JOIN planned_streets ps ON s.id = ps.street_id
      GROUP BY s.id, ps.id, ps.target_date, ps.created_by
      ORDER BY s.name
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching streets:', error);
    res.status(500).json({ message: 'Failed to fetch streets' });
  }
});

// Get single street
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(`
      SELECT
        s.*,
        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object(
              'id', v.id,
              'street_id', v.street_id,
              'visit_date', v.visit_date,
              'team_members', v.team_members,
              'attendance', v.attendance,
              'decisions', v.decisions,
              'follow_ups', v.follow_ups,
              'notes', v.notes,
              'photo_urls', v.photo_urls,
              'created_by', v.created_by,
              'created_at', v.created_at
            )
          ) FILTER (WHERE v.id IS NOT NULL),
          '[]'
        ) as visits,
        jsonb_build_object(
          'id', ps.id,
          'target_date', ps.target_date,
          'created_by', ps.created_by
        ) as planned
      FROM streets s
      LEFT JOIN visits v ON s.id = v.street_id
      LEFT JOIN planned_streets ps ON s.id = ps.street_id
      WHERE s.id = $1
      GROUP BY s.id, ps.id, ps.target_date, ps.created_by
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Street not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching street:', error);
    res.status(500).json({ message: 'Failed to fetch street' });
  }
});

export default router;
