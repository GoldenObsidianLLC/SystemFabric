# F1.8 Distributed Controls and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authenticated duplex presence transport, distributed connection quotas, and bounded recovery/telemetry without claiming durable replay.

**Architecture:** Add a quota module with memory and Redis adapters. Reuse the existing HTTP server for authenticated WebSocket upgrades through `ws`, preserve SSE, and define snapshot refresh as the reconnect contract. Keep PostgreSQL untouched and Redis Pub/Sub ephemeral.

**Tech Stack:** Node.js 22+, `ws@8.22.0`, `redis@6.3.1`, node:test.

**Spec:** `docs/superpowers/specs/2026-10-30-f1-8-distributed-controls-recovery-design.md`

## Global Constraints
- Do not edit `.env`, connect to or modify the primary database, or apply migrations.
- Production real-time requires injected distributed hub, presence and connection-quota adapters.
- No unbounded queues, high-cardinality metric labels, credentials in URLs, or generic client publish.
- Redis quota acquisition fails closed; presence invalidation is best-effort with degraded telemetry.
- Reconnect refetches authoritative presence; do not advertise durable replay.

## Review Focus
- Redis disconnect during heartbeat: local refresh still reaches local subscribers and remote degradation is visible.
- Process crash: lease expiry frees the stale quota slot.
- Partial lease or duplicate connection identity: global/site/principal indexes remain atomic.
- Cross-origin cookie-authenticated upgrade: reject before the WebSocket handshake.
- Oversized, binary, malformed or high-rate commands: reject without memory growth or unauthorized writes.

---

### Task 1: Connection quota leases

**Files:** create `packages/realtime/src/connection-quota.js`; modify `packages/realtime/src/index.js`; test `test/realtime-controls.test.js`.

**Interfaces:** `createMemoryRealtimeConnectionLimiter(options)`, `createRedisRealtimeConnectionLimiter({ url, limits, leaseMs, createClient, now, metrics })`; limiter exposes `acquire({ siteId, principalId })` and `close()`; acquired lease exposes `renew()` and `release()`.

- [x] Write tests for global/site/principal rejection, renewal, release, crash expiry, and Redis atomic operations.
- [x] Run tests and verify expected missing-interface failures.
- [x] Implement the memory and Redis adapters; hash principal/site identifiers in Redis key names.
- [x] Run focused quota tests.

### Task 2: Relay recovery and fan-out telemetry

**Files:** modify `packages/realtime/src/redis-realtime.js`, `packages/realtime/src/event-hub.js`, `packages/observability/src/metrics.js`; test `test/redis-realtime.test.js` and `test/realtime-observability.test.js`.

- [x] Add failure-injection tests proving local presence delivery survives Redis publish interruption.
- [x] Add bounded relay state gauges and fan-out/Redis latency histograms.
- [x] Implement local-first presence publication and relay state telemetry.
- [x] Run focused tests.

### Task 3: WebSocket protocol and gateway

**Files:** create `packages/realtime/src/websocket-gateway.js` and `packages/realtime/src/realtime-protocol.js`; modify `packages/realtime/src/sse-gateway.js`, `packages/realtime/src/index.js`, `package.json`, `package-lock.json`; test `test/realtime-websocket.test.js` and `test/realtime.test.js`.

- [x] Write tests for ready negotiation, presence commands, reauthorization, frame/message limits, cleanup, quotas and snapshot-refresh instructions; rely on the existing bounded event-hub overflow test for the shared slow-consumer guard.
- [x] Add direct `ws@8.22.0` dependency.
- [x] Implement no-compression WebSocket transport with bounded frames, ping/pong liveness, safe commands and quota leases.
- [x] Update SSE to acquire/renew/release quota leases and advertise bounded retry/snapshot-refresh behavior.
- [x] Run focused transport tests.

### Task 4: API integration and configuration

**Files:** modify `apps/api/src/server.js` and `.env.example`; test `test/realtime-websocket.test.js` and `test/realtime-observability.test.js`.

- [x] Test authenticated same-origin upgrade, cross-origin/unauthenticated rejection, presence command handling and shutdown cleanup.
- [x] Wire upgrade through existing authentication, firewall, site capability and connection rate-limit checks.
- [x] Use memory quotas only for non-production preview; create Redis quota adapter in standalone Redis mode; require injected distributed quotas in production.
- [x] Add bounded quota configuration and graceful shutdown.
- [x] Run focused API tests.

### Task 5: Documentation and verification

**Files:** modify `docs/REALTIME-FOUNDATION-F1.md`, `docs/REALTIME-AI-ARCHITECTURE.md`, `docs/ROADMAP.md`, `CHANGELOG.md`.

- [x] Document transport, limits, relay degradation, reconnect semantics and production non-goals.
- [x] Mark only evidence-backed F1.8 items complete; retain multi-instance load, external security review and certification as open gates.
- [x] Run `npm run check`, focused transport/Redis tests, `git diff --check` and final git review.
