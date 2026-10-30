# SystemFabric Operations Guide

## Local startup

1. Use Node.js `>=22.23.4`.
2. Copy `.env.example` to `.env`; replace all example secrets.
3. Start PostgreSQL: `docker compose up -d postgres`. Optional local Memgraph: `docker compose --profile graph up -d memgraph`.
4. Run `npm install` after generating a reviewed package lockfile in a network-enabled environment. The lockfile is absent from this source snapshot because generation timed out in the build environment; production should use `npm ci`.
5. Run `npm run migrate`.
6. Set `SYSTEMFABRIC_ADMIN_EMAIL`, `SYSTEMFABRIC_ADMIN_PASSWORD`, and the site name/slug; run `npm run bootstrap:owner` once.
7. Start API with `npm start`, then open `http://127.0.0.1:8787/admin`.
8. Run `npm run start:worker` and `npm run start:scheduler` separately when using the outbox or scheduled publishing.

## Production configuration gates

`NODE_ENV=production` startup requires `DATABASE_URL`, `SESSION_COOKIE_SECURE=true`, and a reviewed AI provider or the explicit mock-only exception. This startup check is a necessary guard, not a full production readiness validation. Put the API behind HTTPS; keep database and graph ports private; configure backup policies, rate limits, metrics, egress policy, secrets, logs, and reverse-proxy trust.

Use different database identities for migration and runtime. Grant the runtime only the least privilege it needs. Do not assume `DATABASE_URL` can use a superuser in production. Back up PostgreSQL, media storage and relevant deployment/configuration manifests; test restores regularly.

## Background processes

- **Outbox worker** (`npm run start:worker`): consumes the persisted `graph.projection.v1` consumer group from PostgreSQL and applies allow-listed content, workflow-status, taxonomy and relationship events to Memgraph. Requires migrations 0010–0013. Delivery attempts and dead letters live in `outbox_deliveries`; the source `outbox_events` rows remain the replay source. Configure `SYSTEMFABRIC_GRAPH_CONSUMER_GROUP`, batch/dispatch sizes, lease duration, max attempts and poll interval through the `SYSTEMFABRIC_GRAPH_*` variables when needed. Monitor group backlog, retries and dead letters; event groups have independent subscriptions and must not be treated as authorization controls.
- **Shared presence (preview)**: use a Redis-protocol-compatible service such as Memurai or Redis. Set `SYSTEMFABRIC_REALTIME_ENABLED=true`, `SYSTEMFABRIC_PRESENCE_STORE=redis` and `SYSTEMFABRIC_PRESENCE_REDIS_URL`; tune `SYSTEMFABRIC_PRESENCE_LEASE_MS`, `SYSTEMFABRIC_PRESENCE_MAX_SESSIONS_PER_SITE` and `SYSTEMFABRIC_PRESENCE_EXPIRY_RETENTION_MS` within their documented bounds. Redis connection is required at API startup and failures return 503; there is no silent memory fallback. Keep Redis private, authenticated and TLS-protected outside localhost. This shares presence snapshots and relays only site-scoped `presence.refresh` invalidations through Redis Pub/Sub; each receiving API hub rechecks local SSE subscriber authorization. Lease-expiry invalidations are lazy and are published when a site read/heartbeat discovers stale leases. The standalone API entry point is not production-certified for real-time use.
- **Scheduler** (`npm run start:scheduler`): publishes due approved content. Multiple workers use row locking and `SKIP LOCKED`; still verify concurrency under your deployment configuration.
- **Plugin runner** (`npm run start:plugin-runner`): run only on a separate private host or isolated execution environment. Configure `PLUGIN_RUNNER_TOKEN` with at least 32 random characters and `SYSTEMFABRIC_PLUGIN_ALLOWED_IMAGES` with explicit immutable image references. Only expose it to the API over private TLS or private network. Do not expose the runner port (default 9090) publicly.

## Plugin runner isolation

The execution runner invokes Docker/Podman with no network, read-only root, `cap-drop=ALL`, `no-new-privileges`, non-root UID, pids limit, memory/CPU limits, bounded tmpfs, timeout, and bounded JSON input/output. These controls reduce exposure but do not eliminate container-escape risk. Do not mount the Docker socket into the public API service. Use a hardened runtime (e.g. gVisor/Kata where appropriate), dedicated host/VM, deny-by-default egress, minimal host filesystem, per-image allowlist, image provenance/signature checks and security monitoring. The archive inspection library is not an automatic archive-to-OCI builder.

## Observability

Collect request IDs, response status, latency, content IDs, workflow transitions, outbox queue age/depth, projection retry/failure count, scheduled-publish failures, plugin invocation duration/timeout, AI provider error and quota events, cache hit/miss and database pool metrics. Redact content, passwords, cookies, session tokens, invitation tokens and provider keys. Prompt logging is disabled by default; do not enable it without data classification and retention approval.

## Before each release

- Run `npm run check` on the supported Node version and `npm test` with the reviewed lockfile.
- Apply migrations to a disposable clean database and upgrade from the previous released schema.
- Run live PostgreSQL and Memgraph tests, graph outage/replay tests, and scheduler concurrency tests.
- Run tenant-boundary and capability tests for every API route.
- Scan dependencies and images, generate an SBOM, inspect plugin supply-chain provenance, and rotate secrets as needed.
- Perform accessibility and browser checks for the editor; test upload limits, MIME spoofing, CSP and iframe sandboxing.
- Run load/soak and resource-exhaustion tests, then verify backups by restore.
- Close security review findings and obtain release sign-off. Do not infer production readiness from unit-test status alone.


## Platform library, billing and cloud operations (0.5.0)

- Set `LIBRARY_STORAGE_PROVIDER=local` for development; multi-instance deployments must configure a durable shared object store. Set strict object access policies and avoid CDN caching for private assets.
- Install and test optional `katex`, `sharp`, and FFmpeg only in controlled builds. Keep optimization bounded and move expensive conversions to workers. Derivatives are separate from originals.
- Use Stripe test-mode credentials, register the webhook, test duplicate/out-of-order/failed events and inventory recovery, and only then consider live mode. Never store cardholder data in SystemFabric.
- Cloud connection metadata records references; provider connectivity, role grants, encryption, retention and delete behavior need an actual deployment probe. Do not interpret `configured` as `healthy`.
- The built-in firewall is application-level only. Put SystemFabric behind a correctly configured TLS reverse proxy and managed edge/WAF/DDoS controls where exposure requires it.
- Use `npm run reconcile:library` to run the local object reconciler in dry-run mode; inspect the candidate list before any `--apply` run. It does not clean remote object stores. Filesystem or cloud-object writes do not share an atomic transaction with PostgreSQL.
- Configure `LIBRARY_MALWARE_SCANNER=clamdscan` with an independently managed ClamAV service for production uploads. Uploads are denied in production if scanning is not configured. Existing assets are not automatically cleared by the new scan schema; apply a controlled rescan/quarantine procedure.
- Cloud connection test routes perform read-only provider probes. A successful probe confirms the configured identity can perform that operation at that time; it does not prove object upload/delete policies, encryption, retention, lifecycle, or CDN behavior.
