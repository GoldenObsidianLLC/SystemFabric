'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMigrationSql, migrationChecksum } = require('../scripts/migration-checksum');

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
