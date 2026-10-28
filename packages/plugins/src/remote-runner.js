'use strict';

function createRemotePluginRunner({ url = process.env.SYSTEMFABRIC_PLUGIN_RUNNER_URL, token = process.env.SYSTEMFABRIC_PLUGIN_RUNNER_TOKEN, timeoutMs = 8000, allowHttpInternal = process.env.PLUGIN_RUNNER_ALLOW_HTTP_INTERNAL === 'true' } = {}) {
  let endpoint = null;
  if (url) {
    endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' && !(allowHttpInternal && endpoint.protocol === 'http:')) throw new Error('Plugin runner URL must use HTTPS unless internal HTTP is explicitly enabled.');
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Plugin runner URL must not embed credentials, query parameters, or a fragment.');
  }
  return Object.freeze({
    async invoke(payload) {
      if (!endpoint || typeof token !== 'string' || token.length < 32) {
        const error = new Error('Secure plugin execution is disabled until an isolated plugin-runner service and strong service token are configured.');
        error.code = 'ERR_SYSTEMFABRIC_PLUGIN_RUNTIME_DISABLED'; throw error;
      }
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
      try {
        const response = await fetch(new URL('/v1/invoke', endpoint), {
          method: 'POST', signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { const error = new Error(data.error || 'Plugin runner rejected the invocation.'); error.code = data.code || 'ERR_SYSTEMFABRIC_PLUGIN_RUNNER'; error.statusCode = response.status; throw error; }
        return data.result;
      } catch (error) {
        if (error.name === 'AbortError') { error.code = 'ERR_SYSTEMFABRIC_PLUGIN_TIMEOUT'; error.message = 'Plugin runner request timed out.'; }
        throw error;
      } finally { clearTimeout(timer); }
    }
  });
}
module.exports = { createRemotePluginRunner };
