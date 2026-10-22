import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RESET = /^(1|true|yes|on)$/i.test(process.env.DB_RESET || '');

export async function migrate() {
  const sql = await readFile(join(__dirname, 'schema.sql'), 'utf8');
  // Run the whole schema in one transaction. PostgreSQL's simple-query protocol
  // otherwise auto-commits each statement, so a mid-way failure would leave a
  // half-applied, inconsistent schema that later runs can't recover from.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (RESET) {
      // One-shot recovery for a database left in a broken/inconsistent state
      // (e.g. a half-applied migration from an older build). Drops every table
      // in the public schema, then recreates it from scratch. DESTRUCTIVE —
      // intended to be enabled via DB_RESET=true for a single deploy and then
      // removed. No-op safety: wrapped in the same transaction as the rebuild.
      console.warn('[migrate] DB_RESET=true — dropping and recreating the public schema');
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');
    }
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`[migrate] schema applied${RESET ? ' (after reset)' : ''}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Run directly: `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] failed', err);
      process.exit(1);
    });
}
