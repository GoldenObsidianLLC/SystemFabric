'use strict';

const path = require('node:path');
const { loadEnvFile } = require('./load-env');
const { createPostgresPool } = require('../packages/db/src/postgres-store');
const { reconcileLocalLibraryObjects } = require('../packages/library/src/reconcile-local-objects');

async function main(argv = process.argv.slice(2)) {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  const options = new Set(argv);
  for (const option of options) if (!['--apply'].includes(option) && !option.startsWith('--min-age-hours=')) throw new Error(`Unsupported option: ${option}`);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; no files are inspected or removed without a working database connection.');
  const minAgeArg = [...options].find(item => item.startsWith('--min-age-hours='));
  const minAgeHours = minAgeArg ? Number(minAgeArg.split('=')[1]) : 24;
  if (!Number.isFinite(minAgeHours) || minAgeHours < 1 || minAgeHours > 8760) throw new Error('--min-age-hours must be between 1 and 8760.');
  const pool = createPostgresPool(process.env);
  try {
    const report = await reconcileLocalLibraryObjects({ pool, root: process.env.LIBRARY_ROOT || path.resolve(process.cwd(), 'var', 'library'), apply: options.has('--apply'), minAgeMs: minAgeHours * 60 * 60 * 1000 });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(`Library reconciliation failed: ${error.message}`); process.exitCode = 1; });
module.exports = { main };
