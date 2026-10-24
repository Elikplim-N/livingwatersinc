import express from 'express';
import { query } from '../db.js';
import { authenticateToken, requireAdmin, type AuthRequest } from '../middleware/auth.js';

const router = express.Router();

// Get all planned streets
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT ps.*, s.name as street_name, s.district
      FROM planned_streets ps
      JOIN streets s ON ps.street_id = s.id
      ORDER BY ps.target_date ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching planned streets:', error);
    res.status(500).json({ message: 'Failed to fetch planned streets' });
  }
});

// Create planned street (admin only)
router.post('/', authenticateToken, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { street_id, target_date } = req.body;

    if (!street_id || !target_date) {
      return res.status(400).json({ message: 'street_id and target_date are required' });
    }

    const result = await query(
      `INSERT INTO planned_streets (street_id, target_date, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (street_id) DO UPDATE
       SET target_date = $2, created_by = $3
       RETURNING *`,
      [street_id, target_date, req.userId]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating planned street:', error);
    res.status(500).json({ message: 'Failed to create planned street' });
  }
});

// Delete planned street (admin only)
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query('DELETE FROM planned_streets WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Planned street not found' });
    }

    res.json({ message: 'Planned street deleted successfully' });
  } catch (error) {
    console.error('Error deleting planned street:', error);
    res.status(500).json({ message: 'Failed to delete planned street' });
  }
});

export default router;
