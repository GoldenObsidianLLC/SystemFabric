# Observability and Trace Correlation

**Status:** Implemented correlation foundation; not an OpenTelemetry deployment or production observability certification.  
**Scope:** API request handling, WebSocket upgrade handling, and the authenticated internal API-to-plugin-runner hop.

## 1. What is implemented

SystemFabric now provides a small, dependency-free trace-correlation layer:

- A request receives the existing validated `x-request-id` (or a generated UUID).
- The API creates a W3C Trace Context **version 00** trace/span context and exposes its trace ID in the `x-trace-id` response header.
- Node.js `AsyncLocalStorage` keeps the current trace context isolated across concurrent asynchronous requests.
- The internal API-to-plugin-runner request forwards `traceparent` and `x-request-id` when a trace context exists.
- The plugin runner adopts the forwarded trace context only after validating the service bearer token, then emits a correlated invocation-completion record.
- The API and plugin runner can emit JSON structured events using a strict field allow-list. API request-completion/access events are optional; safe error events remain enabled.

This is **trace propagation and structured correlation**, not a complete distributed tracing system. No OpenTelemetry SDK, span exporter, OTLP endpoint, collector, trace sampler, automatic database/Redis spans, or third-party AI/payment-provider propagation is installed. Do not describe traces as centrally collected or end-to-end instrumented.

## 2. Trace context trust

The implementation parses only the W3C `traceparent` version 00 form. Unknown versions, malformed identifiers, and all-zero trace/span IDs are ignored. `tracestate` and `baggage` are not implemented.

The API defaults to generating a new trace ID for every incoming request, even when a client supplies a `traceparent` header. A caller-controlled trace ID is not trusted by default.

To retain an upstream trace ID, configure:

```dotenv
SYSTEMFABRIC_TRACE_CONTEXT_TRUST_REMOTE=true
```

Enable this only when a trusted ingress/reverse proxy:
1. Authenticates and controls the upstream path.
2. Removes any client-supplied `traceparent` before adding its own validated header.
3. Prevents direct untrusted access that bypasses that header policy.
4. Has an approved configuration and operational owner.

This setting is a trust decision, not a convenience switch. Keep it `false` unless the deployment can enforce those conditions. Invalid or unsupported upstream headers still result in a newly generated local trace.

The API returns `x-trace-id` and `x-request-id` for correlation. These values are identifiers, not authorization credentials; never use them to grant access or make a tenant decision.

## 3. Structured logging

The structured logger writes JSON records through the logger supplied to the API or plugin-runner factory (the default is the process logger). Records include timestamp, level, service, environment, event name, and validated correlation fields when a trace context exists.

The logger deliberately accepts only a fixed set of fields, including:
- Request, trace, span, and parent-span IDs.
- HTTP method, normalized route group, status, and elapsed time.
- Bounded error code, component, operation, outcome, and error type.

It excludes arbitrary message text and does not accept request bodies, query strings, raw URL paths, IP addresses, authorization headers, cookies, session tokens, site/principal/document/content identifiers, prompts, provider responses, plugin inputs, stack traces, or exception messages. Do not weaken the allow-list to make incident data easier to collect.

### HTTP access events

Optional API request-completion events are disabled by default. Enable them with:

```dotenv
SYSTEMFABRIC_HTTP_ACCESS_LOGS_ENABLED=true
```

When enabled, an event is emitted after the response finishes and contains a normalized route group rather than the raw path. WebSocket upgrade success/rejection events use the same normalized-route and safe-field rules.

Structured API error records are emitted independently of the access-log setting. The plugin runner emits a safe invocation-completion event after an authenticated invoke attempt. These records are local process output until an operator configures a separately reviewed collection system.

## 4. Internal plugin-runner propagation

The API-to-plugin-runner adapter propagates the current `traceparent` and request ID over its configured service-to-service HTTPS request. The request's existing bearer token remains the authentication mechanism.

The plugin runner validates that bearer token before adopting the incoming trace context. It does not accept an unauthenticated caller's trace header as a parent. It logs only outcome/status/duration/correlation/error code; it does not log the plugin image digest, action payload, or execution input.

This propagation is intentionally limited to the trusted internal plugin-runner hop. It does not forward trace context to external AI providers, Stripe, cloud storage, arbitrary webhooks, or user-controlled endpoints.

## 5. Configuration reference

| Setting | Default | Purpose |
|---|---|---|
| `SYSTEMFABRIC_TRACE_CONTEXT_TRUST_REMOTE` | `false` | Accept a valid upstream W3C v00 parent only behind a trusted ingress. |
| `SYSTEMFABRIC_HTTP_ACCESS_LOGS_ENABLED` | `false` | Emit API request-completion events to the injected logger. |
| `SYSTEMFABRIC_METRICS_ENABLED` | `false` | Existing protected metrics endpoint switch. |
| `SYSTEMFABRIC_METRICS_TOKEN` | unset | Existing bearer token for `/metrics`; use a dedicated high-entropy secret and keep the endpoint private. |

The trace-correlation foundation adds no runtime package dependency and no migration.

## 6. Safe deployment and collection

- Keep trace trust disabled until the trusted-proxy header policy has been verified.
- Keep access logging off until the receiver's redaction, access control, and retention policy is approved.
- Keep `/metrics` private and separately bearer-protected; metrics and logs have different access patterns and should not share credentials by default.
- Do not configure log pipelines to capture request/response bodies, headers, prompt text, plugin inputs, cookies, or secrets.
- Use a dedicated log transport and storage policy if centralization is added. Define operator access, encryption, retention, deletion, incident access, and alert ownership before enabling it.
- Do not create metric labels from trace IDs, request IDs, user/site/document IDs, or other high-cardinality values.
- Treat trace IDs as potentially linkable operational metadata. Restrict access and retention according to the deployment's data classification.
- A process-local trace context and console log are not durable telemetry. Process restarts and log collection failures do not affect application correctness.

## 7. Validation

The automated tracing tests verify:
- Valid/invalid W3C v00 parsing and zero-ID rejection.
- Default untrusted-parent behavior and explicit trusted-ingress behavior.
- Concurrent `AsyncLocalStorage` isolation and child span parent linkage.
- Structured logger field allow-list and omission of unapproved sensitive fields.
- API success/error correlation, response trace headers, and opt-in access events.
- Authenticated plugin-runner propagation and refusal to establish a trace for an unauthenticated caller.

These tests establish local behavior. They do not validate a real reverse proxy, distributed collector, OTLP export, centralized retention, or production topology.

## 8. Remaining work

The next observability increments are separate engineering tasks:
- Add OpenTelemetry span instrumentation and an approved exporter/collector integration.
- Instrument PostgreSQL, Redis, outbox/worker, graph projection, and selected internal provider-adapter calls without recording business payloads.
- Implement centralized redacted logging with an approved transport, access policy, retention/deletion controls, and named ownership.
- Validate trace continuity and sampling behavior through the actual deployment ingress and internal service topology.

SystemFabric remains **NOT_PRODUCTION_CERTIFIED / NO-GO** until the independent security, deployment, operational, backup/restore, and release gates are satisfied.
