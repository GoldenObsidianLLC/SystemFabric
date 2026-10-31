'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { loadEnvFile } = require('./load-env');

const root = path.resolve(__dirname, '..');
const evidenceDir = path.join(root, 'artifacts', 'evidence');
const logLines = [];
const evidence = {
  schemaVersion: 1, product: 'SystemFabric', version: '0.5.1',
  gate: 'fresh-migrations', generatedAt: new Date().toISOString(),
  status: 'BLOCKED',
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  databaseName: null, migrationCount: 0, firstPass: null, secondPass: null,
  cleanup: 'not_started', error: null
};
function log(line) { logLines.push(String(line)); console.log(line); }

function runMigrations(databaseUrl, label) {
  const child = spawnSync(process.execPath, [path.join(root, 'scripts', 'migrate.js')], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl },
    encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true
  });
  const output = [child.stdout || '', child.stderr || ''].filter(Boolean).join('\n').trim();
  log('--- ' + label + ' ---');
  if (output) log(output);
  if (child.error) throw new Error(label + ' could not start: ' + child.error.message);
  if (child.status !== 0) throw new Error(label + ' failed with exit code ' + (child.status ?? 'unknown') + '.');
  return output;
}

async function main() {
  loadEnvFile(path.join(root, '.env'));
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required; refusing to use DATABASE_URL.');
  let adminUrl;
  try { adminUrl = new URL(testDatabaseUrl); } catch { throw new Error('TEST_DATABASE_URL is not a valid URL.'); }
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1', 'postgres']);
  const baseDatabaseName = decodeURIComponent(adminUrl.pathname.replace(/^\/+/, ''));
  const username = decodeURIComponent(adminUrl.username);
  if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol)) throw new Error('TEST_DATABASE_URL must use PostgreSQL.');
  if (!localHosts.has(adminUrl.hostname.toLowerCase())) throw new Error('Safety stop: fresh-migration validation is restricted to local PostgreSQL hosts.');
  if (!/(?:^|[_-])test$/i.test(baseDatabaseName)) throw new Error('Safety stop: TEST_DATABASE_URL database name must end in "test".');
  if (!/^[A-Za-z0-9_]+$/.test(username)) throw new Error('Safety stop: PostgreSQL test role name contains unsupported characters.');

  const targetDatabaseName = 'systemfabric_fresh_' + randomUUID().replaceAll('-', '').slice(0, 12) + '_test';
  const targetUrl = new URL(testDatabaseUrl);
  targetUrl.pathname = '/' + targetDatabaseName;
  evidence.databaseName = targetDatabaseName;

  const adminPool = new Pool({ connectionString: testDatabaseUrl, connectionTimeoutMillis: 4000, max: 1 });
  let created = false;
  try {
    const existing = await adminPool.query('SELECT 1 FROM pg_database WHERE datname=$1', [targetDatabaseName]);
    if (existing.rowCount) throw new Error('Refusing to reuse an existing database with the generated validation name.');
    log('Creating disposable migration database "' + targetDatabaseName + '" from the dedicated TEST_DATABASE_URL connection.');
    await adminPool.query('CREATE DATABASE "' + targetDatabaseName + '" OWNER "' + username + '"');
    created = true;

    const migrationFiles = fs.readdirSync(path.join(root, 'database', 'migrations'))
      .filter(file => /^\d+_[a-z0-9_-]+\.sql$/i.test(file)).sort();
    if (migrationFiles.length !== 14) throw new Error('Expected 14 versioned migrations; found ' + migrationFiles.length + '.');
    evidence.migrationCount = migrationFiles.length;

    const firstOutput = runMigrations(targetUrl.toString(), 'Fresh database migration pass');
    if (!migrationFiles.every(file => firstOutput.includes('OK   ' + file))) throw new Error('First migration pass did not report every migration as applied.');
    evidence.firstPass = '14/14 migrations applied';

    const verifyPool = new Pool({ connectionString: targetUrl.toString(), connectionTimeoutMillis: 4000, max: 1 });
    try {
      const rows = await verifyPool.query('SELECT version FROM systemfabric_schema_migrations ORDER BY version');
      const actual = rows.rows.map(row => row.version);
      if (actual.length !== migrationFiles.length || actual.some((value, index) => value !== migrationFiles[index])) {
        throw new Error('Migration ledger mismatch: expected 14 ordered versions; found ' + actual.length + '.');
      }
    } finally { await verifyPool.end(); }

    const secondOutput = runMigrations(targetUrl.toString(), 'Idempotent migration pass');
    if (!migrationFiles.every(file => secondOutput.includes('SKIP ' + file + ' (already applied)'))) {
      throw new Error('Second migration pass did not skip every previously applied migration.');
    }
    evidence.secondPass = '14/14 migrations skipped as already applied';
    evidence.status = 'PASS';
    log('FRESH MIGRATION RESULT: PASS');
  } finally {
    if (created) {
      await adminPool.query('DROP DATABASE "' + targetDatabaseName + '"');
      evidence.cleanup = 'disposable database dropped';
      log('Dropped only the disposable database "' + targetDatabaseName + '".');
    } else {
      evidence.cleanup = 'no database created';
    }
    await adminPool.end();
  }
}

main().catch(error => {
  evidence.status = 'BLOCKED';
  evidence.error = error.message;
  log('FRESH MIGRATION RESULT: BLOCKED — ' + error.message);
}).finally(() => {
  fs.mkdirSync(evidenceDir, { recursive: true });
  evidence.generatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(evidenceDir, 'fresh-migrations.json'), JSON.stringify(evidence, null, 2) + '\n');
  fs.writeFileSync(path.join(evidenceDir, 'fresh-migrations.log'), logLines.join('\n') + '\n');
  if (evidence.status !== 'PASS') process.exitCode = 1;
});
