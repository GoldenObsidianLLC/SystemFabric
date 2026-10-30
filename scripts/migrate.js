'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnvFile } = require('./load-env');
const { createPostgresPool } = require('../packages/db/src/postgres-store');
const { normalizeMigrationSql, migrationChecksum } = require('./migration-checksum');

const MIGRATION_DIR = path.resolve(__dirname, '../database/migrations');
const LOCK_KEY_A = 57_493_100;
const LOCK_KEY_B = 1;

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set before running migrations.');
  const files = fs.readdirSync(MIGRATION_DIR).filter(file => /^\d+_[a-z0-9_-]+\.sql$/i.test(file)).sort();
  if (files.length === 0) throw new Error(`No SQL migrations found in ${MIGRATION_DIR}.`);
  const pool = createPostgresPool(process.env);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [LOCK_KEY_A, LOCK_KEY_B]);
    await client.query(`CREATE TABLE IF NOT EXISTS systemfabric_schema_migrations (
      version text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const file of files) {
      const rawSql = fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8');
      const sql = normalizeMigrationSql(rawSql);
      const sha256 = migrationChecksum(rawSql);
      const existing = await client.query('SELECT sha256 FROM systemfabric_schema_migrations WHERE version=$1', [file]);
      if (existing.rows[0]) {
        if (existing.rows[0].sha256 !== sha256) throw new Error(`Applied migration ${file} has changed. Create a new forward migration instead of editing an applied migration.`);
        console.log(`SKIP ${file} (already applied)`);
        continue;
      }
      console.log(`APPLY ${file}`);
      await client.query('BEGIN');
      try {
        // Migration files are trusted repository code and are deliberately executed without user-supplied SQL parameters.
        await client.query(sql);
        await client.query('INSERT INTO systemfabric_schema_migrations(version,sha256) VALUES($1,$2)', [file, sha256]);
        await client.query('COMMIT');
        console.log(`OK   ${file}`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw Object.assign(new Error(`Migration ${file} failed: ${error.message}`), { cause: error });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [LOCK_KEY_A, LOCK_KEY_B]).catch(() => {});
    client.release();
    await pool.end();
  }
}

if (require.main === module) main().catch(error => {
  console.error(`SystemFabric migration failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { MIGRATION_DIR, main, normalizeMigrationSql, migrationChecksum };
