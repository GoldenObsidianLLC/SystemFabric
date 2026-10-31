# Collaborative Editing Spike (F1.7)

**Status:** Architecture spike complete; collaboration engine not implemented
**Scope:** Compare CRDT and operational transformation (OT) against the current SystemFabric page-document v1 model and select a provisional v1 direction.
**Decision record:** ADR-019 in [Architecture Decisions](ARCHITECTURE-DECISIONS.md)
**Related foundation:** [Real-Time Foundation 1](REALTIME-FOUNDATION-F1.md)

## Executive recommendation

Use a **server-authoritative, document-specific semantic OT protocol** for the first online CMS collaboration release. Keep PostgreSQL as the authoritative sequencer and persistence layer, preserve the versioned JSON page document as the canonical materialized state, and express edits as typed operations addressed by stable node IDs and sibling anchors.

Do not adopt a general-purpose CRDT runtime or embed CRDT metadata in page-document v1 for the first release. Revisit CRDT if offline-first or multi-master editing becomes a demonstrated product requirement. This is an architecture recommendation, not an implemented collaboration capability; no transport, persistence migration, editor collaboration UI or OT engine is introduced by this spike.

## 1. Codebase evidence

The recommendation is based on the current implementation, not a hypothetical rich-text editor.

| Existing contract | Current behavior | Collaboration consequence |
|---|---|---|
| Canonical document | `packages/domain/src/page-document.js` validates a JSON tree with `schemaVersion: 1`, stable `documentId`, title and nested `children` arrays. | The collaboration model must materialize back to this exact versioned JSON contract. |
| Tree limits | At most 250 nodes, maximum depth 12, unique stable node IDs, and only `section`, `column` and `container` nodes may contain children. | Merges must preserve structural invariants, not merely converge at the byte or map level. |
| Typed properties | Each widget has an explicit property allow-list. Text-bearing widgets use plain string properties; the schema is not a rich-text AST. | The first operation vocabulary can target typed properties and simple text ranges. |
| Editor model | `apps/admin/assets/studio.js` edits one in-memory JSON tree, retains up to 60 whole-document undo snapshots, and saves the whole document. | Local editor actions need to become typed operations before collaboration can be safely added. |
| Save concurrency | `POST /api/v1/pages/drafts` sends `expectedVersion`; `packages/db/src/postgres-store.js` locks the row and rejects stale versions with HTTP 409. | The current compare-and-swap behavior prevents silent overwrites but does not merge concurrent edits. |
| Durable revisions | Draft saves write immutable full JSON snapshots to `content_revisions` in the same PostgreSQL transaction as the content row and outbox event. | Collaboration needs a durable operation history and explicit snapshot/checkpoint semantics. |
| Version semantics | `content_items.version` tracks editorial revisions; `lock_version` is the monotonic aggregate sequence used by the outbox/graph projection. | These counters must not be conflated. A collaboration sequence must be defined explicitly and tested with workflow changes. |
| Publication | `published_snapshot` is separate from the editable body and changes only through workflow transitions. | Collaborators may edit drafts; an in-progress session must never mutate the live published snapshot. |
| Realtime transport | The current SSE preview is one-way and limited to presence refresh. | It is not a bidirectional document-operation transport. A separate authenticated bidirectional collaboration gateway is required. |

## 2. Candidate comparison

| Dimension | CRDT | Server-authoritative semantic OT |
|---|---|---|
| Independent edits | Converges without a central transform step when operations use compatible CRDT data types. | Server sequences operations and transforms stale operations against accepted history. |
| Offline editing | Strong fit: clients can accumulate updates and merge after reconnect, subject to retention and authorization rules. | Possible only with bounded operation history and explicit rebase; old clients may need to reload and resolve a conflict. |
| Nested page tree | Requires a tree representation and explicit semantics for moves, delete/reinsert, duplicate identity and parent/child invariants. Convergence alone does not prove a valid page document. | Stable node IDs, parent IDs and sibling anchors let the server define deterministic structural transforms for the finite editor operation set. |
| Same-property edits | Depends on the chosen shared type and conflict policy; map assignment can be last-writer-wins while text needs a text-aware shared type. | Explicit policy per operation: server-sequenced last accepted property write, or text-range transformation for concurrent string edits. |
| Node moves | Moving a nested shared type between ordered collections is a special case; concurrent moves need a defined single-parent winner and cycle prevention. | A move is a semantic command by node ID; the server validates the destination and applies the ordered accepted move. |
| Schema validation | CRDT state can be temporarily or permanently outside the page schema; materialization and validation are still mandatory. | The server validates each accepted operation batch against the canonical page schema before commit. |
| Persistence | Requires durable CRDT updates, snapshotting, compaction/garbage collection, state-vector/reconnect rules and a canonical JSON materializer. | Fits the existing PostgreSQL row lock, revision snapshots, outbox and aggregate sequencing, with a new durable operation log and snapshot policy. |
| Undo/redo | Must be intent-aware; simply reversing shared state can undo another collaborator's change. | Can issue compensating operations against the current server sequence, with explicit conflict results. |
| Operational complexity | Adds a CRDT runtime and its data-model/compaction lifecycle, while still requiring auth, transport, persistence and schema validation. | Adds a central sequencer and a custom, bounded transform engine; the central server already exists, but the transform rules require rigorous tests. |
| Best fit | Offline-first, peer-to-peer or intermittently connected collaboration where decentralized convergence is a primary requirement. | Online collaborative editing with PostgreSQL authority, a finite typed operation set and explicit server validation. |

### Assessment

CRDT is a credible future option, especially if offline-first editing becomes a hard requirement. It is not a shortcut around the current domain model: node identity, parent ownership, moves, cycles, type-specific props, publication isolation and schema validation still need explicit handling. Storing a CRDT document as the only canonical editor representation would also add a second schema and a materialization/compaction lifecycle next to the existing JSON snapshot and revision model.

The current editor is a structured page builder, not a free-form rich-text canvas. Most edits are property changes, component insertion/deletion, reordering and moves. The current write path already centralizes authority in PostgreSQL and protects whole-document saves with a row lock and optimistic version check. For an online-first first release, typed semantic operations transformed by one server sequencer are the smaller conceptual change and preserve the canonical document contract.

OT is not automatically simpler: a generic JSON-patch transform engine would be the wrong abstraction. The proposed design is **document-specific semantic OT**, with different transform rules for text ranges and tree operations. Its correctness must be established through adversarial concurrent-operation tests before any production use.

## 3. Proposed v1 operation contract

Every client operation should carry a bounded envelope. The server derives the site, actor and current authorization context from the authenticated request/session; client-supplied identity fields are hints for ordering/diagnostics only and never grant authority.

| Field | Purpose |
|---|---|
| `schemaVersion` | Version of the collaboration operation envelope, independent of page-document schema version. |
| `documentId` / `contentId` | Stable page identity; the server verifies the content belongs to the authenticated site. |
| `opId` | Client-generated UUID used for idempotent duplicate detection. |
| `clientId` | Non-secret, per-editor-instance identifier used for local ordering/diagnostics. It is not an actor identity or credential. |
| `baseSequence` | Last server sequence observed by the client; used to fetch/transform intervening accepted operations. |
| `type` | One of the typed operations below. Unknown operation types fail closed. |
| `payload` | Bounded operation-specific values; never an arbitrary SQL patch, function, HTML fragment or unrestricted JSONPath. |

Initial operation vocabulary:

- `document.set_title`
- `node.insert` — complete validated node, parent node ID (or root), and `afterNodeId` sibling anchor.
- `node.delete` — target node ID; deletion includes its descendants.
- `node.move` — target node ID, destination parent ID (or root), and sibling anchor.
- `node.set_prop` — target node ID, one allow-listed property path and a typed value.
- `text.insert` / `text.delete` — a text-bearing node/property plus a bounded range operation for plain-string content.

Do not transmit array indexes as durable positions. Indexes become stale when an earlier insert/delete is accepted. Resolve positions from stable node IDs and sibling anchors on the server. Operation IDs are deduplicated within the document operation log.

## 4. Required conflict semantics

These are recommended v1 rules and must be represented as executable tests in the next implementation slice.

| Concurrent situation | Required result |
|---|---|
| Two users edit different properties on different nodes | Both edits are accepted; the materialized document contains both. |
| Two users edit different properties on the same node | Both edits are accepted if the property paths do not overlap. |
| Two users set the same property | Server order is authoritative; the later accepted operation wins and the response identifies the superseded value for UI conflict messaging. |
| Two users insert siblings at the same anchor | The server assigns a deterministic order based on accepted sequence plus stable operation identity; no duplicate IDs or index-based drift. |
| A node is deleted while another user edits one of its properties | Deletion wins. The stale property operation returns a typed target-deleted result; it must not resurrect the node. |
| Two users move the same node | The later valid server-sequenced move wins. Only one parent reference survives materialization. |
| A move targets a descendant as its new parent | Reject the operation; do not create a cycle or silently repair it. |
| A parent is deleted while an insert targets one of its children | Reject with a typed missing-parent conflict; do not reparent to the root implicitly. |
| A replayed operation ID arrives again | Return the original accepted result without applying it twice. |
| The operation base is older than retained transform history | Require a fresh canonical snapshot and explicit rebase/reload; never apply an unbounded or guessed transform. |

For text ranges, the transform implementation must define its coordinate system and Unicode behavior, including surrogate pairs, combining marks and emoji. It must not silently split a Unicode scalar value. The current schema stores plain strings; rich-text marks/embeds are outside this first protocol decision.

## 5. Persistence and transport shape

The following is an implementation direction, not a migration proposal.

1. PostgreSQL remains authoritative. Accepted operations are durably sequenced per document; the same transaction records the operation ID/result and updates the materialized JSON body or a documented checkpoint.
2. Keep the two existing counters distinct: editorial revision `version` and aggregate `lock_version`. The implementation must specify which sequence is used for OT rebase and how workflow transitions, restores and ordinary full-document saves interact with that sequence.
3. Persist enough accepted-operation history to rebase connected clients after a transient disconnect. Define a bounded retention window and a checkpoint/compaction rule. A client older than the retained window reloads a canonical snapshot instead of replaying arbitrary history.
4. Keep `content_revisions` as immutable materialized JSON snapshots. Accepted collaborative edits must eventually produce the same revision/audit/outbox evidence as other canonical content changes; transient presence/cursor messages must not create editorial revisions.
5. The authoritative operation transaction validates site membership/capability, document status, operation envelope, operation-specific constraints and the resulting full page document. It enforces node count, depth, stable ID uniqueness, parent/container rules and safe widget properties before commit.
6. Collaboration is draft-only in v1. Review, approval, publish, schedule, archive and unpublish remain existing server-authorized workflow transitions. Publishing uses a validated committed snapshot, never an uncommitted client buffer.
7. A bidirectional authenticated transport (most likely a document-scoped WebSocket gateway) is required. SSE remains appropriate for one-way notifications, not client operations. Every connection and operation rechecks site/document authorization; revocation closes the session-bound collaboration stream.
8. Redis Pub/Sub may notify other replicas that a durable operation committed, but it is not the operation log, acknowledgement source or recovery mechanism. Reconnect reads from PostgreSQL and verifies the last acknowledged server sequence.

## 6. Prototype and verification gates

F1.7 is an architecture spike only. No CRDT package, OT runtime, collaboration table, migration, WebSocket route or editor multi-user behavior is added in this change. F1.7's codebase inspection confirms that the current save/revision path is a suitable authoritative persistence seam, while the current one-way SSE gateway is not a collaboration transport.

The next implementation slice must prove:

- Two browser sessions can concurrently edit one draft and converge on exactly one valid page-document JSON tree.
- The complete conflict matrix in section 4 is executable, including property writes, sibling insertion ordering, delete-versus-edit, concurrent moves and parent deletion.
- A lost acknowledgement followed by retry does not duplicate an operation.
- Disconnect/reconnect replays only accepted operations after the client's sequence; expired history forces a canonical reload.
- Schema validation runs before persistence and cannot be bypassed by malformed or malicious operations.
- A site/member/session revocation stops future operation reads and writes, including on another API replica.
- Draft collaboration never mutates `published_snapshot`; editorial revisions and workflow transitions remain auditable.
- Undo/redo is implemented as compensating operations and cannot silently roll back another collaborator's accepted work.
- Load evidence covers 2, 5 and 10 active editors on a 250-node/12-level worst-case valid document; report operation latency, transform CPU, transaction time, update volume, snapshot cost and memory rather than claiming performance from a diagram.
- Browser accessibility includes keyboard operation, announced conflict states, meaningful attribution, reduced-motion behavior and a non-collaborative fallback.

### Decision gate

Proceed with semantic OT only after a two-client browser prototype meets those correctness gates and independent security review confirms tenant isolation, replay handling, operation quotas, message-size bounds and authorization invalidation. If the prototype requires broad custom transformation logic or offline-first editing is mandated, revisit CRDT with a real library-backed experiment rather than expanding an unbounded bespoke OT engine.

## 7. Explicit non-goals

This spike does not deliver Google-Docs-style live editing, cursor awareness, offline merge, comments, review annotations, a collaboration transport, presence UI, a CRDT adapter, an OT engine or production certification. Foundation 1.7 is complete as a documented architecture evaluation and provisional decision only.
