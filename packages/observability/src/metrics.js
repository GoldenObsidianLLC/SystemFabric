'use strict';

const DEFAULT_BUCKETS_MS = Object.freeze([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]);

function normalizeRoute(pathname) {
  if (pathname === '/health' || pathname === '/ready' || pathname === '/metrics' || pathname === '/admin') return pathname;
  if (pathname === '/reset-password' || pathname === '/verify-email' || pathname === '/accept-invitation') return '/account';
  if (pathname.startsWith('/assets/')) return '/assets/:asset';
  if (/^\/public\/[^/]+\/pages\/[^/]+/.test(pathname)) return '/public/:site/pages/:slug';
  if (pathname.startsWith('/api/v1/auth/')) return '/api/v1/auth';
  if (pathname.startsWith('/api/v1/sites/')) return '/api/v1/sites';
  if (pathname.startsWith('/api/v1/pages/')) return '/api/v1/pages/:id';
  if (pathname === '/api/v1/pages') return pathname;
  if (pathname.startsWith('/api/v1/plugins/')) return '/api/v1/plugins/:id';
  if (pathname === '/api/v1/plugins') return pathname;
  if (pathname.startsWith('/api/v1/public/')) return '/api/v1/public/:site/search';
  if (pathname.startsWith('/api/v1/media/')) return '/api/v1/media';
  if (pathname.startsWith('/api/v1/ai/')) return '/api/v1/ai';
  if (pathname.startsWith('/api/v1/')) return '/api/v1/other';
  return '/other';
}

function escapeLabel(value) { return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'); }

function createRequestMetrics({ bucketsMs = DEFAULT_BUCKETS_MS } = {}) {
  const buckets = [...new Set(bucketsMs)].filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const counters = new Map(); const histograms = new Map();
  function key(method, route, statusClass) { return `${method}|${route}|${statusClass}`; }
  function record({ method = 'GET', pathname = '/', statusCode = 0, durationMs = 0 } = {}) {
    const safeMethod = /^[A-Z]{1,12}$/.test(method) ? method : 'OTHER';
    const route = normalizeRoute(pathname);
    const statusClass = Number.isFinite(statusCode) ? `${Math.floor(statusCode / 100)}xx` : 'unknown';
    const sampleKey = key(safeMethod, route, statusClass);
    counters.set(sampleKey, (counters.get(sampleKey) || 0) + 1);
    const histogram = histograms.get(sampleKey) || { count: 0, sum: 0, bucketCounts: new Array(buckets.length).fill(0) };
    const duration = Math.max(0, Number(durationMs) || 0); histogram.count += 1; histogram.sum += duration;
    buckets.forEach((bound, index) => { if (duration <= bound) histogram.bucketCounts[index] += 1; });
    histograms.set(sampleKey, histogram);
  }
  function renderPrometheus() {
    const lines = [
      '# HELP systemfabric_http_requests_total Total HTTP responses by bounded route group and status class.',
      '# TYPE systemfabric_http_requests_total counter'
    ];
    for (const [compound, count] of counters) {
      const [method, route, statusClass] = compound.split('|');
      lines.push(`systemfabric_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status_class="${escapeLabel(statusClass)}"} ${count}`);
    }
    lines.push('# HELP systemfabric_http_request_duration_milliseconds HTTP request duration in milliseconds.', '# TYPE systemfabric_http_request_duration_milliseconds histogram');
    for (const [compound, histogram] of histograms) {
      const [method, route, statusClass] = compound.split('|'); const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status_class="${escapeLabel(statusClass)}"`;
      buckets.forEach((bound, index) => lines.push(`systemfabric_http_request_duration_milliseconds_bucket{${labels},le="${bound}"} ${histogram.bucketCounts[index]}`));
      lines.push(`systemfabric_http_request_duration_milliseconds_bucket{${labels},le="+Inf"} ${histogram.count}`);
      lines.push(`systemfabric_http_request_duration_milliseconds_sum{${labels}} ${histogram.sum.toFixed(3)}`);
      lines.push(`systemfabric_http_request_duration_milliseconds_count{${labels}} ${histogram.count}`);
    }
    return `${lines.join('\n')}\n`;
  }
  return Object.freeze({ record, renderPrometheus, normalizeRoute });
}

module.exports = { createRequestMetrics, normalizeRoute, DEFAULT_BUCKETS_MS };
