// Creates the tables (db/schema.sql) and an admin/member account.
// Usage:
//   DATABASE_URL=postgres://... node scripts/db-setup.mjs
//   DATABASE_URL=postgres://... node scripts/db-setup.mjs you@example.com "Your Name" yourpassword [admin|member]
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import bcrypt from 'bcryptjs';

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL first.');
  process.exit(1);
}

const [email, fullName, password, role = 'admin'] = process.argv.slice(2);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await client.query(schema);
  console.log('✔ Schema ready');

  if (email && password) {
    const existing = await client.query('SELECT user_id FROM auth_credentials WHERE lower(email) = lower($1)', [email]);
    const hash = await bcrypt.hash(password, 10);
    if (existing.rows[0]) {
      await client.query('UPDATE auth_credentials SET password_hash = $1 WHERE user_id = $2', [hash, existing.rows[0].user_id]);
      await client.query('UPDATE profiles SET full_name = $1, role = $2 WHERE id = $3', [fullName || email, role, existing.rows[0].user_id]);
      console.log(`✔ Updated user ${email} (${role})`);
    } else {
      const profile = await client.query('INSERT INTO profiles (full_name, role) VALUES ($1, $2) RETURNING id', [fullName || email, role]);
      await client.query('INSERT INTO auth_credentials (user_id, email, password_hash) VALUES ($1, $2, $3)', [profile.rows[0].id, email, hash]);
      console.log(`✔ Created user ${email} (${role})`);
    }
  } else {
    console.log('ℹ No user created. Pass: <email> "<full name>" <password> [admin|member]');
  }
} finally {
  await client.end();
}
