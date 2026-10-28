'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function keyPath(root, key) {
  if (typeof key !== 'string' || !key || key.includes('\\') || key.includes('\0') || path.posix.isAbsolute(key) || key.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const candidate = path.resolve(root, ...key.split('/'));
  return isInsideRoot(root, candidate) ? candidate : null;
}

async function walkFiles(root, directory = root, output = []) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const info = await fs.promises.lstat(absolute);
    // Never follow symlinks; reconciliation only manages regular files created by the store.
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) await walkFiles(root, absolute, output);
    else if (info.isFile()) output.push({ absolute, key: path.relative(root, absolute).split(path.sep).join('/'), size: info.size, mtimeMs: info.mtimeMs });
  }
  return output;
}

/**
 * Find files under a local library root that have no references in PostgreSQL.
 * Dry-run is the default. apply=true only deletes files older than minAgeMs.
 * This deliberately does not clean soft-deleted rows or remote object stores.
 */
async function reconcileLocalLibraryObjects({ pool, root, apply = false, minAgeMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required for object reconciliation.');
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) throw new TypeError('minAgeMs must be a non-negative finite number.');
  const libraryRoot = path.resolve(root || process.env.LIBRARY_ROOT || path.join(process.cwd(), 'var', 'library'));
  await fs.promises.mkdir(libraryRoot, { recursive: true, mode: 0o750 });
  const query = await pool.query(`
    SELECT storage_key FROM library_assets WHERE storage_provider='local'
    UNION SELECT v.storage_key FROM library_asset_versions v JOIN library_assets a ON a.id=v.asset_id WHERE a.storage_provider='local'
    UNION SELECT mv.storage_key FROM media_variants mv JOIN library_assets a ON a.id=mv.asset_id WHERE a.storage_provider='local'
  `);
  const referenced = new Set();
  for (const row of query.rows || []) {
    const absolute = keyPath(libraryRoot, row.storage_key);
    if (absolute) referenced.add(path.relative(libraryRoot, absolute).split(path.sep).join('/'));
  }
  const files = await walkFiles(libraryRoot);
  const candidates = files.filter(file => !referenced.has(file.key) && now - file.mtimeMs >= minAgeMs);
  const removed = [];
  if (apply) {
    for (const file of candidates) {
      // Re-check that the path has not been replaced by a symlink since traversal.
      const info = await fs.promises.lstat(file.absolute);
      if (!info.isFile() || info.isSymbolicLink() || !isInsideRoot(libraryRoot, file.absolute)) continue;
      await fs.promises.unlink(file.absolute);
      removed.push(file.key);
    }
  }
  return Object.freeze({ root: libraryRoot, apply: Boolean(apply), referencedCount: referenced.size, fileCount: files.length, candidateCount: candidates.length, removed, candidates: candidates.map(({ key, size, mtimeMs }) => ({ key, size, ageMs: Math.max(0, now - mtimeMs) })) });
}

module.exports = { reconcileLocalLibraryObjects, keyPath, isInsideRoot, walkFiles };
