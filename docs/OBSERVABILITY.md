# Observability and Trace Correlation

**Status:** Optional OpenTelemetry tracing and curated structured-log export, plus an authenticated local-only Collector profile and a vendor-neutral production deployment evidence contract, are implemented. No production collector/backend or data-governance policy is approved; production deployment and certification remain open.
**Scope:** API request handling, WebSocket upgrades, authenticated API-to-plugin-runner calls, PostgreSQL, Redis, outbox delivery, Memgraph projection, scheduler, mail worker, and AI audit events.

## 1. Implemented capabilities

VirgoScorpio Hub combines the F1.13 trace-correlation foundation with the F1.14 OpenTelemetry instrumentation layer:

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
VIRGOSCORPIO_HUB_TRACE_CONTEXT_TRUST_REMOTE=true
~~~

Enable this only when a trusted ingress/reverse proxy removes any caller-supplied `traceparent`, writes its own validated header, and prevents untrusted direct access. This is a security trust decision, not a convenience setting.

The plugin runner accepts the API's `traceparent` only after validating its existing service bearer token. Trace IDs are correlation metadata, never credentials or authorization inputs. Trace context is deliberately not sent to external AI providers, Stripe, cloud storage, webhooks, or user-controlled endpoints.

## 3. Enable OTLP trace export

Tracing is opt-in and disabled by default. VirgoScorpio Hub now includes a **local development collector profile**. Production deployments must still select, deploy, and operate their own collector and trace backend.

### Local development collector

Configure a fresh bearer token and matching application settings:

~~~sh
npm run otel:dev:setup
docker compose --profile observability up -d otel-collector
npm run otel:dev:smoke
~~~

The setup command creates `var/secrets/otel-collector-token.txt` (ignored by Git), restricts the secrets directory to its owner on POSIX hosts, and updates only the OTLP settings in the local `.env`. Run it after your normal local environment setup; when no `.env` exists, it creates a collector-only file rather than copying the rest of `.env.example`. It reuses the generated token on subsequent runs. Rotate it with:

~~~sh
npm run otel:dev:setup -- --rotate
docker compose --profile observability restart otel-collector
~~~

Restart the API, plugin runner, outbox worker, mail worker, and scheduler after changing `.env` so each process reads the new token. View local spans and redacted structured logs with:

~~~sh
docker compose --profile observability logs -f otel-collector
~~~

The reference collector uses the OpenTelemetry Collector Contrib `0.164.0` release image from the [official GHCR release repository](https://github.com/open-telemetry/opentelemetry-collector-releases/pkgs/container/opentelemetry-collector-contrib). The setup script selects a pinned architecture-specific image tag (for example, `0.164.0-amd64` or `0.164.0-arm64`) and fails closed on unsupported architectures. It listens on OTLP/HTTP only, requires bearer authentication, and is published on host loopback `127.0.0.1:4318`. The Compose profile drops capabilities, disables privilege escalation, runs as UID/GID `10001:10001`, mounts configuration and the token read-only, and applies CPU/memory limits. The collector applies a memory limiter before batching and exports traces and logs to the `debug` exporter only.

This local profile is deliberately **ephemeral and development-only**. It does not persist spans or logs, provide a query UI, forward telemetry to a SaaS vendor, or create a production retention policy. It uses HTTP because the receiver is authenticated and bound to host loopback; do not widen this port binding or use the profile on a public host.

### External / production collector

For a deployment-managed collector, configure a private OTLP/HTTP endpoint:

~~~dotenv
VIRGOSCORPIO_HUB_OTEL_ENABLED=true
VIRGOSCORPIO_HUB_OTEL_EXPORTER_ENDPOINT=https://otel-collector.internal:4318/v1/traces
VIRGOSCORPIO_HUB_OTEL_EXPORTER_HEADERS_JSON=
VIRGOSCORPIO_HUB_OTEL_SAMPLE_RATIO=0.1
VIRGOSCORPIO_HUB_OTEL_EXPORT_TIMEOUT_MS=5000
VIRGOSCORPIO_HUB_OTEL_ALLOW_INSECURE_HTTP=false
~~~

An endpoint with no path is normalized to `/v1/traces`. Other paths, URL credentials, query strings, and fragments are rejected. HTTPS is required unless `VIRGOSCORPIO_HUB_OTEL_ALLOW_INSECURE_HTTP=true` is explicitly set for the isolated local profile.

When collector authentication is required, inject `VIRGOSCORPIO_HUB_OTEL_EXPORTER_HEADERS_JSON` through the deployment's secret manager. The value must be a JSON object and supports only `authorization` and `x-api-key` headers. Never commit credentials to `.env.example` or source control. The local setup script creates this value automatically; production should use the approved secret-delivery mechanism.

Configure the same endpoint and authentication policy independently for each process that should emit spans: API, plugin runner, outbox worker, and scheduler. Each process advertises a stable service name: `virgoscorpio-hub-api`, `virgoscorpio-hub-plugin-runner`, `virgoscorpio-hub-outbox-worker`, or `virgoscorpio-hub-scheduler`.

A production collector should use TLS (prefer mTLS for service identity where supported), explicit receiver authentication, restricted network ingress, bounded memory, batching, an approved durable/retry queue, and an exporter to the deployment's selected backend. Restrict collector health/diagnostic endpoints to management networks. Do not use the local debug exporter as a production backend. The deployment decisions and required evidence are defined in [Production Observability Deployment Contract](OBSERVABILITY-DEPLOYMENT.md); no sample value in the local profile is production approval.

## 4. Configuration reference

| Setting | Default | Purpose |
|---|---:|---|
| `VIRGOSCORPIO_HUB_OTEL_ENABLED` | `false` | Initialize the OpenTelemetry trace provider and OTLP/HTTP exporter. |
| `VIRGOSCORPIO_HUB_OTEL_EXPORTER_ENDPOINT` | unset | Private OTLP/HTTP endpoint; required when tracing is enabled. |
| `VIRGOSCORPIO_HUB_OTEL_EXPORTER_HEADERS_JSON` | unset | Secret-injected JSON object limited to `authorization` and `x-api-key`. |
| `VIRGOSCORPIO_HUB_OTEL_AUTH_TOKEN_FILE` | `./var/secrets/otel-collector-token.txt` | Local Compose profile secret source path; created by `npm run otel:dev:setup`. |
| `VIRGOSCORPIO_HUB_OTEL_SAMPLE_RATIO` | `0.1` | Root trace sampling ratio from 0 to 1; parent-based sampling respects the upstream sampled flag. |
| `VIRGOSCORPIO_HUB_OTEL_EXPORT_TIMEOUT_MS` | `5000` | Bounded traces/logs export timeout (250–30,000 ms). |
| `VIRGOSCORPIO_HUB_OTEL_ALLOW_INSECURE_HTTP` | `false` | Explicitly permit HTTP transport; use only on isolated private networks. |
| `VIRGOSCORPIO_HUB_OTEL_LOGS_ENABLED` | `false` | Independently enable the curated OTLP Logs pipeline. |
| `VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT` | unset | Private OTLP/HTTP Logs endpoint; normalized to `/v1/logs`. |
| `VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_HEADERS_JSON` | unset | Optional separate secret-injected log exporter headers; falls back to trace headers when unset. |
| `VIRGOSCORPIO_HUB_TRACE_CONTEXT_TRUST_REMOTE` | `false` | Accept a valid upstream W3C v00 parent only behind a trusted ingress. |
| `VIRGOSCORPIO_HUB_HTTP_ACCESS_LOGS_ENABLED` | `false` | Emit normalized API request-completion events to the injected logger. |
| `VIRGOSCORPIO_HUB_METRICS_ENABLED` | `false` | Existing protected metrics endpoint switch. |
| `VIRGOSCORPIO_HUB_METRICS_TOKEN` | unset | Dedicated bearer token for the private `/metrics` endpoint. |

The trace and log SDKs are independently opt-in. The Logs SDK uses a bounded batch queue and batch size; exporter failures are best-effort and must not become application request dependencies. Process shutdown attempts to flush both queues. The local Compose collector uses only a debug exporter and stores no trace or log history. OTLP metrics are not added by this increment.

## 5. Attribute and data-safety policy

Span attributes are filtered through a strict allow-list. Current attributes are limited to service/component/operation/outcome identifiers, HTTP method/status, database system/operation, and bounded error type/code. SQL statement text, bind values, Redis keys/channels/scripts/arguments, graph query text/parameters, content, prompts, response bodies, tokens, cookies, IP addresses, user/site/document/content IDs, and arbitrary exception messages are excluded.

Span names and operation identifiers must be bounded, low-cardinality identifiers. Do not add request IDs, trace IDs, user/site/document IDs, content IDs, raw routes, query strings, or event payload values as metric labels or span attributes. Error status uses a generic message; do not put exception messages or stack traces into span attributes.

Trace data remains potentially linkable operational metadata. Restrict collector access, encryption, retention, deletion, and incident access under the deployment's data-classification policy. Sample conservatively and measure exporter queue pressure before raising the sample ratio.

## 6. Structured logging and access events

The API, plugin runner, outbox worker, mail worker, and scheduler share the allow-listed JSON structured logger. Selected AI audit events are projected into this logger without actor, provider, model, prompt, or content values. It accepts request/trace/span/parent-span IDs, HTTP method, normalized route, status, elapsed time, bounded error code/type, component, operation, outcome, and a small set of bounded operational counters. It excludes message text, request bodies, raw paths/query strings, IP addresses, authorization headers, cookies, session tokens, business identifiers, prompts, provider responses, plugin inputs, stack traces, and exception messages.

Optional API request-completion events remain disabled by default:

~~~dotenv
VIRGOSCORPIO_HUB_HTTP_ACCESS_LOGS_ENABLED=true
~~~

Safe structured events are emitted locally as JSON and, when independently enabled, sent to the OTLP Logs exporter. Log records contain the event key as their body and only allow-listed attributes; the request-scoped trace/span context is attached as OTLP correlation metadata. The log provider is deliberately not registered globally, so third-party libraries and arbitrary `console` output are not automatically captured. API request-completion events remain disabled unless explicitly enabled.

### OTLP Logs transport

Set the separate log-export switch and a deployment-managed endpoint:

~~~dotenv
VIRGOSCORPIO_HUB_OTEL_LOGS_ENABLED=true
VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_ENDPOINT=https://otel-collector.internal:4318/v1/logs
VIRGOSCORPIO_HUB_OTEL_LOGS_EXPORTER_HEADERS_JSON=
~~~

The endpoint must use HTTPS and exactly `/v1/logs` (a root endpoint is normalized); URL credentials, query strings, fragments, and other paths are rejected. The log-specific header setting accepts the same narrow `authorization` and `x-api-key` allow-list as trace export. When the log-specific value is unset, trace exporter headers are reused; inject either value through the deployment secret manager and never commit it. The shared export timeout and explicit private-network HTTP override apply to both pipelines. OTLP log export is independent of trace export and disabled by default.

The SDK uses bounded batching and asynchronous export. Only structured VirgoScorpio Hub events passed through `createStructuredLogger` enter the OTLP pipeline; raw `console` output, prompts, request/response bodies, SQL text, arbitrary exception messages/stacks, and application payloads are not collected. The log event key is the body, avoiding arbitrary message text. Correlation is carried in the OTLP log record's trace/span context when available.

The F1.15 local Collector profile now accepts both traces and logs with bearer authentication and exports each to the ephemeral `debug` exporter. The smoke command tests HTTP 401 for unauthenticated requests and HTTP 200 for authenticated traces and log records. This proves transport and receiver authentication only: it does not make logs centrally searchable, durable, access-controlled, or retained.

This increment implements a vendor-neutral transport interface, **not production log centralization**. A deployment owner must still approve the receiving backend and define authenticated/encrypted ingress, role-based access, audit of log access, retention and deletion deadlines, legal holds where applicable, incident access, data residency/classification, and named technical/data owners. Do not infer a policy or retention period from the local development profile.

## 7. Validation

Automated tests verify:
- Disabled-by-default configuration, endpoint normalization, TLS/HTTP guardrails, bounded sampling/timeouts, and narrow exporter-header parsing.
- Span attribute allow-listing and SQL operation classification without query text or values.
- Server, PostgreSQL promise/callback, Redis, outbox, graph-projection, and Memgraph span creation and parent-child relationships.
- Error status/code recording without the exception message.
- Callback-style PostgreSQL queries remain functional when tracing is disabled.
- Local collector setup is idempotent, stores the generated token outside source control, supports explicit rotation, preserves unrelated `.env` values, and rejects malformed/duplicate configuration.
- The collector smoke command verifies that unauthenticated OTLP trace and log requests receive HTTP 401, while authenticated OTLP JSON span/log submissions receive HTTP 200; it refuses non-loopback destinations and mismatched credentials.
- The Compose collector reference is checked for bearer authentication, loopback-only publishing, least-privilege container settings, bounded memory, batching, and traces/logs debug pipelines.
- F1.13 tests continue to verify W3C v00 validation, remote-parent trust gating, request isolation, structured-log redaction, and authenticated plugin-runner trace propagation.

The repository validation and local Docker-host smoke test pass. A real PostgreSQL/Redis/Memgraph deployment, trusted ingress, production OTLP receiver/backend, cross-process sampling policy, throughput/queue behavior, durable storage, and production network path still require environment-specific verification.

## 8. Remaining work and production boundary

- Select, deploy, secure, and load-test the production OTLP collector and trace/log backends using the [deployment evidence contract](OBSERVABILITY-DEPLOYMENT.md); define durable delivery and each receiving service's ownership.
- Independently verify the manifest's external evidence references and approvals, then validate trace/log exporter retries, queue saturation, sampling, TLS/mTLS, secret rotation, retention, deletion, and shutdown behavior in the actual deployment topology.
- Complete production log centralization only after selecting an approved backend and defining log access controls, retention/deletion, audit, and named ownership. The current OTLP transport and local debug exporter do not satisfy these governance requirements.
- Add additional spans only where they provide actionable operational value without exporting business payloads.

VirgoScorpio Hub remains **NOT_PRODUCTION_CERTIFIED / NO-GO** until the independent security, deployment, operational, backup/restore, and release gates are satisfied. Optional trace export is not a production-readiness assertion.
