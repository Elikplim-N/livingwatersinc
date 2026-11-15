// Wipes all app data and leaves exactly ONE admin login with full control.
//
//   DATABASE_URL="postgresql://..." node scripts/reset-db.mjs <email> "<full name>" <password>          (preview only)
//   DATABASE_URL="postgresql://..." node scripts/reset-db.mjs <email> "<full name>" <password> --yes    (do it)
//
// Steps: create any missing tables (db/schema.sql) → delete all visits, streets and user accounts
// → create the single admin account.
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const [email, fullName, password] = args.filter(a => a !== '--yes');

if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
if (!email || !fullName || !password) {
  console.error('Usage: node scripts/reset-db.mjs <email> "<full name>" <password> [--yes]');
  process.exit(1);
}
if (password.length < 8) { console.error('Use a password of at least 8 characters.'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await client.query(schema);
  console.log('✔ Tables ready (profiles, auth_credentials, streets, visits)');

  const tables = ['visits', 'streets', 'auth_credentials', 'profiles'];
  console.log('\nCurrent data:');
  for (const t of tables) {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
    console.log(`  ${t.padEnd(17)} ${rows[0].n} rows`);
  }

  if (!confirmed) {
    console.log(`\nPreview only. Nothing was deleted.\nRe-run with --yes to delete ALL of the above and keep one admin: ${email}`);
    process.exit(0);
  }

  await client.query('BEGIN');
  await client.query('TRUNCATE visits, streets, auth_credentials, profiles RESTART IDENTITY CASCADE');
  const profile = await client.query(
    "INSERT INTO profiles (full_name, role) VALUES ($1, 'admin') RETURNING id",
    [fullName]
  );
  await client.query(
    'INSERT INTO auth_credentials (user_id, email, password_hash) VALUES ($1, $2, $3)',
    [profile.rows[0].id, email.trim(), await bcrypt.hash(password, 10)]
  );
  await client.query('COMMIT');

  console.log('\n✔ All streets, visits and old accounts deleted');
  console.log(`✔ Admin account ready: ${email} (full control)`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('\n✖ Failed, nothing was changed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
