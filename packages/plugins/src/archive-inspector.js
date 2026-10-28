'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { validatePluginManifest } = require('./manifest');

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_ENTRY_PATH = 300;

function runTar(args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
    const output = []; let size = 0; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); const error = new Error('Archive inspection timed out.'); error.code = 'ERR_SYSTEMFABRIC_PLUGIN_ARCHIVE_TIMEOUT'; reject(error); }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { child.kill('SIGKILL'); const error = new Error('Archive metadata exceeded limits.'); error.code = 'ERR_SYSTEMFABRIC_PLUGIN_ARCHIVE_LIMIT'; reject(error); } else output.push(chunk); });
    child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk.toString('utf8'); });
    child.on('error', error => { clearTimeout(timer); reject(Object.assign(error, { code: 'ERR_SYSTEMFABRIC_TAR_UNAVAILABLE' })); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) return reject(Object.assign(new Error('Invalid or unsupported npm archive.'), { code: 'ERR_SYSTEMFABRIC_PLUGIN_ARCHIVE_INVALID', diagnostic: stderr })); resolve(Buffer.concat(output)); });
  });
}

async function inspectNpmArchive(filePath) {
  const resolved = path.resolve(filePath);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARCHIVE_BYTES) throw Object.assign(new Error(`Package archive must be a file of at most ${MAX_ARCHIVE_BYTES} bytes.`), { code: 'ERR_SYSTEMFABRIC_PLUGIN_ARCHIVE_LIMIT' });
  const rawNames = (await runTar(['-tzf', resolved])).toString('utf8').split(/\r?\n/).filter(Boolean);
  if (rawNames.length > MAX_ENTRIES) throw Object.assign(new Error('Package contains too many archive entries.'), { code: 'ERR_SYSTEMFABRIC_PLUGIN_ARCHIVE_LIMIT' });

  // tar implementations differ on whether they retain a harmless leading "./"
  // (notably archives created by platform-specific tools). Canonicalize that
  // prefix for validation, but retain the original member name for extraction.
  // Backslashes remain rejected because other platforms may interpret them as
  // path separators and turn an otherwise inert member name into traversal.
  const entries = rawNames.map(rawName => {
    let name = rawName;
    while (name.startsWith('./')) name = name.slice(2);
    // A tarball may include the archive root directory as './'; it is safe
    // but should not be confused with a real package member.
    if (!name && (rawName === './' || rawName === '.')) name = '.';
    if (rawName.length > MAX_ENTRY_PATH || !name || name.startsWith('/') || /^[A-Za-z]:\//.test(name) || name.includes('\\') || name.split('/').some(part => part === '..')) {
      throw Object.assign(new Error('Archive contains an unsafe path.'), { code: 'ERR_SYSTEMFABRIC_PLUGIN_ARCHIVE_PATH' });
    }
    return { rawName, name };
  });
  const manifests = entries.filter(entry => entry.name === 'package/package.json');
  if (manifests.length !== 1) throw Object.assign(new Error('npm archive must contain exactly one package/package.json.'), { code: 'ERR_SYSTEMFABRIC_PLUGIN_ARCHIVE_MANIFEST' });
  const raw = await runTar(['-xOzf', resolved, manifests[0].rawName]);
  let packageJson;
  try { packageJson = JSON.parse(raw.toString('utf8')); } catch { throw Object.assign(new Error('package.json is invalid JSON.'), { code: 'ERR_SYSTEMFABRIC_PLUGIN_ARCHIVE_MANIFEST' }); }
  if (packageJson.scripts && Object.keys(packageJson.scripts).some(k => ['preinstall','install','postinstall','prepare'].includes(k))) {
    throw Object.assign(new Error('Install lifecycle scripts are not permitted for SystemFabric plugin packages.'), { code: 'ERR_SYSTEMFABRIC_PLUGIN_INSTALL_SCRIPT' });
  }
  const manifest = packageJson.systemfabricPlugin;
  const validation = validatePluginManifest(manifest);
  if (!validation.valid) throw Object.assign(new Error(`Plugin manifest failed validation: ${validation.errors.join('; ')}`), { code: 'ERR_SYSTEMFABRIC_PLUGIN_MANIFEST_INVALID', details: validation.errors });
  return { packageName: packageJson.name, packageVersion: packageJson.version, manifest, archiveBytes: stat.size, entryCount: rawNames.length };
}

module.exports = { inspectNpmArchive, MAX_ARCHIVE_BYTES, MAX_ENTRIES };
