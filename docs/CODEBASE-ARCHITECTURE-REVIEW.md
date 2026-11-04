# Codebase Architecture Review

**Review baseline:** `feat/ai-durable-queue-foundation`, based on the merged `main` commit `e54a0b3` (PR #60).
**Scope:** tracked application and package code, scripts, tests, migrations, and architecture documentation. This is a source-level review, not a production security certification or a live-infrastructure assessment.

## Executive summary

VirgoScorpio Hub already has useful architectural seams: domain validation is separate from persistence, AI providers are adapters behind one AI service, PostgreSQL stores are injected, and real-time delivery separates local hub behavior from Redis relay behavior. The main opportunity is to make repeated cross-cutting mechanics live behind a few small, well-tested interfaces without collapsing distinct business workflows into generic frameworks.

This review consolidated four repeated mechanisms:

1. **UUID identity validation** now has one canonical version/variant-aware expression in `packages/domain/src/identifiers.js`. AI context, community workflows, content-type validation, collaboration, task stores, outbox delivery, real-time event contracts, and the API consume that shared definition.
2. **HTML output encoding** now has one five-character encoder in `packages/security/src/output-encoding.js`. Render, math fallback, and curated SVG title rendering use it. The helper is explicitly for HTML text/quoted-attribute contexts, not JavaScript, CSS, URL, or raw-HTML contexts.
3. **PostgreSQL transaction lifecycle** now has a shared `withTransaction(pool, work, options)` module in `packages/db/src/transaction.js`. It owns client acquisition, begin/commit, best-effort rollback, and release. Explicit modes currently support standard read/write and read-only repeatable-read transactions. The AI queue store, relationship store, outbox worker, and graph snapshot reader use it.
4. **Trace identifier syntax** now has one canonical definition in `packages/observability/src/trace-identifiers.js` for trace IDs, span IDs, flags, and request IDs. Trace context parsing and structured log-field validation use the shared expressions, which reject all-zero trace/span identifiers.

The rest of the changes deliberately preserve current module responsibilities and external behavior.

## Architecture map and pressure points

| Area | Observed shape | Architectural assessment |
| --- | --- | --- |
| API composition | `apps/api/src/server.js` is about 2,485 lines; `platform-routes.js` is about 528 lines | The main concentration of HTTP routing, authorization dispatch, and cross-domain orchestration. Keep middleware and policy decisions centralized, but continue extracting cohesive route families behind narrow handler interfaces. |
| PostgreSQL content store | `packages/db/src/postgres-store.js` is about 618 lines | Several content, revision, publication, and owner-scoped read concerns share one pool and schema. Extract only when a cohesive data capability can be moved without weakening tenant predicates or transaction boundaries. |
| Authentication | `packages/auth/src/service.js` is about 509 lines | Several identity lifecycles live together. Potential seams include session lifecycle, MFA, verification, invitations, and site membership, while keeping authorization decisions in one authoritative identity model. |
| Real-time transport | `websocket-gateway.js` is about 664 lines; `redis-realtime.js` is about 580 lines | Complex lease, subscription, authorization invalidation, and reconnect behavior. Prefer internal helpers with behavior-focused tests; avoid hiding different delivery guarantees behind a generic transport abstraction. |
| Background work | Outbox, consumer delivery, mail, scheduler, graph projection, and the new AI queue each have worker loops | Repeated polling, cancellation, retry, and lease mechanics are worth continued comparison. The acknowledgement, ordering, durability, and idempotency contracts are not interchangeable. |

## Reusable patterns: adopted and remaining

### Adopted in this change

- **Identifiers:** repeated RFC-compatible UUID regexes are now centralized. Callers keep their own error messages and status codes; only the shared syntactic contract is common.
- **Output encoding:** the encoder is shared at the point of output. It is intentionally not a general-purpose sanitizer and must not be used to prepare SQL, CSS, JavaScript, URLs, or trusted markup.
- **Transactions:** the database helper returns the work result only after commit and preserves the original operation/commit error if rollback also fails. Transaction mode is selected from a closed allow-list.
- **Trace identifiers:** trace, span, flag, and request-ID syntax is centralized; zero trace/span identifiers are rejected before logging or context use.

### Remaining duplication to address incrementally

- **Transaction ownership:** transaction boilerplate remains in authentication, community workflows, library persistence, commerce reconciliation, API route handlers, and the main content store. Migrate one cohesive module at a time, retaining tests for rollback, commit ordering, and post-commit side effects.
- **HTTP body parsing:** API and plugin-runner JSON parsers overlap but have different body ceilings, response codes, and trust contexts. Define one explicit request-body contract before considering a shared HTTP parser.
- **Error-code normalization:** several adapters cap or validate provider/database error identifiers differently. A future shared sanitizer should be introduced only after defining whether it returns nullable values, preserves known application codes, and what fallback each subsystem requires.
- **Secret comparison:** authentication, CSRF, metrics, and provider-signature code all use constant-time comparisons, but their input encodings and empty-value policies differ. Share the byte-comparison primitive only after retaining each caller's policy checks.
- **Worker loops:** compare polling, signal propagation, lease renewal, backoff, terminal-state handling, and shutdown behavior across workers. Keep domain acknowledgement and retry policy local unless two real worker adapters demonstrate the same contract.

## Recommended refactoring sequence

1. **Finish transaction-helper adoption** in the smaller persistence modules first, then evaluate the content store and route handlers. Keep transaction callbacks free of external side effects; emit events or send HTTP responses only after the helper resolves.
2. **Deepen route-family seams** around existing API composition: a route family should receive a small, explicit context containing only the dependencies and authorization functions it needs. Avoid passing the entire server closure or a broad mutable object to every route.
3. **Separate large persistence capabilities** only where query ownership and invariants are already coherent. Keep site/actor predicates adjacent to data access and test them at the store interface.
4. **Compare worker contracts** before extracting shared polling/lease primitives. Preserve at-least-once semantics, aggregate ordering, claim ownership, idempotency, and shutdown behavior explicitly.
5. **Add architecture guardrails** to the regular validation suite: required-path/syntax verification, security regression tests, tenant-isolation tests, and real database/browser checks where infrastructure is available.

## Verification and limitations

- `npm run check` passed on this worktree: 424 tests, 421 passed, 0 failed, 3 platform-specific skips.
- Artifact verification passed: 188 required paths and 199 JavaScript files syntax-checked.
- Targeted tests passed for shared UUID/trace identifier validation, HTML output encoding, transaction rollback/commit/release behavior, AI queue persistence, outbox delivery, graph projection, and page rendering.
- The environment is Windows with Node.js 26.12.1. Three tests are skipped by existing platform guards.
- Fresh PostgreSQL migration and live Memgraph/Redis integration were not run in this environment: the Docker daemon is unavailable and no dedicated `TEST_DATABASE_URL` is configured. The new migration therefore remains subject to the existing fresh-migration and integration release gates.
- No external AI provider calls or production credentials were used. No production-readiness claim is made.

## Design rule

Prefer a deep module with a small interface and a strong internal implementation. Extract shared mechanics where the behavior is genuinely the same; keep authorization, transaction ownership, retry policy, and domain-specific error contracts visible where they differ.
