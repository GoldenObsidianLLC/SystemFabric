'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMigrationSql, migrationChecksum } = require('../scripts/migration-checksum');
const { assertFreshDatabaseForIdentity } = require('../scripts/migrate');

test('migration checksums are stable across LF, CRLF and CR line endings', () => {
  const lf = 'CREATE TABLE example (id integer);\n-- second line\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const cr = lf.replace(/\n/g, '\r');

  assert.equal(normalizeMigrationSql(crlf), lf);
  assert.equal(normalizeMigrationSql(cr), lf);
  assert.equal(migrationChecksum(lf), migrationChecksum(crlf));
  assert.equal(migrationChecksum(lf), migrationChecksum(cr));
});

test('migration checksum rejects non-string SQL', () => {
  assert.throws(() => migrationChecksum(Buffer.from('SELECT 1')), /must be a string/);
});

test('identity migration accepts a fresh database with no application tables', async () => {
  const queries = [];
  await assertFreshDatabaseForIdentity({
    async query(sql) {
      queries.push(sql);
      return { rows: [] };
    }
  });
  assert.equal(queries.length, 2);
  assert.match(queries[1], /information_schema\.tables/);
});

test('identity migration refuses a non-empty database with no new migration ledger', async () => {
  let queryCount = 0;
  await assert.rejects(
    assertFreshDatabaseForIdentity({
      async query() {
        queryCount += 1;
        return queryCount === 1 ? { rows: [] } : { rows: [{ table_name: 'sites' }] };
      }
    }),
    /non-empty database.*new empty database/i
  );
  assert.equal(queryCount, 2);
});

test('identity migration resumes when the new migration ledger already has entries', async () => {
  let queryCount = 0;
  await assertFreshDatabaseForIdentity({
    async query() {
      queryCount += 1;
      return { rows: [{ version: '0001_initial.sql' }] };
    }
  });
  assert.equal(queryCount, 1);
});
