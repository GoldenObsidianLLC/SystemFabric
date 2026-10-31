# F1.10 Cross-instance Collaborative Document Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver draft collaboration operations across API instances through a strictly bounded Redis Pub/Sub document channel, while PostgreSQL sequence reconciliation repairs dropped or reordered notifications.

**Architecture:** Extend the existing Redis realtime bridge with an isolated document channel family, validator, inbound queue and metrics. Route REST and WebSocket commits through one document-publication interface. Use the existing WebSocket heartbeat as a single-flight PostgreSQL reconciliation fallback so dropped notifications converge without a second per-document timer.

**Tech Stack:** Node.js 26, CommonJS, `redis` client, Redis Pub/Sub, existing realtime hub/WebSocket gateway, PostgreSQL-backed `getCollaborationSync`, `node:test`, Playwright/Chrome.

**Spec:** `docs/superpowers/specs/2026-10-31-f1-10-cross-instance-collaboration-design.md`

## Global Constraints

- PostgreSQL remains the canonical operation sequencer, materialized draft, revision/workflow/outbox store and reconnect source; Redis Pub/Sub remains ephemeral.
- Preserve the existing presence and authorization envelope validators, 4 KiB default message limit, channels and inbound queue.
- Document operation envelopes are limited to 16 KiB; nested F1.9 operations remain limited to 12 KiB; origin IDs are null or server-generated UUIDs.
- Use channel `<channelPrefix>:<siteId>:document:<contentId>` and pattern `<channelPrefix>:*:document:*`.
- Document ingress uses an independent bounded queue (default 1,024 messages; validated maximum 10,000).
- Do not relay bearer/session tokens, actor IDs, emails, presence records, arbitrary page snapshots, database rows or operation logs.
- Redis publish failure after a PostgreSQL commit must not fail the edit acknowledgement or undo the local hub publication.
- Preserve strict site/document authorization, server-generated origin echo suppression, monotonic sequence delivery, WebSocket 16 KiB frames, 60 messages/minute and 1 MiB outbound backpressure.
- Heartbeat reconciliation is single-flight per document subscription; it must not create a second timer per document or overlapping database sync requests.
- Real Redis integration uses only `SYSTEMFABRIC_RUN_REDIS_INTEGRATION=true` plus `SYSTEMFABRIC_TEST_REDIS_URL` pointing at an approved local Redis endpoint; do not use application Redis credentials by default or access any primary database.
- No new package dependency and no database migration.

## Review Focus

- A channel/envelope with a valid site UUID but a different content UUID must be rejected before local hub publication. Test in Task 1.
- A document envelope carrying an unknown field, malformed operation, oversized UTF-8 body or invalid origin UUID must be rejected without exposing operation text to logs. Test in Task 1.
- A REST or WebSocket edit already committed to PostgreSQL must still be acknowledged when Redis publication fails; only the remote fan-out status is degraded. Test in Task 2.
- A final Pub/Sub notification lost while the browser socket remains connected and no later operation occurs must converge on heartbeat reconciliation. Test in Task 3.
- Concurrent Pub/Sub gap recovery and heartbeat reconciliation for the same document must not produce duplicate delivery, race the cursor backwards or create unbounded overlapping database queries. Test in Task 3 and Task 4.

---

### Task 1: Strict Redis document channel and independent ingress

**Files:**
- Modify: `packages/realtime/src/redis-realtime.js`
- Modify: `packages/observability/src/metrics.js`
- Test: `test/redis-realtime.test.js`
- Test: `test/realtime.test.js`

**Interfaces:**
- Consumes: F1.9 `validateCollaborationOperation(operation)` and `createRealtimeHub().publish({ siteId, topic, payload, eventId, occurredAt })`.
- Produces:
  - `validateDocumentEnvelope(value, expectedSiteId, expectedContentId, maxMessageBytes)` returning a validated event or `null`.
  - `bridge.publishDocumentOperation({ siteId, contentId, sequence, originConnectionId = null, operation })` returning local delivery counts plus `relayPublished` and `degraded`.
  - Separate document receive queue and fixed-name document relay metrics. Existing `publish` remains presence-only.

- [x] **Step 1: Write failing envelope and bridge tests**

Add tests with names:
- `Redis document envelope validation enforces channel scope and the F1.9 operation schema`
- `Redis document channel fans out only to the matching site and document across independent hubs`
- `Redis document queue saturation does not delay authorization invalidation`
- `Redis document publish is local-first and reports remote relay degradation`

Assertions cover: exact schema; site/content/channel equality; UUID/timestamp/sequence/origin checks; unknown-key rejection; invalid/oversized operation rejection; 16 KiB total limit; two independently attached hubs; no cross-site or cross-document delivery; local delivery before a simulated Redis publish error; and a bounded document queue that does not prevent authorization invalidations from draining.

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test test/redis-realtime.test.js`
Expected: FAIL because document validation and publication are not implemented.

- [x] **Step 3: Implement the isolated document bridge**

In `packages/realtime/src/redis-realtime.js`:
- Import the F1.9 operation validator.
- Add `validateDocumentEnvelope` with exact top-level and payload key allow-lists. Validate channel selectors against envelope `siteId` and `contentId`; require a positive safe sequence, UUID event/publisher IDs, null-or-UUID origin and a valid collaboration operation.
- Add document-specific channel and pattern helpers.
- Add `maxDocumentMessageBytes = 16_384` and `maxDocumentInboundQueue = 1_024` constructor options with finite bounds (256–65,536 bytes; 1–10,000 queued messages).
- Keep the current presence/authorization inbound queue and 4 KiB envelope behavior unchanged. Add a separate document queue, queue gauge and drain loop.
- Add `publishDocumentOperation`: validate, publish locally to topic `document:<contentId>`, then PUBLISH the strict envelope. On Redis failure, report bounded errors/metrics and return `degraded: true` without throwing after local delivery.

In `packages/observability/src/metrics.js`, register the counters and gauge named in the F1.10 spec. Keep names fixed and label-free.

- [x] **Step 4: Run the focused bridge and metrics tests**

Run: `node --test test/redis-realtime.test.js test/realtime.test.js`
Expected: 23/23 tests PASS; all existing presence/authorization tests remain green.

- [x] **Step 5: Commit the bridge task**

```bash
git add packages/realtime/src/redis-realtime.js packages/observability/src/metrics.js test/redis-realtime.test.js test/realtime.test.js
git commit -m "feat(realtime): relay bounded document operations through redis"
```

### Task 2: Route REST and WebSocket commits through the shared publisher

**Files:**
- Modify: `apps/api/src/server.js`
- Modify: `packages/realtime/src/websocket-gateway.js`
- Test: `test/collaboration-api.test.js`
- Test: `test/realtime-websocket.test.js`

**Interfaces:**
- Consumes: Task 1 `bridge.publishDocumentOperation({ siteId, contentId, sequence, originConnectionId, operation })`.
- Produces: one injected `publishDocumentOperation` callback used by both REST and WebSocket commit paths. Local-only mode adapts to `realtimeHub.publish`; Redis mode delegates to the bridge.

- [x] **Step 1: Write failing REST and WebSocket publisher-injection tests**

Add tests that inject a document publisher and assert:
- REST operation submission calls it once with the site, page, committed sequence, null origin and transformed operation.
- WebSocket operation submission calls it once with the server-generated connection UUID as origin.
- A returned degraded result is included as `fanoutDegraded: true` while the committed acknowledgement remains successful.
- Redis mode refuses an injected realtime bridge that lacks `publishDocumentOperation`; local memory-preview mode still works without a Redis bridge.

- [x] **Step 2: Run tests to verify they fail**

Run: `node --test test/collaboration-api.test.js test/realtime-websocket.test.js`
Expected: RED on REST `fanoutDegraded`, WS `fanoutDegraded`, and Redis bridge missing publisher checks (22 pass / 3 fail).

- [x] **Step 3: Implement the shared publisher seam**

In `apps/api/src/server.js`:
- Build one callback that delegates to `realtimeBridge.publishDocumentOperation` when supplied and otherwise publishes the same bounded event to the local hub.
- Pass the callback to `createWebSocketGateway` and use it in the REST collaboration route.
- Require `publishDocumentOperation` for Redis-backed and production injected bridge configuration; fail closed rather than silently falling back to local-only fan-out.
- Preserve the REST request's committed version/sequence and return the bridge degradation flag without treating a relay failure as a persistence failure.

In `packages/realtime/src/websocket-gateway.js`:
- Accept the optional injected publisher. For local preview, retain the existing hub behavior.
- Use the callback for committed operations, passing the server-generated `connectionId`; do not accept an origin ID from the client.
- Keep the post-commit acknowledgement's operation, sequence, version, lockVersion and duplicate flag unchanged; add the publisher's degradation result.

- [x] **Step 4: Run focused API and WebSocket tests**

Run: `node --test test/collaboration-api.test.js test/realtime-websocket.test.js test/realtime.test.js`
Expected: 37/37 tests PASS, including existing authentication, authorization, size/rate and disconnect controls.

- [x] **Step 5: Commit the routing task**

```bash
git add apps/api/src/server.js packages/realtime/src/websocket-gateway.js test/collaboration-api.test.js test/realtime-websocket.test.js
git commit -m "feat(collaboration): use shared document fanout adapter"
```

### Task 3: Single-flight PostgreSQL heartbeat reconciliation

**Files:**
- Modify: `packages/realtime/src/websocket-gateway.js`
- Test: `test/realtime-websocket.test.js`

**Interfaces:**
- Consumes: Task 2 publisher callback and F1.9 `store.getCollaborationSync({ siteId, contentId, afterSequence })`.
- Produces: one per-subscription reconciliation method shared by Pub/Sub gap recovery and the existing WebSocket heartbeat.

- [x] **Step 1: Write failing heartbeat recovery tests**

Add tests that:
- Join a document on a socket, advance the test store to sequence 1 without publishing any hub/Redis event, wait for the configured heartbeat interval and assert the socket receives sequence 1.
- Deliver sequence 2 notification while heartbeat sync is in flight and assert each accepted sequence is delivered once and in order.
- Make the first heartbeat sync fail, assert only a bounded `document.sync.degraded` message is emitted and the base presence WebSocket stays open, then restore the store and assert the next heartbeat catches up.
- Track concurrent `getCollaborationSync` calls and assert at most one in-flight reconciliation per document subscription.

- [x] **Step 2: Run tests to verify they fail**

Run: `node --test test/realtime-websocket.test.js`
Expected: RED — 20 pass / 1 fail. The new recovery test timed out waiting for `document.sync.degraded` because heartbeat performed no document sync.

- [x] **Step 3: Implement single-flight reconciliation**

In `packages/realtime/src/websocket-gateway.js`:
- Add `reconcileDocument(contentId, entry)` using an `entry.reconcilePromise` so heartbeat and sequence-gap recovery share one in-flight sync.
- Use the existing `deliverDocumentSync` behavior to replay in database order or send the canonical reload response when history is expired.
- Invoke reconciliation during the existing heartbeat after live-session and per-document edit authorization rechecks.
- Guard the overall heartbeat interval against overlapping async ticks.
- On a transient sync error, preserve the WebSocket and document subscription, send a bounded `document.sync.degraded` message, and retry on the next heartbeat. Do not advance `lastSequence` without a successful replay or reload.
- Keep queue overflow and slow-consumer behavior bounded; reconnect continues to use PostgreSQL.

- [x] **Step 4: Run focused gateway tests**

Run: `node --test test/realtime-websocket.test.js`
Expected: 21/21 tests PASS; heartbeat repairs a final lost notification, preserves the socket on transient sync failure, and gap recovery shares the in-flight sync without duplicate delivery.

- [x] **Step 5: Commit the recovery task**

```bash
git add packages/realtime/src/websocket-gateway.js test/realtime-websocket.test.js
git commit -m "feat(collaboration): reconcile document sequences on heartbeat"
```

### Task 4: Live Redis two-instance and editor-count proof

**Files:**
- Create: `test/integration/redis-collaboration.integration.test.js`
- Create: `test/e2e/collaboration-multinode.spec.js`
- Create: `test/fixtures/collaboration-multinode.js`
- Modify: `package.json` only if a dedicated explicit script is needed; do not alter dependencies.

**Interfaces:**
- Consumes: Task 1 bridge `publishDocumentOperation`, Task 2 API injection and Task 3 heartbeat reconciliation.
- Produces: repeatable two-instance test fixtures and evidence for 2/5/10 concurrent editor sessions.

- [x] **Step 1: Add real-Redis integration tests**

Add a test gated by `SYSTEMFABRIC_RUN_REDIS_INTEGRATION=true` and `SYSTEMFABRIC_TEST_REDIS_URL`. Validate that the URL uses an explicitly approved local endpoint before connecting. Use a unique channel prefix per test run; do not print URL credentials.

Test two independent bridge clients/hubs for:
- Cross-instance same-document operation fan-out.
- No cross-site or cross-document event delivery.
- Publisher self-echo suppression and recipient sequence preservation.
- Redis publish failure returns degraded after local delivery.
- Reordered, duplicate and dropped hints are repaired from PostgreSQL sequence sync (covered in the two-instance Playwright proof and gateway regression tests; the standalone real-Redis integration test is limited to Pub/Sub routing and local-first degraded publication).

- [x] **Step 2: Validate test gate and live Redis behavior**

Run: `node --test test/integration/redis-collaboration.integration.test.js`
Expected: the original RED expectation was superseded because Task 1 had already implemented the document bridge before Task 4 added its real-Redis harness. A first environment invocation accidentally included trailing whitespace in the URL and skipped both tests; the corrected explicit-loopback invocation then passed 2/2 with zero skips. Reordered/duplicate/dropped hint recovery is asserted in the Playwright API-multi-instance proof.

- [x] **Step 3: Implement the real-Redis integration harness**

Use `createRedisRealtimeBridge` with two independent client pairs and two local hubs. The real Redis test validates only Pub/Sub routing and independent clients; use the in-memory store for operation sequence/recovery. Give each test a random `systemfabric:test:f1-10:<uuid>` channel prefix and close hubs/bridges in `t.after` cleanup. Do not change Redis databases, flush keys or inspect any application database.

- [x] **Step 4: Run the explicit local Redis integration test**

Run: `set SYSTEMFABRIC_RUN_REDIS_INTEGRATION=true && set SYSTEMFABRIC_TEST_REDIS_URL=redis://127.0.0.1:6379 && node --test test/integration/redis-collaboration.integration.test.js`
Expected: test PASS with no skips; fixture validates the endpoint is loopback and the test opens no application database. Use the configured local Redis-compatible endpoint only; never print credentials.

- [x] **Step 5: Write multi-instance browser tests first**

Start two independent `createApiServer` instances on ephemeral loopback ports, each with its own realtime hub/Redis bridge/limiter and a shared in-memory collaboration store/identity adapter. Use two isolated browser contexts and separate sessions.

Prove:
- A-to-B and B-to-A operation fan-out over real browser WebSockets.
- Different site/document subscriptions receive no cross-scope events.
- A Pub/Sub notification intentionally dropped by the publisher is repaired on the receiving socket's heartbeat even when no later operation is submitted.
- Closing one API instance and reconnecting the client to the surviving instance replays the durable operation sequence.
- A 2/5/10-editor matrix spread over the two instances delivers no duplicate or missing sequence after reconciliation, with bounded queues and no unhandled errors. Record p50/p95/p99 delivery and reconciliation latency; do not claim production capacity certification.

- [x] **Step 6: Run the multi-instance browser tests**

Run: `node node_modules/@playwright/test/cli.js test test/e2e/collaboration-multinode.spec.js --reporter=line`
Expected: all tests PASS using the approved local Redis endpoint; test servers/bridges start and stop and all browser contexts close in cleanup.

- [x] **Step 7: Commit the multi-instance proof**

```bash
git add test/integration/redis-collaboration.integration.test.js test/e2e/collaboration-multinode.spec.js test/fixtures/collaboration-multinode.js package.json
git commit -m "test(collaboration): prove multi-instance redis recovery"
```

### Task 5: Documentation and final verification

**Files:**
- Modify: `docs/REALTIME-FOUNDATION-F1.md`
- Modify: `docs/REALTIME-AI-ARCHITECTURE.md`
- Modify: `docs/ARCHITECTURE-DECISIONS.md`
- Modify: `docs/ROADMAP.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: bridge, publisher, reconciliation and multi-instance evidence from Tasks 1–4.
- Produces: F1.10 architecture/release-gate documentation and a clean local feature branch.

- [ ] **Step 1: Document F1.10 behavior and limits**

Record the channel/envelope contract, separate queue and bounds, Redis ephemeral semantics, PostgreSQL heartbeat repair, origin echo handling, metrics, tests and explicitly unclosed production gates. Update ADR-019 and the roadmap only for behaviors demonstrated by tests.

- [ ] **Step 2: Run focused and full verification**

Run:
- `node --test test/redis-realtime.test.js test/realtime.test.js test/collaboration.test.js test/collaboration-api.test.js test/realtime-websocket.test.js`
- Explicit local Redis integration test from Task 4.
- Multi-instance Playwright test from Task 4.
- `npm run check`
- `git diff --check`

Expected: all focused, local Redis, browser and full repository checks pass; no primary database, migration or deployment operation occurs.

- [ ] **Step 3: Perform whole-branch review**

Read the spec and review the complete diff from the F1.9 base. Focus on channel selector mismatch, sensitive envelope fields, queue starvation, Redis publish failure after commit, sequence races, heartbeat single-flight and reconnect behavior. Record self-review because no independent subagent is available.

- [ ] **Step 4: Commit documentation and close out F1.10**

```bash
git add docs/REALTIME-FOUNDATION-F1.md docs/REALTIME-AI-ARCHITECTURE.md docs/ARCHITECTURE-DECISIONS.md docs/ROADMAP.md CHANGELOG.md
git commit -m "docs(realtime): record F1.10 cross-instance collaboration"
```

Keep production status NO-GO until the broader deployment-specific load/soak, Redis Cluster/partition/failover review, node-loss/rolling-deploy rehearsal, independent security/accessibility review, operational runbooks and ownership are complete.
