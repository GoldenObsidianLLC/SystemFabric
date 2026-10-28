'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadEnvFile } = require('./load-env');

const root = path.resolve(__dirname, '..');

// Run npm's JavaScript CLI through the current Node executable instead of
// spawning npm.cmd/npx.cmd through a shell. This is important on Windows when
// Node is installed under a path such as `C:\Program Files\nodejs`.
function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);

  const npmCli = candidates.find(candidate => fs.existsSync(candidate));
  if (!npmCli) {
    throw new Error('Could not locate npm-cli.js. Run this command through `npm run dev:bootstrap` or repair the npm installation.');
  }
  return npmCli;
}

function printable(value) {
  const text = String(value);
  return /\s/.test(text) ? JSON.stringify(text) : text;
}

function run(label, command, args, extraEnv = {}) {
  let executable = command;
  let executableArgs = args;
  if (command === 'npm') {
    executable = process.execPath;
    executableArgs = [resolveNpmCli(), ...args];
  }

  console.log(`\n==> ${label}\n$ ${[executable, ...executableArgs].map(printable).join(' ')}`);
  const result = spawnSync(executable, executableArgs, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    windowsHide: true,
    shell: false
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
}

try {
  run('Create safe local development defaults', process.execPath, ['scripts/setup-dev.js']);
  loadEnvFile(path.join(root, '.env'));

  // Until the generated dependency graph has been reviewed and committed, a fresh
  // workspace must use npm install. Subsequent setup uses npm ci when a lock exists.
  const hasLock = fs.existsSync(path.join(root, 'package-lock.json'));
  const npmArgs = hasLock
    ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
    : ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
  run(hasLock ? 'Install from committed lockfile' : 'Resolve dependencies and generate package-lock.json', 'npm', npmArgs);
  run('Materialize optional local assets', 'npm', ['run', 'postinstall']);

  if (process.env.SKIP_PLAYWRIGHT_BROWSER_INSTALL !== '1') {
    run('Install Playwright Chromium browser', 'npm', ['exec', '--', 'playwright', 'install', 'chromium']);
  } else {
    console.log('Skipping Playwright browser download because SKIP_PLAYWRIGHT_BROWSER_INSTALL=1.');
  }

  console.log('\nBootstrap complete. Review package-lock.json, then commit it only after npm ci and CI are successful.');
  console.log('Next: npm run dev:doctor, npm run check, npm run test:integration:live, and npm run test:e2e.');
} catch (error) {
  console.error(`\nBootstrap blocked: ${error.message}`);
  console.error('If dependency resolution failed, check network/registry access, clear proxy misconfiguration, and rerun npm run dev:bootstrap.');
  process.exitCode = 1;
}
