# SystemFabric Architecture Decision Records

## ADR-001: PostgreSQL is authoritative

**Decision:** Canonical content, schema definitions, revisions, identity, permissions, canonical relationship rows, publication state, audit events, and outbox events live in PostgreSQL.

**Reason:** Relational constraints, transactions, and replayable change events make authoritative state easier to reason about.

**Trade-off:** Graph projections are eventually consistent and require retry, monitoring, reconciliation, and rebuild workflows.

## ADR-002: Memgraph is a rebuildable graph projection

**Decision:** Memgraph stores lightweight identity nodes and allow-listed edges optimized for relationship traversal, not large content payloads or authoritative permissions.

**Reason:** A graph outage must not make canonical content unrecoverable or accidentally grant access.

## ADR-003: Do not promise cross-database atomic rollback

**Decision:** Commit canonical PostgreSQL writes and outbox events in one transaction; apply graph projections asynchronously with idempotency, version checks, retries, dead-letter handling, and reconciliation.

**Reason:** Application-level compensating scripts cannot guarantee distributed atomicity across arbitrary network/process failures.

## ADR-004: Page documents are versioned JSON trees

**Decision:** The visual editor stores JSON documents with stable node IDs, schema versions, typed widget properties, and explicit child arrays.

**Reason:** Documents can be validated, migrated, diffed, exported, and rendered independently of editor state.

## ADR-005: EnginEx is isolated behind a rendering adapter

**Decision:** SystemFabric uses vendored EnginEx 6.2.0 through `packages/render`. The renderer consumes validated documents and prepared data rather than issuing CMS SQL queries.

**Trade-off:** SystemFabric's supported Node.js minimum follows the vendored package declaration (>=22.23.4); this build has only been locally tested on 22.16.0.

## ADR-006: AI is provider-neutral and optional

**Decision:** Provider adapters share a task contract. Rendering and core CMS reads do not require AI.

**Reason:** Providers differ in cost, availability, data handling, schemas, and model behavior.

## ADR-007: AI creates proposals, not unreviewed mutations

**Decision:** Model outputs are untrusted, normalized, validated, and returned as proposals. Human-authored workflow calls govern persistence and publication.

**Reason:** Structured output does not confer permissions or guarantee factual/security correctness.

## ADR-008: MCP is a constrained local integration

**Decision:** The current MCP adapter exposes status, widget listing, document validation, page draft generation, and preview over stdio.

**Trade-off:** The MCP process inherits local user authority. Remote MCP requires separate transport authentication, tenant identity, tool-level authorization, budget controls, and review.

## ADR-009: Identity is database-backed and site-scoped

**Decision:** Use opaque session tokens stored as digests, CSRF checks for cookie-authenticated writes, capability-based site memberships, one-time invitation tokens, and per-route capability enforcement.

**Consequences:** Password reset/email verification token workflows, TOTP MFA, OIDC, and optional SAML implementation foundations exist. Live provider integration and security validation remain release gates.

## ADR-010: Published snapshots are separate from editable drafts

**Decision:** Draft saves update the editable representation and revision history. The live public response reads a separate published snapshot that changes only through approved publish/schedule transitions.

**Reason:** Editorial changes must not mutate the live page before publication.

## ADR-011: Third-party plugins execute outside the API process

**Decision:** Plugin metadata is registered and reviewed in SystemFabric, while execution is delegated to a separate runner that accepts only pinned, allow-listed OCI image digests and applies runtime constraints.

**Release gate:** A package archive inspector is not a secure build pipeline. An archive-to-OCI provenance/signature process and adversarial tests against a real isolated runtime remain mandatory. Manifest capability declarations are not themselves a sandbox.

## ADR-012: Production startup remains guarded

**Decision:** The API refuses production startup when core configuration gates are missing. Passing unit tests does not mark the product production-ready.

**Reason:** Live PostgreSQL/Memgraph behavior, full identity lifecycle, production deployment, isolated plugin execution, browser accessibility, load/soak testing, backup restore, and independent security review remain open release gates.


## ADR-013: SAML replay state is shared and consumed atomically

**Decision:** Use PostgreSQL-backed SAML request/replay state with bounded TTL and atomic consume semantics; periodically remove expired cache entries.

**Reason:** In-memory request IDs do not protect a multi-replica deployment from replay across different processes. The shared cache is still subject to live IdP integration and operational validation.

## ADR-014: AI policy is scoped to a site

**Decision:** Global provider allowlists and external-content opt-in are combined with site-level provider/usage policy. AI output remains a validated proposal and cannot directly publish or change permissions.

**Reason:** Provider flexibility must not bypass tenant policy, human review, or document validation.
