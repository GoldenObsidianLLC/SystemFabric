# Observability and Trace Correlation

**Status:** Optional OpenTelemetry tracing and an authenticated local-only Collector profile are implemented; production collector/backend deployment and observability certification remain open.
**Scope:** API request handling, WebSocket upgrades, authenticated API-to-plugin-runner calls, PostgreSQL, Redis, outbox delivery, Memgraph projection, and scheduler operations.

## 1. Implemented capabilities

SystemFabric combines the F1.13 trace-correlation foundation with the F1.14 OpenTelemetry instrumentation layer:

- The API validates or generates a request ID, creates a W3C Trace Context **version 00** trace, and returns `x-request-id` and `x-trace-id`.
- Node.js `AsyncLocalStorage` preserves request context across asynchronous work; the OpenTelemetry context manager carries span parentage.
- The API creates HTTP server spans; the authenticated plugin runner creates correlated server spans for service invocations.
- The internal API-to-plugin-runner adapter creates a client span and forwards `traceparent` and `x-request-id`. The runner adopts the parent only after service-token authentication.
- PostgreSQL query spans classify only the SQL operation (`select`, `insert`, `update`, `delete`, or `other`). SQL text, bind values, and query parameters are never span attributes.
- Redis spans cover the explicitly wrapped client methods used by the realtime adapters. Command arguments, keys, channels, scripts, and payloads are never span attributes.
- Outbox run/event spans and graph-projection/Memgraph spans correlate a worker delivery to its projection operations.
- Scheduler spans cover due-content publishing and checkout reconciliation.
- A manual, allow-listed span-attribute policy limits exported attributes to bounded service, component, operation, outcome, HTTP status/method, database operation/system, and bounded error identifiers.

This is manual instrumentation, not blanket automatic instrumentation. It does not enable generic HTTP, PostgreSQL, Redis, Neo4j, filesystem, AI-provider, or payment-provider auto-instrumentation.

## 2. Trace context trust

The implementation parses only W3C `traceparent` version 00. Unknown versions, malformed identifiers, and all-zero trace/span IDs are ignored. `tracestate` and `baggage` are not implemented.

The API defaults to generating a new trace for every incoming request. To retain an upstream parent, set:

~~~dotenv
SYSTEMFABRIC_TRACE_CONTEXT_TRUST_REMOTE=true
~~~

Enable this only when a trusted ingress/reverse proxy removes any caller-supplied `traceparent`, writes its own validated header, and prevents untrusted direct access. This is a security trust decision, not a convenience setting.

The plugin runner accepts the API's `traceparent` only after validating its existing service bearer token. Trace IDs are correlation metadata, never credentials or authorization inputs. Trace context is deliberately not sent to external AI providers, Stripe, cloud storage, webhooks, or user-controlled endpoints.

## 3. Enable OTLP trace export

Tracing is opt-in and disabled by default. SystemFabric now includes a **local development collector profile**. Production deployments must still select, deploy, and operate their own collector and trace backend.

### Local development collector

Configure a fresh bearer token and matching application settings:

~~~sh
npm run otel:dev:setup
docker compose --profile observability up -d otel-collector
npm run otel:dev:smoke
~~~

The setup command creates `var/secrets/otel-collector-token.txt` (ignored by Git) and updates only the OTLP settings in the local `.env`. Run it after your normal local environment setup; when no `.env` exists, it creates a collector-only file rather than copying the rest of `.env.example`. It reuses the generated token on subsequent runs. Rotate it with:

~~~sh
npm run otel:dev:setup -- --rotate
docker compose --profile observability restart otel-collector
~~~

Restart the API, plugin runner, worker, and scheduler after changing `.env` so each process reads the new token. View local spans with:

~~~sh
docker compose --profile observability logs -f otel-collector
~~~

The reference collector uses the OpenTelemetry Collector Contrib `0.164.0` release image from the [official GHCR release repository](https://github.com/open-telemetry/opentelemetry-collector-releases/pkgs/container/opentelemetry-collector-contrib). The setup script selects a pinned architecture-specific image tag (for example, `0.164.0-amd64` or `0.164.0-arm64`) and fails closed on unsupported architectures. It listens on OTLP/HTTP only, requires bearer authentication, and is published on host loopback `127.0.0.1:4318`. The Compose profile drops capabilities, disables privilege escalation, runs as UID/GID `10001:10001`, mounts configuration and the token read-only, and applies CPU/memory limits. The collector applies a memory limiter before batching and exports to the `debug` exporter only.

This local profile is deliberately **ephemeral and development-only**. It does not persist spans, provide a query UI, forward telemetry to a SaaS vendor, or create a production retention policy. It uses HTTP because the receiver is authenticated and bound to host loopback; do not widen this port binding or use the profile on a public host.

### External / production collector

For a deployment-managed collector, configure a private OTLP/HTTP endpoint:

~~~dotenv
SYSTEMFABRIC_OTEL_ENABLED=true
SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT=https://otel-collector.internal:4318/v1/traces
SYSTEMFABRIC_OTEL_EXPORTER_HEADERS_JSON=
SYSTEMFABRIC_OTEL_SAMPLE_RATIO=0.1
SYSTEMFABRIC_OTEL_EXPORT_TIMEOUT_MS=5000
SYSTEMFABRIC_OTEL_ALLOW_INSECURE_HTTP=false
~~~

An endpoint with no path is normalized to `/v1/traces`. Other paths, URL credentials, query strings, and fragments are rejected. HTTPS is required unless `SYSTEMFABRIC_OTEL_ALLOW_INSECURE_HTTP=true` is explicitly set for the isolated local profile.

When collector authentication is required, inject `SYSTEMFABRIC_OTEL_EXPORTER_HEADERS_JSON` through the deployment's secret manager. The value must be a JSON object and supports only `authorization` and `x-api-key` headers. Never commit credentials to `.env.example` or source control. The local setup script creates this value automatically; production should use the approved secret-delivery mechanism.

Configure the same endpoint and authentication policy independently for each process that should emit spans: API, plugin runner, outbox worker, and scheduler. Each process advertises a stable service name: `systemfabric-api`, `systemfabric-plugin-runner`, `systemfabric-outbox-worker`, or `systemfabric-scheduler`.

A production collector should use TLS (prefer mTLS for service identity where supported), explicit receiver authentication, restricted network ingress, bounded memory, batching, an approved durable/retry queue, and an exporter to the deployment's selected backend. Restrict collector health/diagnostic endpoints to management networks. Do not use the local debug exporter as a production backend.

## 4. Configuration reference

| Setting | Default | Purpose |
|---|---:|---|
| `SYSTEMFABRIC_OTEL_ENABLED` | `false` | Initialize the OpenTelemetry trace provider and OTLP/HTTP exporter. |
| `SYSTEMFABRIC_OTEL_EXPORTER_ENDPOINT` | unset | Private OTLP/HTTP endpoint; required when tracing is enabled. |
| `SYSTEMFABRIC_OTEL_EXPORTER_HEADERS_JSON` | unset | Secret-injected JSON object limited to `authorization` and `x-api-key`. |
| `SYSTEMFABRIC_OTEL_AUTH_TOKEN_FILE` | `./var/secrets/otel-collector-token.txt` | Local Compose profile secret source path; created by `npm run otel:dev:setup`. |
| `SYSTEMFABRIC_OTEL_SAMPLE_RATIO` | `0.1` | Root trace sampling ratio from 0 to 1; parent-based sampling respects the upstream sampled flag. |
| `SYSTEMFABRIC_OTEL_EXPORT_TIMEOUT_MS` | `5000` | Bounded export timeout (250–30,000 ms). |
| `SYSTEMFABRIC_OTEL_ALLOW_INSECURE_HTTP` | `false` | Explicitly permit HTTP transport; use only on isolated private networks. |
| `SYSTEMFABRIC_TRACE_CONTEXT_TRUST_REMOTE` | `false` | Accept a valid upstream W3C v00 parent only behind a trusted ingress. |
| `SYSTEMFABRIC_HTTP_ACCESS_LOGS_ENABLED` | `false` | Emit normalized API request-completion events to the injected logger. |
| `SYSTEMFABRIC_METRICS_ENABLED` | `false` | Existing protected metrics endpoint switch. |
| `SYSTEMFABRIC_METRICS_TOKEN` | unset | Dedicated bearer token for the private `/metrics` endpoint. |

The SDK is configured for tracing only. Metrics and logs continue to use the existing SystemFabric mechanisms; this change does not add OTLP metrics or log exporters. Sampling uses a bounded batch queue and batch size. Export is asynchronous so collector/network failures do not become application request dependencies; process shutdown attempts to flush the trace queue. The local Compose collector uses only a debug exporter; it stores no trace history.

## 5. Attribute and data-safety policy

Span attributes are filtered through a strict allow-list. Current attributes are limited to service/component/operation/outcome identifiers, HTTP method/status, database system/operation, and bounded error type/code. SQL statement text, bind values, Redis keys/channels/scripts/arguments, graph query text/parameters, content, prompts, response bodies, tokens, cookies, IP addresses, user/site/document/content IDs, and arbitrary exception messages are excluded.

Span names and operation identifiers must be bounded, low-cardinality identifiers. Do not add request IDs, trace IDs, user/site/document IDs, content IDs, raw routes, query strings, or event payload values as metric labels or span attributes. Error status uses a generic message; do not put exception messages or stack traces into span attributes.

Trace data remains potentially linkable operational metadata. Restrict collector access, encryption, retention, deletion, and incident access under the deployment's data-classification policy. Sample conservatively and measure exporter queue pressure before raising the sample ratio.

## 6. Structured logging and access events

The API and plugin runner retain their allow-listed JSON structured logger. It accepts request/trace/span/parent-span IDs, HTTP method, normalized route, status, elapsed time, bounded error code/type, component, operation, and outcome. It excludes message text, request bodies, raw paths/query strings, IP addresses, authorization headers, cookies, session tokens, business identifiers, prompts, provider responses, plugin inputs, stack traces, and exception messages.

Optional API request-completion events remain disabled by default:

~~~dotenv
SYSTEMFABRIC_HTTP_ACCESS_LOGS_ENABLED=true
~~~

Safe API error records and authenticated plugin-runner invocation completion events are separate from the OTLP trace exporter. This increment does **not** centralize logs or establish their retention/access policy.

## 7. Validation

Automated tests verify:
- Disabled-by-default configuration, endpoint normalization, TLS/HTTP guardrails, bounded sampling/timeouts, and narrow exporter-header parsing.
- Span attribute allow-listing and SQL operation classification without query text or values.
- Server, PostgreSQL promise/callback, Redis, outbox, graph-projection, and Memgraph span creation and parent-child relationships.
- Error status/code recording without the exception message.
- Callback-style PostgreSQL queries remain functional when tracing is disabled.
- Local collector setup is idempotent, stores the generated token outside source control, supports explicit rotation, preserves unrelated `.env` values, and rejects malformed/duplicate configuration.
- The collector smoke command verifies that unauthenticated OTLP requests receive HTTP 401 and a valid local OTLP JSON span receives HTTP 200; it refuses non-loopback destinations and mismatched credentials.
- The Compose collector reference is checked for bearer authentication, loopback-only publishing, least-privilege container settings, bounded memory, batching, and a trace-only debug pipeline.
- F1.13 tests continue to verify W3C v00 validation, remote-parent trust gating, request isolation, structured-log redaction, and authenticated plugin-runner trace propagation.

The repository validation and local Docker-host smoke test pass. A real PostgreSQL/Redis/Memgraph deployment, trusted ingress, production OTLP receiver/backend, cross-process sampling policy, throughput/queue behavior, durable storage, and production network path still require environment-specific verification.

## 8. Remaining work and production boundary

- Select, deploy, secure, and load-test the production OTLP collector and trace backend; define durable delivery and the receiving service's ownership.
- Validate exporter retries, queue saturation, sampling, TLS/mTLS, secret rotation, retention, and shutdown behavior in the actual deployment topology.
- Add centralized redacted log transport with access controls, retention/deletion, and named ownership.
- Add additional spans only where they provide actionable operational value without exporting business payloads.

SystemFabric remains **NOT_PRODUCTION_CERTIFIED / NO-GO** until the independent security, deployment, operational, backup/restore, and release gates are satisfied. Optional trace export is not a production-readiness assertion.
