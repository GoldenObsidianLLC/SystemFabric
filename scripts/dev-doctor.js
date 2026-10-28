'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { loadEnvFile } = require('./load-env');

const root = path.resolve(__dirname, '..');
const minimumNode = [22, 23, 4];
const results = [];
function add(name, ok, details, fatal = true) { results.push({ name, ok, details, fatal }); }
function versionAtLeast(actual, minimum) {
  const a = String(actual).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < minimum.length; i += 1) {
    const delta = (a[i] || 0) - minimum[i];
    if (delta > 0) return true;
    if (delta < 0) return false;
  }
  return true;
}
function commandOk(command, args) {
  // Docker is an executable on supported development hosts. Avoid shell=true: it breaks paths with spaces and triggers DEP0190 on recent Node.js.
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false });
  return result.status === 0;
}
function tcpCheck(host, port, timeoutMs = 1200) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
function parseUrl(raw, label) {
  try {
    const url = new URL(raw);
    const port = Number(url.port || (url.protocol === 'bolt:' ? 7687 : 5432));
    if (!url.hostname || !Number.isInteger(port) || port <= 0) throw new Error('host or port missing');
    return { host: url.hostname, port, database: url.pathname.replace(/^\//, ''), label };
  } catch {
    return null;
  }
}

async function main() {
  loadEnvFile(path.join(root, '.env'));
  add('Node.js runtime', versionAtLeast(process.versions.node, minimumNode), `Found ${process.version}; requires >=22.23.4.`);
  add('Dependency lockfile', fs.existsSync(path.join(root, 'package-lock.json')), fs.existsSync(path.join(root, 'package-lock.json'))
    ? 'package-lock.json exists; verify its provenance by running npm ci and reviewing the diff.'
    : 'package-lock.json is absent. Run npm run dev:bootstrap on a network-enabled development machine and review the generated file.');

  const required = [
    ['pg', 'PostgreSQL client'],
    ['neo4j-driver', 'Memgraph driver'],
    ['@playwright/test', 'Playwright tests']
  ];
  for (const [moduleName, displayName] of required) {
    try { require.resolve(moduleName, { paths: [root] }); add(`${displayName} dependency`, true, `${moduleName} resolves.`); }
    catch { add(`${displayName} dependency`, false, `${moduleName} is not installed; run npm run dev:bootstrap.`); }
  }

  const inDevcontainer = process.env.SF_DEVCONTAINER === 'true' || Boolean(process.env.REMOTE_CONTAINERS);
  if (inDevcontainer) add('Docker Compose control', true, 'Running inside the VS Code Dev Container; Compose services are managed by the host.');
  else {
    const dockerOk = commandOk('docker', ['--version']) && commandOk('docker', ['compose', 'version']);
    add('Docker Compose', dockerOk, dockerOk ? 'Docker Compose is available.' : 'Docker Compose is missing; install Docker Desktop or Docker Engine + Compose plugin.');
  }

  const checks = [
    ['App PostgreSQL', process.env.DATABASE_URL, 'DATABASE_URL'],
    ['Test PostgreSQL', process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL'],
    ['Memgraph', process.env.MEMGRAPH_TEST_URL || process.env.MEMGRAPH_URL, 'MEMGRAPH_TEST_URL / MEMGRAPH_URL']
  ];
  for (const [label, raw, envName] of checks) {
    const endpoint = raw ? parseUrl(raw, label) : null;
    if (!endpoint) { add(label, false, `${envName} is not configured or invalid.`); continue; }
    const reachable = await tcpCheck(endpoint.host, endpoint.port);
    add(label, reachable, reachable ? `${endpoint.host}:${endpoint.port} accepts TCP connections.` : `Cannot connect to ${endpoint.host}:${endpoint.port}; start Compose services or check the URL.`, false);
  }

  console.log('\nSystemFabric VS Code development preflight');
  console.log('==========================================');
  for (const result of results) console.log(`${result.ok ? 'PASS' : (result.fatal ? 'BLOCK' : 'WARN')}  ${result.name}: ${result.details}`);
  const blockers = results.filter(result => !result.ok && result.fatal);
  const warnings = results.filter(result => !result.ok && !result.fatal);
  console.log(`\nSummary: ${results.length - blockers.length - warnings.length} passed, ${warnings.length} service warning(s), ${blockers.length} blocker(s).`);
  if (blockers.length) process.exitCode = 1;
}

main().catch(error => { console.error(`Preflight failed: ${error.stack || error.message}`); process.exitCode = 1; });
