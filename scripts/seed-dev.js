'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadEnvFile } = require('./load-env');
const { createPostgresPool } = require('../packages/db/src/postgres-store');

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set in .env.');
  const pool = createPostgresPool(process.env);
  const siteId = process.env.SYSTEMFABRIC_DEFAULT_SITE_ID || randomUUID();
  try {
    const result = await pool.query(
      `INSERT INTO sites(id,slug,name,default_locale) VALUES($1,'local-systemfabric','SystemFabric Local','en') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [siteId]
    );
    console.log(`Local site ID: ${result.rows[0].id}`);
    console.log('Set SYSTEMFABRIC_DEFAULT_SITE_ID to this UUID in .env before using POST /api/v1/pages/drafts.');
    console.log('This seeds a site only. It does not create an administrator account or production authentication.');
  } finally { await pool.end(); }
}

main().catch(error => { console.error(`Seed failed: ${error.message}`); process.exitCode = 1; });
