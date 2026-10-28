'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadEnvFile } = require('./load-env');

const root = path.resolve(__dirname, '..');
const envExample = path.join(root, '.env.example');
const envFile = path.join(root, '.env');

function main() {
  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(envExample, envFile, fs.constants.COPYFILE_EXCL);
    console.log('Created .env from .env.example. Review the development-only values before use.');
  } else {
    console.log('.env already exists; preserving configured values.');
  }

  // Add test-only endpoints to older developer .env files without replacing any
  // existing credential or endpoint. The live runner still requires explicit opt-in.
  let envText = fs.readFileSync(envFile, 'utf8');
  const defaults = {
    TEST_DATABASE_URL: 'postgres://systemfabric:systemfabric_dev@127.0.0.1:5432/systemfabric_test',
    MEMGRAPH_TEST_URL: 'bolt://127.0.0.1:7687'
  };
  let changed = false;
  for (const [key, value] of Object.entries(defaults)) {
    const existing = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'm');
    if (!existing.test(envText)) { envText += `\n${key}=${value}`; changed = true; }
  }
  if (changed) fs.writeFileSync(envFile, envText.replace(/\s*$/, '') + '\n');

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

try { main(); } catch (error) {
  console.error(`Development setup failed: ${error.message}`);
  process.exitCode = 1;
}
