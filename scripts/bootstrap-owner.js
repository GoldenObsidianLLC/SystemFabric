'use strict';

const path = require('node:path');
const { loadEnvFile } = require('./load-env');
const { createPostgresPool } = require('../packages/db/src/postgres-store');
const { createIdentityService } = require('../packages/auth/src/service');

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured.');
  if (!process.env.SYSTEMFABRIC_ADMIN_EMAIL || !process.env.SYSTEMFABRIC_ADMIN_PASSWORD) throw new Error('Set SYSTEMFABRIC_ADMIN_EMAIL and SYSTEMFABRIC_ADMIN_PASSWORD in the process environment. The password must be at least 12 characters with upper/lowercase and a number.');
  const pool = createPostgresPool(process.env);
  try {
    const result = await createIdentityService({ pool, env: process.env }).bootstrapOwner({
      email: process.env.SYSTEMFABRIC_ADMIN_EMAIL,
      password: process.env.SYSTEMFABRIC_ADMIN_PASSWORD,
      displayName: process.env.SYSTEMFABRIC_ADMIN_NAME || process.env.SYSTEMFABRIC_ADMIN_EMAIL,
      siteSlug: process.env.SYSTEMFABRIC_BOOTSTRAP_SITE_SLUG || 'main',
      siteName: process.env.SYSTEMFABRIC_BOOTSTRAP_SITE_NAME || 'Main Site'
    });
    console.log(JSON.stringify({ status: 'created', user: result.user, site: result.site, next: 'Sign in at /admin. This script never prints the password.' }, null, 2));
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(`Admin bootstrap failed: ${error.code || 'ERROR'}: ${error.message}`); process.exitCode = 1; });
module.exports = { main };
