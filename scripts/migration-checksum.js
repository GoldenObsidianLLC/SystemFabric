'use strict';

const crypto = require('node:crypto');

/**
 * Normalize SQL line endings before hashing or executing a migration.
 * Git's core.autocrlf may rewrite LF as CRLF on Windows; this must not make an
 * unchanged, already-applied migration appear edited on another platform.
 */
function normalizeMigrationSql(sql) {
  if (typeof sql !== 'string') throw new TypeError('Migration SQL must be a string.');
  return sql.replace(/\r\n?/g, '\n');
}

function migrationChecksum(sql) {
  return crypto.createHash('sha256').update(normalizeMigrationSql(sql), 'utf8').digest('hex');
}

module.exports = { normalizeMigrationSql, migrationChecksum };
