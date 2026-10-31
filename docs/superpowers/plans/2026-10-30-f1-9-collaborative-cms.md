# F1.9 Collaborative CMS Implementation Proof — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [x] ) syntax for tracking.

**Goal:** Build a draft-only server-authoritative semantic OT proof with durable PostgreSQL sequencing, bounded reconnect and two independent browser sessions.

**Architecture:** A pure collaboration module validates, transforms and applies typed operations over page-document v1. The PostgreSQL store serializes operations per content row, stores an idempotent bounded history and commits each materialized revision/outbox event atomically. Authenticated WebSocket document subscriptions broadcast accepted operations locally; reconnect and cross-instance recovery read PostgreSQL.

**Tech Stack:** Node.js 22+, CommonJS, PostgreSQL, existing ws@8.22.0, Playwright Chromium, node:test.

**Spec:** docs/superpowers/specs/2026-10-30-f1-9-collaborative-cms-design.md

## Global Constraints
- Do not edit .env, access or modify the primary database, or apply migrations outside the explicitly validated dedicated test database.
- Canonical state remains page-document schema v1; enforce 250-node and 12-depth limits after every operation.
- Collaboration is draft-only. Keep editorial version, aggregate lock_version and collaboration sequence separate.
- Every accepted operation, revision snapshot, workflow record and outbox event is one PostgreSQL transaction.
- Operation history retention is 1,000 accepted operations/document; expired bases require a canonical reload.
- WebSocket operation envelopes are at most 12 KiB and frames at most 16 KiB; identity/site/session derive from authentication.
- No Redis Pub/Sub document payloads, OT replay from Redis, CRDT metadata, arbitrary JSON patches or index-based sibling positions.
- Keep all F1.8 local modifications intact; never reset or amend the prior F1.7 commit.

## Review Focus
- Reused opId with altered payload or actor must conflict rather than disclose or mutate another actor's operation result.
- Operation base ahead of the current sequence must be rejected; an expired base must return a canonical reload snapshot.
- Delete-vs-edit, move-into-descendant, moved/deleted sibling anchors and parent deletion must not corrupt the tree.
- Text inserts/deletes around emoji and surrogate pairs must not split Unicode scalar values or exceed page-document string bounds.
- Workflow transition or ordinary full-document save racing an operation must serialize on content row lock and force the client to resync.
- Cross-site or non-editor subscriptions must not receive document operation payloads.

---

### Task 1: Pure semantic operation engine

**Files:**
- Create: packages/collaboration/src/semantic-ot.js
- Create: packages/collaboration/src/index.js
- Test: test/collaboration.test.js

**Interface:**
- validateCollaborationOperation(operation) -> { valid, errors }
- transformCollaborationOperation(operation, acceptedOperations) -> transformed operation or typed conflict.
- applyCollaborationOperation(document, operation) -> { document, appliedOperation, changed }
- Use exported TYPE_PROPS, CONTAINER_TYPES and validatePageDocument.

- [x] Write tests for envelope validation and title/property/insert/delete/move operations.
- [x] Add stale same-anchor insert ordering, independent/same-property writes and delete-vs-edit tests.
- [x] Add text transform tests for concurrent same-offset insert, overlapping delete and emoji/surrogate-safe code-point offsets.
- [x] Run node --test test/collaboration.test.js and observe expected missing-module failures.
- [x] Implement the smallest pure transform/apply engine that passes the conflict matrix; return typed conflicts and validate the final page tree.
- [x] Run the focused test file and syntax checks.

### Task 2: Durable PostgreSQL operation sequencing

**Files:**
- Create: database/migrations/0014_collaborative_document_operations.sql
- Modify: packages/db/src/postgres-store.js
- Test: test/integration/postgres-collaboration.integration.test.js

**Interface:**
- store.applyCollaborationOperation({ siteId, contentId, actorId, operation, correlationId })
- store.getCollaborationSync({ siteId, contentId, afterSequence })

- [x] Add isolated integration tests for sequence 1 creation, revision/outbox updates, stale-base transform, idempotent retry, altered opId reuse, history pruning/reload, draft-only enforcement and site isolation.
- [x] Run the integration test with SYSTEMFABRIC_RUN_POSTGRES_INTEGRATION=true against the dedicated test database; use TEST_DATABASE_URL only, explicitly mapped to DATABASE_URL for the migration runner and existing content tests.
- [x] Add migration 0014 for per-document sequence/replay floor, accepted-operation history, idempotency tombstones and the collaboration workflow action.
- [x] Implement the transactional store method: lock content first, verify draft/site, dedupe, transform against retained history, validate, update body/version/lock_version, insert revision/workflow/outbox/op record, advance sequence and prune beyond the 1,000-operation window.
- [x] Implement sync with a single-statement snapshot returning accepted operations after a valid sequence or a canonical reload snapshot when history has expired.
- [x] Run the live collaboration integration and existing PostgreSQL content integration tests against TEST_DATABASE_URL only.

### Task 3: Authenticated API and document WebSocket protocol

**Files:**
- Modify: apps/api/src/server.js
- Modify: packages/realtime/src/event-hub.js
- Modify: packages/realtime/src/websocket-gateway.js
- Create: test/collaboration-api.test.js
- Test: test/realtime-websocket.test.js

- [x] Add REST operation and sync routes with site/document checks, content:edit/owner authorization, draft-only behavior and bounded bodies.
- [x] Extend hub authorization for a UUID-scoped document topic; require a live session and content:edit or own-content edit capability.
- [x] Add document.join/operation/leave commands, per-document subscriptions, snapshot/replay join response, committed acknowledgements carrying the server-transformed op, unique server-connection origin-echo suppression and sequence-gap recovery before suppression.
- [x] Raise only the WebSocket frame ceiling to 16 KiB, cap operation payload at 12 KiB, keep 60 messages/minute and 1 MiB backpressure.
- [x] Test wrong-site access, insufficient capability, cross-document delivery isolation, operation rejection, disconnect cleanup, authorization revocation and replay join.
- [x] Run focused API/WebSocket tests (22/22 pass).

### Task 4: Two-session browser proof

**Files:**
- Create: test/e2e/collaboration.spec.js
- Create: test/fixtures/collaboration-client.js (only the minimal browser test driver; no production editor UI).
- Test: test/e2e/collaboration.spec.js

- [x] Start an isolated in-test API server with fake session authentication and the semantic collaboration store adapter; never open the primary database.
- [x] Use two separate browser contexts/cookie sessions and real WebSocket connections to join the same draft.
- [x] Exercise concurrent different-property edits from base sequence 0 and assert both browser clients receive one converged canonical result.
- [x] Exercise lost-ack retry and reconnect by sequence; expired sequence must install the canonical reload snapshot.
- [x] Run the dedicated Playwright test and record browser/version evidence (Chrome channel 156.0.8078.48, 1/1 pass).

### Task 5: Documentation and release gates

**Files:**
- Modify: docs/REALTIME-FOUNDATION-F1.md
- Modify: docs/REALTIME-AI-ARCHITECTURE.md
- Modify: docs/ROADMAP.md
- Modify: docs/ARCHITECTURE-DECISIONS.md
- Modify: CHANGELOG.md

- [x] Document operation envelope, transform rules, durable sequence, retention/reload, WebSocket commands and explicit limits.
- [x] Record ADR/provisional status; only test-proven F1.9 scope is complete and load/soak/security/accessibility/multi-instance notifications remain open.
- [x] Run final focused tests (34/34), isolated PostgreSQL integration (8/8), browser proof (Chrome 156.0.8078.48; 1/1), npm run check (198/198; 141 required paths and 135 JS syntax checks), git diff --check and final self-review on the completed branch.
