'use strict';

const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const { createContainerPluginRunner } = require('../../../packages/plugins/src/container-runner');
const { validatePinnedImageDigest } = require('../../../packages/plugins/src/manifest');

function sameSecret(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || expected.length < 32) return false;
  const a = createHash('sha256').update(candidate).digest(); const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
async function readJson(req, max = 300_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(new Error('Request too large.'), { statusCode: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON.'), { statusCode: 400 }); }
}
function createPluginRunnerServer({ env = process.env, runner } = {}) {
  const token = env.SYSTEMFABRIC_PLUGIN_RUNNER_TOKEN;
  if (env.NODE_ENV === 'production' && (!token || token.length < 32)) throw new Error('A strong SYSTEMFABRIC_PLUGIN_RUNNER_TOKEN is required.');
  const allowlist = String(env.SYSTEMFABRIC_PLUGIN_ALLOWED_IMAGES || '').split(',').map(x => x.trim()).filter(Boolean);
  for (const image of allowlist) if (!validatePinnedImageDigest(image)) throw new Error('Every allowlisted plugin image must be pinned with @sha256:<digest>.');
  const execute = runner || createContainerPluginRunner({ runtime: env.SYSTEMFABRIC_CONTAINER_RUNTIME || 'docker', timeoutMs: Number(env.PLUGIN_TIMEOUT_MS || 5000), allowedImages: allowlist });
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => { const body = Buffer.from(JSON.stringify(data)); res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'content-length':body.length, 'cache-control':'no-store', 'x-content-type-options':'nosniff' }); res.end(body); };
    if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ok', allowlistedImages: allowlist.length });
    if (req.method !== 'POST' || req.url !== '/v1/invoke') return json(404, { error: 'Not found.' });
    if (!sameSecret((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), token)) return json(401, { error: 'Unauthorized.', code: 'ERR_SYSTEMFABRIC_PLUGIN_RUNNER_UNAUTHORIZED' });
    try {
      const body = await readJson(req);
      if (!allowlist.includes(body.imageDigest)) return json(403, { error: 'Image is not allowlisted by the sandbox host.', code: 'ERR_SYSTEMFABRIC_PLUGIN_IMAGE_NOT_ALLOWED' });
      const result = await execute.invoke({ imageDigest: body.imageDigest, action: body.action, input: body.input, requestId: body.requestId });
      return json(200, { result });
    } catch (error) { return json(error.statusCode || 500, { error: error.message || 'Invocation failed.', code: error.code || 'ERR_SYSTEMFABRIC_PLUGIN_RUNNER' }); }
  });
  return server;
}
if (require.main === module) {
  const token = process.env.SYSTEMFABRIC_PLUGIN_RUNNER_TOKEN;
  if (!token || token.length < 32) { console.error('Set SYSTEMFABRIC_PLUGIN_RUNNER_TOKEN to at least 32 characters.'); process.exit(1); }
  const server = createPluginRunnerServer(); const host = process.env.PLUGIN_RUNNER_HOST || '127.0.0.1'; const port = Number(process.env.PLUGIN_RUNNER_PORT || 9090);
  server.listen(port, host, () => console.error(JSON.stringify({ type:'systemfabric.plugin_runner.started', host, port })));
}
module.exports = { createPluginRunnerServer, sameSecret };
