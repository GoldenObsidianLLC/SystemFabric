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

const REALTIME_COUNTERS = Object.freeze([
  'subscriptions_opened_total',
  'subscriptions_closed_total',
  'authorization_denials_total',
  'authorization_revocations_total',
  'connection_limit_rejections_total',
  'session_expirations_total',
  'events_published_total',
  'fanout_targets_total',
  'events_delivered_total',
  'events_revoked_total',
  'queue_overflows_total',
  'sse_connections_opened_total',
  'sse_connections_closed_total',
  'sse_heartbeats_total',
  'sse_backpressure_waits_total',
  'sse_reconnect_required_total',
  'presence_heartbeats_total',
  'presence_leaves_total',
  'presence_expiry_notifications_total',
  'redis_pubsub_messages_total',
  'redis_pubsub_publishes_total',
  'redis_publish_failures_total',
  'redis_inbound_queue_overflows_total',
  'redis_reconnect_attempts_total',
  'redis_errors_total',
  'redis_invalid_messages_total'
]);
const REALTIME_GAUGES = Object.freeze([
  'active_subscriptions',
  'active_sse_connections',
  'presence_memory_active_leases',
  'presence_redis_last_site_lease_count',
  'redis_inbound_queue_size'
]);
const REALTIME_HISTOGRAMS = Object.freeze({
  event_lag_milliseconds: Object.freeze([1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]),
  fanout_targets_per_event: Object.freeze([0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000]),
  presence_snapshot_lease_count: Object.freeze([0, 1, 5, 10, 25, 50, 100, 500, 1000, 5000, 10000])
});

function createRealtimeMetrics() {
  const counters = new Map(REALTIME_COUNTERS.map(name => [name, 0]));
  const gauges = new Map(REALTIME_GAUGES.map(name => [name, 0]));
  const histograms = new Map(Object.entries(REALTIME_HISTOGRAMS).map(([name, bounds]) => [
    name,
    { count: 0, sum: 0, bucketCounts: new Array(bounds.length).fill(0) }
  ]));

  function increment(name, amount = 1) {
    if (!counters.has(name)) throw new TypeError('Unknown real-time counter: ' + name);
    if (!Number.isFinite(amount) || amount < 0) throw new RangeError('Counter increments must be finite and non-negative.');
    counters.set(name, counters.get(name) + amount);
  }

  function setGauge(name, value) {
    if (!gauges.has(name)) throw new TypeError('Unknown real-time gauge: ' + name);
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Gauge values must be finite and non-negative.');
    gauges.set(name, value);
  }

  function observe(name, value) {
    const histogram = histograms.get(name);
    if (!histogram) throw new TypeError('Unknown real-time histogram: ' + name);
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Histogram observations must be finite and non-negative.');
    const bounds = REALTIME_HISTOGRAMS[name];
    histogram.count += 1;
    histogram.sum += value;
    bounds.forEach((bound, index) => { if (value <= bound) histogram.bucketCounts[index] += 1; });
  }

  function snapshot() {
    const histogramSnapshot = Object.fromEntries([...histograms.entries()].map(([name, value]) => [
      name,
      Object.freeze({
        count: value.count,
        sum: value.sum,
        bucketCounts: Object.freeze([...value.bucketCounts])
      })
    ]));
    return Object.freeze({
      counters: Object.freeze(Object.fromEntries(counters)),
      gauges: Object.freeze(Object.fromEntries(gauges)),
      histograms: Object.freeze(histogramSnapshot)
    });
  }

  function renderPrometheus() {
    const lines = [];
    for (const [name, value] of counters) {
      const metric = 'systemfabric_realtime_' + name;
      lines.push('# TYPE ' + metric + ' counter', metric + ' ' + value);
    }
    for (const [name, value] of gauges) {
      const metric = 'systemfabric_realtime_' + name;
      lines.push('# TYPE ' + metric + ' gauge', metric + ' ' + value);
    }
    for (const [name, histogram] of histograms) {
      const metric = 'systemfabric_realtime_' + name;
      const bounds = REALTIME_HISTOGRAMS[name];
      lines.push('# TYPE ' + metric + ' histogram');
      bounds.forEach((bound, index) => lines.push(metric + '_bucket{le="' + bound + '"} ' + histogram.bucketCounts[index]));
      lines.push(metric + '_bucket{le="+Inf"} ' + histogram.count);
      lines.push(metric + '_sum ' + histogram.sum.toFixed(3));
      lines.push(metric + '_count ' + histogram.count);
    }
    return lines.join('\n') + '\n';
  }

  return Object.freeze({ increment, setGauge, observe, snapshot, renderPrometheus });
}

module.exports = {
  createRequestMetrics,
  createRealtimeMetrics,
  normalizeRoute,
  DEFAULT_BUCKETS_MS,
  REALTIME_COUNTERS,
  REALTIME_GAUGES,
  REALTIME_HISTOGRAMS
};
