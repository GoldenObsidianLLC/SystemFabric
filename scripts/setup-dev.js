'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadEnvFile } = require('./load-env');

const root = path.resolve(__dirname, '..');
const envExample = path.join(root, '.env.example');
const envFile = path.join(root, '.env');

function updateEnvFile({ target = envFile, template = envExample } = {}) {
  // COPYFILE_EXCL is the atomic create guard; avoid an existsSync/copy TOCTOU.
  let created = false;
  try {
    fs.copyFileSync(template, target, fs.constants.COPYFILE_EXCL);
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      // Windows may report EPERM for an already-existing directory target.
      // Confirm the target exists before treating that result as an exclusive-create collision.
      if (error.code !== 'EPERM') throw error;
      try { fs.lstatSync(target); } catch { throw error; }
    }
  }

  // Reject symlinks, directories and hard-linked files. Re-check file identity
  // after opening so a path swap between lstat and open cannot redirect writes.
  const pathStats = fs.lstatSync(target);
  if (!pathStats.isFile() || pathStats.nlink > 1) {
    throw new Error('.env must be a regular, single-link file; symbolic links and other file types are not accepted.');
  }

  const descriptor = fs.openSync(target, 'r+');
  try {
    const descriptorStats = fs.fstatSync(descriptor);
    if (!descriptorStats.isFile() || descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino) {
      throw new Error('.env changed during secure open; retry development setup.');
    }

    // Add test-only endpoints without replacing existing credentials/endpoints.
    let envText = fs.readFileSync(descriptor, 'utf8');
    const defaults = {
      TEST_DATABASE_URL: 'postgres://systemfabric:systemfabric_dev@127.0.0.1:5432/systemfabric_test',
      MEMGRAPH_TEST_URL: 'bolt://127.0.0.1:7687'
    };
    let changed = false;
    for (const [key, value] of Object.entries(defaults)) {
      const existing = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'm');
      if (!existing.test(envText)) { envText += `\n${key}=${value}`; changed = true; }
    }
    if (changed) {
      const nextText = Buffer.from(envText.replace(/\s*$/, '') + '\n', 'utf8');
      let written = 0;
      while (written < nextText.length) {
        const count = fs.writeSync(descriptor, nextText, written, nextText.length - written, written);
        if (count === 0) throw new Error('Unable to finish updating .env.');
        written += count;
      }
      fs.ftruncateSync(descriptor, nextText.length);
      fs.fsyncSync(descriptor);
    }
    return { created, changed };
  } finally {
    fs.closeSync(descriptor);
  }
}

function main() {
  const envUpdate = updateEnvFile({ target: envFile, template: envExample });
  if (envUpdate.created) console.log('Created .env from .env.example. Review the development-only values before use.');
  else console.log('.env already exists; preserving configured values.');

  fs.mkdirSync(path.join(root, 'artifacts', 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(root, 'var', 'media'), { recursive: true });
  fs.mkdirSync(path.join(root, 'var', 'library'), { recursive: true });
  loadEnvFile(envFile);

  console.log('Development folders are ready.');
  console.log('App DB:    configured=' + Boolean(process.env.DATABASE_URL));
  console.log('Test DB:   configured=' + Boolean(process.env.TEST_DATABASE_URL));
  console.log('Memgraph:  configured=' + Boolean(process.env.MEMGRAPH_URL));
  console.log('AI mode:   ' + (process.env.AI_PROVIDER || 'mock'));
  console.log('Safety:    external AI content remains opt-in; production secrets must never be copied here.');
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`Development setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { updateEnvFile };
