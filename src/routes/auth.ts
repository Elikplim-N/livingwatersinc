import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';

const router = express.Router();

// Signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Check if user exists
    const existing = await query(
      'SELECT id FROM profiles WHERE id IN (SELECT id FROM auth.users WHERE email = $1)',
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user (simplified - in production you'd use proper auth tables)
    const userId = crypto.randomUUID();

    await query(
      'INSERT INTO profiles (id, full_name, role) VALUES ($1, $2, $3)',
      [userId, full_name, 'member']
    );

    // Store credentials (simplified)
    await query(
      'CREATE TABLE IF NOT EXISTS auth_credentials (user_id UUID PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT)',
      []
    );

    await query(
      'INSERT INTO auth_credentials (user_id, email, password_hash) VALUES ($1, $2, $3)',
      [userId, email, hashedPassword]
    );

    // Generate token
    const token = jwt.sign(
      { id: userId, role: 'member' },
      process.env.JWT_SECRET!,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: { id: userId, email, full_name, role: 'member' },
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ message: 'Signup failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' });
    }

    // Get user
    const result = await query(
      `SELECT ac.user_id, ac.email, ac.password_hash, p.full_name, p.role
       FROM auth_credentials ac
       JOIN profiles p ON ac.user_id = p.id
       WHERE ac.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate token
    const token = jwt.sign(
      { id: user.user_id, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user.user_id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Login failed' });
  }
});

export default router;
