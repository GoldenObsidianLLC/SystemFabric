'use strict';

const { getTraceContext, getTraceparent } = require('../../observability/src/trace-context');
const { withClientSpan } = require('../../observability/src/tracing');

function createRemotePluginRunner({
  url = process.env.VIRGOSCORPIO_HUB_PLUGIN_RUNNER_URL,
  token = process.env.VIRGOSCORPIO_HUB_PLUGIN_RUNNER_TOKEN,
  timeoutMs = 8000,
  allowHttpInternal = process.env.PLUGIN_RUNNER_ALLOW_HTTP_INTERNAL === 'true'
} = {}) {
  let endpoint = null;
  if (url) {
    endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' && !(allowHttpInternal && endpoint.protocol === 'http:')) {
      throw new Error('Plugin runner URL must use HTTPS unless internal HTTP is explicitly enabled.');
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('Plugin runner URL must not embed credentials, query parameters, or a fragment.');
    }
  }

  return Object.freeze({
    async invoke(payload) {
      return withClientSpan('plugin_runner.invoke', {
        'virgoscorpio_hub.component': 'plugins',
        'virgoscorpio_hub.operation': 'invoke'
      }, async () => {
        if (!endpoint || typeof token !== 'string' || token.length < 32) {
          const error = new Error('Secure plugin execution is disabled until an isolated plugin-runner service and strong service token are configured.');
          error.code = 'ERR_VIRGOSCORPIO_HUB_PLUGIN_RUNTIME_DISABLED';
          throw error;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();
        try {
          const headers = {
            'content-type': 'application/json',
            authorization: 'Bearer ' + token
          };
          const traceparent = getTraceparent();
          const traceContext = getTraceContext();
          if (traceparent) headers.traceparent = traceparent;
          if (traceContext?.requestId) headers['x-request-id'] = traceContext.requestId;

          const response = await fetch(new URL('/v1/invoke', endpoint), {
            method: 'POST',
            signal: controller.signal,
            headers,
            body: JSON.stringify(payload)
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            const error = new Error(data.error || 'Plugin runner rejected the invocation.');
            error.code = data.code || 'ERR_VIRGOSCORPIO_HUB_PLUGIN_RUNNER';
            error.statusCode = response.status;
            throw error;
          }
          return data.result;
        } catch (error) {
          if (error.name === 'AbortError') {
            error.code = 'ERR_VIRGOSCORPIO_HUB_PLUGIN_TIMEOUT';
            error.message = 'Plugin runner request timed out.';
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
      });
    }
  });
}

module.exports = { createRemotePluginRunner };
