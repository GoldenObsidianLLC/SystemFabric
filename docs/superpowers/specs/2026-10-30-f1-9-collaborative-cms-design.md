# F1.9 Collaborative CMS Implementation Proof — Design

**Date:** 2026-10-30  
**Status:** Accepted implementation direction for the developer-preview proof  
**Decision basis:** F1.7 Collaborative Editing Spike and ADR-019  
**Scope:** Draft-only server-authoritative semantic OT proof with durable per-document sequencing, two independent browser sessions, conflict handling and bounded reconnect/snapshot recovery.

## Intent

Prove that the existing page-document v1 JSON tree can support safe online concurrent edits without changing the canonical document format or making CRDT metadata part of published content. PostgreSQL remains the document sequencer and durable source of accepted operations. The proof should be small enough to validate the operation semantics before a full Studio collaboration UI is attempted.

## Goals

- Implement typed document operations over stable node IDs, parent IDs and sibling anchors.
- Transform stale client operations against the durable, server-accepted operation history.
- Validate the fully materialized page-document v1 tree before committing an operation.
- Persist each accepted operation, idempotency result, materialized body, editorial revision, workflow evidence and outbox event in one PostgreSQL transaction.
- Use a distinct monotonic collaboration sequence; do not conflate it with editorial version or aggregate lock_version.
- Provide bounded replay from a client sequence and force a canonical reload when a client falls behind retained history.
- Add document-scoped WebSocket join, operation and leave commands; derive site, principal and actor identity from the authenticated session.
- Prove two separate browser sessions can concurrently edit the same draft and converge through the server sequence.
- Keep all collaboration changes draft-only; never modify published_snapshot.

## Non-goals

- Offline-first / multi-master editing or CRDT.
- Full Google-Docs-style Studio UX, cursors, comments, annotations or shared undo/redo.
- Rich-text AST, HTML patches, JSONPath patches, client-selected actor/site identity, arbitrary client publish, or index-based durable positions.
- Durable Redis Pub/Sub replay, multi-region coordination or production certification.

## Approaches

1. **Server-authoritative semantic OT (selected):** PostgreSQL locks and sequences each draft operation. A pure domain module transforms a bounded operation against retained accepted operations and applies it to the canonical page tree. A document-scoped WebSocket forwards accepted operation notifications; reconnect reads PostgreSQL.
2. **CRDT-backed document state:** enables offline and multi-master editing but introduces a second document representation, tree invariants, update compaction and materialization beside the current page JSON/revision model. Deferred until offline-first is a proven requirement.
3. **Whole-document compare-and-swap only:** reuses current expectedVersion saves but rejects or loses concurrent edits rather than converging; does not meet the collaboration proof.

## Domain contract

Each operation envelope contains:
- schemaVersion: 1
- opId: UUID, idempotent within a document
- clientId: bounded, non-secret editor-instance identifier
- baseSequence: non-negative integer last observed by the client
- type and bounded payload

The server derives siteId, actorId, principal and session from the authenticated request. Client identity fields are never authorization data.

### Initial operation vocabulary

- document.set_title: { title }, 1–180 characters.
- node.insert: { node, parentId: string|null, afterNodeId: string|null }; inserts a complete validated node/subtree. Positions are stable sibling anchors.
- node.delete: { nodeId }; deletion removes the node and descendants.
- node.move: { nodeId, parentId: string|null, afterNodeId: string|null }; one parent only, cycles rejected.
- node.set_prop: { nodeId, key, value }; key must be approved by TYPE_PROPS for the existing node type. Non-overlapping properties merge; later server-accepted writes win on the same key.
- text.insert: { nodeId, key, offset, text }.
- text.delete: { nodeId, key, offset, length }.

Text coordinates count Unicode code points (the result of Array.from, not UTF-16 code units). Text operations are limited to the existing plain-string properties on heading, text, button and quote widgets. The engine must not split surrogate pairs.

### Transform and conflict semantics

- Server sequence is the deterministic total order. For inserts sharing the same original parent and sibling anchor, accepted sequence order is preserved by chaining subsequent inserts after the last accepted sibling from that anchor group.
- Independent property writes apply to the current tree. The later accepted write wins for the same property.
- A missing/deleted node yields typed target_deleted; a missing destination parent or anchor yields typed conflict; a move into the target's descendant yields typed cycle rejection.
- A stale move of an extant node is applied against the current tree, so the later accepted move wins and only one parent remains.
- Text range operations transform through accepted text operations on the same node/property. Insertions at the same offset are ordered by accepted sequence. Deletion ranges are mapped through prior insert/delete operations in code-point coordinates.
- Replayed opId with identical actor/client/envelope returns its original committed result and sequence without applying again. Reuse with different content or actor is rejected.
- A base sequence greater than current is invalid. A base sequence older than oldestReplaySequence returns a reload-required result with the canonical snapshot; no guessed transform is attempted.
- Full page-document validation runs after operation application. Invalid materialization does not consume a sequence or alter any content/revision/outbox state.

## Persistence and recovery

Add migration 0014_collaborative_document_operations.sql with:
- One content_collaboration_documents row per content draft, holding sequence and oldest_replay_sequence.
- An immutable content_collaboration_operations record keyed by (content_id, sequence) and unique by (content_id, op_id), including original operation, transformed/applied operation, actor/client and committed result.
- A bounded replay window of 1,000 accepted operations per document. Pruned operations are older than oldest_replay_sequence; clients below that sequence receive a canonical snapshot reload.

For each accepted operation, one transaction:
1. Locks the site-scoped content_items row FOR UPDATE; requires status='draft'.
2. Checks idempotency and locks/creates the collaboration sequence row.
3. Rejects future or expired base sequence, loads retained accepted operations after the base, transforms and applies the operation.
4. Validates the complete resulting page document.
5. Updates content_items.body, editorial version, lock_version, search text and updated_by; leaves published_snapshot untouched.
6. Inserts the immutable full content_revisions snapshot, workflow evidence and content.upsert outbox event.
7. Increments collaboration sequence, inserts the operation record and prunes only history that the updated replay floor declares expired.
8. Commits all state together.

No migration is automatically run against the primary database. Existing whole-document draft save/restore remains available as an administrative path; it must invalidate the old collaboration sequence/history or force clients to reload so the materialized body and operation sequence cannot diverge. Workflow transitions out of draft prevent further operations; a later return to draft starts a fresh collaboration checkpoint rather than reviving stale unbounded history.

## Transport

The existing authenticated WebSocket route is extended with a narrow document protocol:
- document.join with contentId and afterSequence: authorize draft edit access, subscribe to a document-scoped topic, then return accepted operations or a canonical reload snapshot.
- document.operation: accept one operation from the joined document only, apply through the same store method as REST, acknowledge the committed sequence and notify authorized subscribers on the same API instance.
- document.leave: close only that document subscription.

The gateway reauthorizes document subscriptions and commands. Frames stay bounded (16 KiB maximum, 12 KiB maximum operation envelope); command rate remains bounded. Redis presence Pub/Sub is not used for document data. A subscriber on another API instance recovers from PostgreSQL on reconnect; cross-instance live operation notifications remain an explicit follow-up until a durable broker is selected.

## Browser proof and acceptance

A browser test opens two independent cookie-authenticated sessions against one test API instance. Both join one draft at sequence 0, submit concurrent operations from the same base, receive acknowledgements/notifications, and read back one canonical converged document. The test also proves duplicate-op retry, sequence-based recovery after reconnect, stale-history snapshot reload, authorization rejection/revocation, and draft/published-snapshot isolation.

Unit tests exercise the conflict matrix and Unicode boundaries. Live PostgreSQL integration uses only the dedicated TEST_DATABASE_URL, creates unique site/content fixtures, and cleans them up. No primary DB or production migration is touched.

## Production gate

This is a developer-preview correctness proof. Production remains NO-GO until the 2/5/10-editor load matrix, multi-instance operation notification/recovery, authorization revocation across replicas, backup/retention runbooks, browser/proxy reconnect soak, independent security review and accessibility review are complete. CRDT should be revisited if offline-first becomes mandatory or the finite semantic transform vocabulary proves too costly to maintain.
