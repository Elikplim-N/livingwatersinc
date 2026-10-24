import express from 'express';
import { query } from '../db.js';
import { authenticateToken, requireAdmin, type AuthRequest } from '../middleware/auth.js';

const router = express.Router();

// Get all visits
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT v.*, s.name as street_name, s.district
      FROM visits v
      JOIN streets s ON v.street_id = s.id
      ORDER BY v.visit_date DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching visits:', error);
    res.status(500).json({ message: 'Failed to fetch visits' });
  }
});

// Create visit
router.post('/', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const {
      street_id,
      visit_date,
      team_members,
      attendance,
      decisions,
      follow_ups,
      notes,
      photo_urls,
    } = req.body;

    if (!street_id || !visit_date) {
      return res.status(400).json({ message: 'street_id and visit_date are required' });
    }

    const result = await query(
      `INSERT INTO visits (
        street_id, visit_date, team_members, attendance, decisions,
        follow_ups, notes, photo_urls, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        street_id,
        visit_date,
        team_members || [],
        attendance || 0,
        decisions || 0,
        follow_ups || 0,
        notes || null,
        photo_urls || [],
        req.userId,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating visit:', error);
    res.status(500).json({ message: 'Failed to create visit' });
  }
});

// Update visit (admin only)
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      visit_date,
      team_members,
      attendance,
      decisions,
      follow_ups,
      notes,
      photo_urls,
    } = req.body;

    const result = await query(
      `UPDATE visits
      SET visit_date = COALESCE($1, visit_date),
          team_members = COALESCE($2, team_members),
          attendance = COALESCE($3, attendance),
          decisions = COALESCE($4, decisions),
          follow_ups = COALESCE($5, follow_ups),
          notes = COALESCE($6, notes),
          photo_urls = COALESCE($7, photo_urls),
          updated_at = NOW()
      WHERE id = $8
      RETURNING *`,
      [visit_date, team_members, attendance, decisions, follow_ups, notes, photo_urls, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Visit not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating visit:', error);
    res.status(500).json({ message: 'Failed to update visit' });
  }
});

// Delete visit (admin only)
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query('DELETE FROM visits WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Visit not found' });
    }

    res.json({ message: 'Visit deleted successfully' });
  } catch (error) {
    console.error('Error deleting visit:', error);
    res.status(500).json({ message: 'Failed to delete visit' });
  }
});

export default router;
