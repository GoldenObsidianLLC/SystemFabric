'use strict';

const { spawn } = require('node:child_process');
const { validatePinnedImageDigest } = require('./manifest');

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function createContainerPluginRunner({ runtime = process.env.SYSTEMFABRIC_CONTAINER_RUNTIME || 'docker', timeoutMs = 5000, memory = '128m', cpus = '0.50', pidsLimit = 32, allowedImages = [] } = {}) {
  const allowlist = new Set(allowedImages);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new TypeError('Plugin timeout must be 100–30000 ms.');
  return Object.freeze({
    async invoke({ imageDigest, action, input, requestId }) {
      if (!validatePinnedImageDigest(imageDigest)) {
        const error = new Error('Plugin runtime requires an immutable image reference pinned by SHA-256 digest.');
        error.code = 'ERR_SYSTEMFABRIC_PLUGIN_IMAGE_NOT_PINNED'; throw error;
      }
      if (!allowlist.has(imageDigest)) { const error = new Error('Plugin image is not on the runner allowlist.'); error.code = 'ERR_SYSTEMFABRIC_PLUGIN_IMAGE_NOT_ALLOWED'; throw error; }
      if (typeof action !== 'string' || !/^[a-z][a-z0-9_.:-]{1,99}$/.test(action)) throw new TypeError('Invalid plugin action.');
      const envelope = Buffer.from(JSON.stringify({ protocol: 1, action, input, requestId: String(requestId || '').slice(0, 100) }));
      if (envelope.length > MAX_INPUT_BYTES) { const error = new Error('Plugin input exceeds the allowed limit.'); error.code = 'ERR_SYSTEMFABRIC_PLUGIN_INPUT_LIMIT'; throw error; }
      const args = [
        'run', '--rm', '--interactive', '--network=none', '--read-only', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--pids-limit', String(pidsLimit), '--memory', memory,
        '--cpus', cpus, '--memory-swap', memory, '--ulimit', 'nofile=64:64', '--ulimit', 'nproc=32:32', '--user', '65532:65532', '--pull=never', '--log-driver=none', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
        '--env', 'SYSTEMFABRIC_PLUGIN_PROTOCOL=1', imageDigest
      ];
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(runtime, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH || '/usr/bin:/bin', SYSTEMFABRIC_PLUGIN_PROTOCOL: '1' } });
        } catch (error) { error.code = 'ERR_SYSTEMFABRIC_PLUGIN_RUNTIME'; reject(error); return; }
        const out = []; const err = []; let outSize = 0; let errSize = 0; let settled = false;
        const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
        const timer = setTimeout(() => {
          child.kill('SIGKILL'); const error = new Error('Plugin execution exceeded its time limit.'); error.code = 'ERR_SYSTEMFABRIC_PLUGIN_TIMEOUT'; finish(reject, error);
        }, timeoutMs);
        timer.unref?.();
        child.stdout.on('data', chunk => { outSize += chunk.length; if (outSize > MAX_OUTPUT_BYTES) { child.kill('SIGKILL'); const error = new Error('Plugin output exceeded its limit.'); error.code = 'ERR_SYSTEMFABRIC_PLUGIN_OUTPUT_LIMIT'; finish(reject, error); } else out.push(chunk); });
        child.stderr.on('data', chunk => { errSize += chunk.length; if (errSize <= 8192) err.push(chunk); });
        child.on('error', error => { error.code = error.code === 'ENOENT' ? 'ERR_SYSTEMFABRIC_PLUGIN_RUNTIME_MISSING' : 'ERR_SYSTEMFABRIC_PLUGIN_RUNTIME'; finish(reject, error); });
        child.on('close', code => {
          if (settled) return;
          if (code !== 0) { const error = new Error(`Plugin sandbox exited with code ${code}.`); error.code = 'ERR_SYSTEMFABRIC_PLUGIN_FAILED'; error.diagnostic = Buffer.concat(err).toString('utf8').slice(0, 2000); finish(reject, error); return; }
          try {
            const response = JSON.parse(Buffer.concat(out).toString('utf8'));
            if (!response || response.protocol !== 1 || response.ok !== true || !Object.hasOwn(response, 'result')) throw new Error('Plugin response does not match protocol v1.');
            finish(resolve, response.result);
          } catch (error) { error.code = 'ERR_SYSTEMFABRIC_PLUGIN_PROTOCOL'; finish(reject, error); }
        });
        child.stdin.end(envelope);
      });
    }
  });
}

module.exports = { createContainerPluginRunner, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES };
