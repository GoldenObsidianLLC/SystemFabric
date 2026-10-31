'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { migrationChecksum } = require('../../scripts/migration-checksum');

const enabled = Boolean(
  process.env.DATABASE_URL &&
  process.env.SYSTEMFABRIC_RUN_POSTGRES_INTEGRATION === 'true'
);

const root = path.resolve(__dirname, '../..');
const migrationDir = path.join(root, 'database', 'migrations');
const targetMigration = '0009_fix_content_item_slug_constraint.sql';

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

test(
  'PostgreSQL integration: upgrades an existing v0008 database to v0009',
  { skip: !enabled },
  async () => {
    const sourceUrl = new URL(process.env.DATABASE_URL);
    const sourceDatabaseName = decodeURIComponent(
      sourceUrl.pathname.replace(/^\/+/, '')
    );

    // Safety checks: this test may create a temporary database only on a
    // local development/test PostgreSQL instance, never an arbitrary server.
    assert.match(
      sourceDatabaseName,
      /(?:^|[_-])test$/i,
      'DATABASE_URL must point to a dedicated test database'
    );

    const allowedHosts = new Set([
      '127.0.0.1',
      'localhost',
      'postgres',
      '::1',
    ]);

    assert.ok(
      allowedHosts.has(sourceUrl.hostname.toLowerCase()),
      'Migration-upgrade testing is restricted to a local PostgreSQL endpoint'
    );

    const databaseName =
      `systemfabric_upgrade_${crypto.randomUUID()
        .replace(/-/g, '')
        .slice(0, 12)}_test`;

    const upgradeUrl = new URL(sourceUrl.href);
    upgradeUrl.pathname = `/${databaseName}`;

    const adminPool = new Pool({
      connectionString: sourceUrl.href,
      max: 1,
      connectionTimeoutMillis: 4000,
    });

    let databaseCreated = false;
    let upgradePool;

    try {
      await adminPool.query(
        `CREATE DATABASE ${quoteIdentifier(databaseName)}`
      );
      databaseCreated = true;

      upgradePool = new Pool({
        connectionString: upgradeUrl.href,
        max: 2,
        connectionTimeoutMillis: 4000,
      });

      const migrationFiles = fs
        .readdirSync(migrationDir)
        .filter(file => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
        .sort();

      const targetIndex = migrationFiles.indexOf(targetMigration);

      assert.equal(
        targetIndex,
        8,
        'Migration 0009 must follow the eight existing baseline migrations'
      );

      const client = await upgradePool.connect();

      let siteId;
      let contentId;

      try {
        await client.query(`
          CREATE TABLE systemfabric_schema_migrations (
            version text PRIMARY KEY,
            sha256 text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now()
          )
        `);

        // Establish a realistic database at migration v0008.
        for (const file of migrationFiles.slice(0, targetIndex)) {
          const sql = fs.readFileSync(
            path.join(migrationDir, file),
            'utf8'
          );

          await client.query('BEGIN');

          try {
            await client.query(sql);

            await client.query(
              `INSERT INTO systemfabric_schema_migrations(version, sha256)
               VALUES($1, $2)`,
              [file, migrationChecksum(sql)]
            );

            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw new Error(
              `Failed to establish the v0008 fixture with ${file}: ${error.message}`
            );
          }
        }

        const baseline = await client.query(
          'SELECT count(*)::int AS count FROM systemfabric_schema_migrations'
        );

        assert.equal(baseline.rows[0].count, 8);

        // Migration 0001's legacy slug constraint contains an invalid regular
        // expression. Temporarily remove it in this disposable database so the
        // fixture can represent content that already exists before migration 0009.
        // Migration 0009 must install the corrected constraint.
        await client.query(
          'ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_slug_check'
        );

        // Insert content before applying migration 0009. These valid route
        // characters must remain supported after the upgrade.
        const site = await client.query(
          `INSERT INTO sites(slug, name)
           VALUES($1, $2)
           RETURNING id`,
          [
            `upgrade-${crypto.randomUUID().slice(0, 8)}`,
            'Migration Upgrade Fixture',
          ]
        );

        siteId = site.rows[0].id;

        const content = await client.query(
          `INSERT INTO content_items(site_id, slug, title, body)
           VALUES($1, $2, $3, $4::jsonb)
           RETURNING id`,
          [
            siteId,
            'docs/upgrade_path',
            'Existing Content',
            JSON.stringify({ schemaVersion: 1 }),
          ]
        );

        contentId = content.rows[0].id;
        // Restore the legacy v0008 constraint after seeding existing content.
        // NOT VALID preserves the historical row while retaining the old
        // constraint definition for migration 0009 to replace.
        await client.query(
          `ALTER TABLE content_items
          ADD CONSTRAINT content_items_slug_check
          CHECK (slug ~ '^[a-z0-9][a-z0-9-_/]{0,240}$') NOT VALID`
        );
      } finally {
        client.release();
      }

      // Invoke the real migration runner against the temporary database.
      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts', 'migrate.js')],
        {
          cwd: root,
          env: {
            ...process.env,
            DATABASE_URL: upgradeUrl.href,
          },
          encoding: 'utf8',
          timeout: 120_000,
          windowsHide: true,
        }
      );

      const output = [
        result.stdout || '',
        result.stderr || '',
      ].filter(Boolean).join('\n');

      // Captured output is useful in the retained integration test log.
      console.log(output.trim());

      assert.equal(
        result.error,
        undefined,
        `Could not execute migration runner: ${result.error?.message || ''}`
      );

      assert.equal(
        result.status,
        0,
        `Migration runner failed:\n${output}`
      );

      assert.match(
        output,
        /APPLY 0009_fix_content_item_slug_constraint\.sql/
      );

      assert.match(
        output,
        /OK\s+0009_fix_content_item_slug_constraint\.sql/
      );

      const verificationClient = await upgradePool.connect();

      try {
        // Existing content must survive the forward migration.
        const existing = await verificationClient.query(
          `SELECT slug
             FROM content_items
            WHERE id = $1`,
          [contentId]
        );

        assert.equal(existing.rows.length, 1);
        assert.equal(existing.rows[0].slug, 'docs/upgrade_path');

        // The updated constraint must permit supported route separators.
        const accepted = await verificationClient.query(
          `INSERT INTO content_items(site_id, slug, title, body)
           VALUES($1, $2, $3, $4::jsonb)
           RETURNING id`,
          [
            siteId,
            'docs/accepted_path',
            'Accepted Route',
            JSON.stringify({ schemaVersion: 1 }),
          ]
        );

        assert.equal(accepted.rowCount, 1);

        // Uppercase letters are not valid in the updated route expression.
        await assert.rejects(
          verificationClient.query(
            `INSERT INTO content_items(site_id, slug, title, body)
             VALUES($1, $2, $3, $4::jsonb)`,
            [
              siteId,
              'docs/reject_Uppercase',
              'Invalid Route',
              JSON.stringify({ schemaVersion: 1 }),
            ]
          ),
          error => error.code === '23514'
        );

        const registered = await verificationClient.query(
          `SELECT sha256
             FROM systemfabric_schema_migrations
            WHERE version = $1`,
          [targetMigration]
        );

        const migrationSql = fs.readFileSync(
          path.join(migrationDir, targetMigration),
          'utf8'
        );

        assert.equal(registered.rows.length, 1);
        assert.equal(
          registered.rows[0].sha256,
          migrationChecksum(migrationSql)
        );
      } finally {
        verificationClient.release();
      }
    } finally {
      if (upgradePool) {
        await upgradePool.end().catch(() => {});
      }

      if (databaseCreated) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1
              AND pid <> pg_backend_pid()`,
          [databaseName]
        ).catch(() => {});

        await adminPool.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`
        );
      }

      await adminPool.end();
    }
  }
);
