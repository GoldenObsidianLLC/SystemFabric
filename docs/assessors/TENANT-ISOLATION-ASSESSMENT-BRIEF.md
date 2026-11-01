# SystemFabric 0.5.1 — Independent Tenant-Isolation Assessment Brief

**Purpose:** commission and guide the independent application-security review tracked by [GitHub issue #14](https://github.com/GoldenObsidianLLC/SystemFabric/issues/14).

> **Status: ASSESSOR PACKET ONLY — NO REVIEW HAS BEEN PERFORMED.** This document is a hand-off aid. It is not a security assessment, a pass, a waiver, or certification evidence. The reviewer must be independent of the implementation team and must record their own methods, results, findings, and limitations.

## 1. Candidate and boundaries

| Field | Value |
|---|---|
| Repository | `GoldenObsidianLLC/SystemFabric` |
| Product version | `0.5.1` |
| Pre-packet application-source baseline | `ab55892dc33b87d8be4165e13931cd6888f358a1` |
| Candidate branch | `main` |
| Formal gate | `tenant-isolation-review` |
| Evidence destination after completion | `artifacts/evidence/tenant-isolation-review.json` |
| Coordination issue | [#14 — Independent tenant/site isolation and authorization review](https://github.com/GoldenObsidianLLC/SystemFabric/issues/14) |
| Technical plan | [docs/PRODUCTION-CERTIFICATION-PLAN.md](../PRODUCTION-CERTIFICATION-PLAN.md) |
| Scope proposal | [docs/RELEASE-SCOPE.md](../RELEASE-SCOPE.md) |

The SHA above is the application-source baseline before the assessor packet was added. The prior release-scope and assessor-packet changes were documentation-only, but the assessor must independently verify this by comparing application source on current `main` with the baseline above. For the actual assessment, check out a clean current `main`, run `git rev-parse HEAD`, and record that exact full SHA in the assessor's report. If application source differs from the baseline, include those changes in the review scope. The final report and machine-readable evidence must identify exactly the commit actually reviewed. The readiness validator rejects a passing evidence record when its `commit` differs from current Git HEAD, so populate that field from the final reviewed checkout rather than copying a stale SHA from this hand-off document.

The 0.5.1 scope proposal remains pending named product/release-owner approval on issue #13. That product decision is separate from this technical review. Do not infer scope approval or production readiness from this packet.

### In-scope security question

Can an authenticated actor, request, job, event, realtime connection, administrator workflow, or external callback access, disclose, mutate, or cause side effects against another tenant/site's data without an explicitly authorized cross-tenant capability?

Assess isolation end to end, including authorization at the point of use. Do not limit the work to checking the `siteId` selector or repeating the one existing community-feed integration test.

### Out of scope for this gate

This review does not replace the broader independent security assessment, live identity-provider tests, malware-scanner tests, cloud-provider tests, payment tests, browser accessibility review, load/recovery drills, or operations sign-off. Record security issues discovered outside tenancy/authorization scope and refer them to the owner, but do not claim those other gates have passed.

## 2. Independence and safe handling requirements

The reviewer should have demonstrable application-security experience with multi-tenant web applications, authorization, and asynchronous/realtime systems. Before access is granted, record:

- Reviewer name, organization, role, and relevant qualifications.
- A declaration that the reviewer did not implement the code or controls under review and is not approving their own work.
- Any financial, employment, advisory, or other conflicts that could affect independence.
- The review start/end dates, agreed scope, access method, and confidentiality/security-reporting channel.

Use a dedicated, isolated test environment and synthetic data. Never run adversarial tests against production, real customer data, or shared staging data. Do not place credentials, tokens, personal information, private customer data, or sensitive exploit steps in this public repository. Report actionable exploit details through the agreed access-controlled security channel; public issues should contain only sanitized impact, severity, remediation reference, and status.

## 3. Required review activities

### A. Establish the review baseline

1. Confirm the repository and full commit SHA.
2. Verify the working tree for the reviewed checkout is clean.
3. Record Node.js, OS, PostgreSQL, Memgraph, Redis, and other enabled service versions.
4. Inspect the release manifest and current feature/configuration flags. Distinguish implemented, enabled, disabled, mocked, and unvalidated paths.
5. Re-run relevant tests on the pinned source and retain sanitized logs. Mark skips and unavailable integrations explicitly; a green unit test or CI run is not independent review evidence.

Suggested baseline commands:

```sh
git rev-parse HEAD
git status --short
node --version
npm ci
npm test
```

For PostgreSQL integration coverage, use a disposable local database dedicated to this review (database name should clearly end in `_test`). The existing tenant integration test is gated by `DATABASE_URL` and `SYSTEMFABRIC_RUN_POSTGRES_INTEGRATION=true`:

```sh
# Set DATABASE_URL to a disposable local review database only.
# Do not point this at production, shared staging, or a developer database.
SYSTEMFABRIC_RUN_POSTGRES_INTEGRATION=true npm run test:integration
```

On Windows PowerShell, set the same environment variable with `$env:SYSTEMFABRIC_RUN_POSTGRES_INTEGRATION = 'true'` before running the command. Record all tests skipped because a provider, service, or environment was unavailable.

### B. Build a complete attack-surface inventory

Create a route-to-capability/data-access inventory from the pinned source. Include, at minimum:

- HTTP methods, paths, route parameters, request selectors, and whether authentication is required.
- The actor/session source and tenant/site context derivation for each route.
- Required capabilities/roles and where they are checked.
- Object identifiers accepted from path, query, headers, body, events, or provider payloads.
- Data stores and side effects: PostgreSQL, library bytes/metadata, graph projection, caches, outbox, queues, realtime, external providers, and audit logs.
- Administrative, developer, membership/invitation, and ownership-transfer paths.
- Negative test coverage and any route family not exercised.

Do not assume that a helper's presence means every route uses it correctly. Trace request handling through lookup, authorization, mutation, and side effects.

### C. Challenge tenant context and identity

Use at least two tenants/sites (A and B), multiple actors with deliberately different memberships and capabilities, and unique synthetic marker data in each tenant. Include owner/admin and least-privilege roles where applicable.

Challenge:

- Missing, malformed, duplicate, conflicting, and mismatched path/header/query/body site selectors.
- Direct-object references using identifiers created in the other site, including guessable or deliberately reused identifiers where the data model permits.
- Missing, invalid, expired, rotated, revoked, stale, and mismatched sessions or identity context.
- Membership removal, role/capability changes, invitation acceptance/revocation, and administrator/developer paths.
- Any path that accepts a tenant ID, site ID, account ID, actor ID, or object ID from an untrusted field.
- Authorization time-of-check/time-of-use gaps and long-lived sessions/connections after privilege revocation.

Confirm that trusted tenant context is derived from the authenticated principal and authorized membership—not from caller-controlled selectors alone.

### D. Test data and operation boundaries

For Tenant A's resources, attempt operations as Tenant B and as unauthorized/least-privilege users. Cover read, list/search, create, update, delete, export, download, history/version access, and any other exposed object operation.

Cover the following resource families where implemented/enabled:

- Pages, content types, content records, taxonomies, menus, templates, revisions, and editor/publishing workflows.
- Media and library assets: metadata, bytes, variants, versions, optimization, public/private URLs, signed/temporary links, and reconciliation.
- Commerce: products, carts, orders, stock reservations, checkout state, refunds, subscriptions, entitlements, and associated metadata.
- Community/membership: profiles, groups, memberships, feeds, messages, moderation, invitations, and privacy settings.
- Site configuration, domains, cloud connections, firewall/security configuration, API tokens, roles, users, and administrative operations.

Do not mark absent or disabled capabilities as passed. Record whether a feature is not implemented, disabled by scope, or simply not tested.

### E. Trace asynchronous and cross-instance behavior

Follow tenant context through:

- Outbox creation, delivery, retry, replay, dead-letter handling, and worker execution.
- Scheduled/background jobs and delayed callbacks.
- PostgreSQL transactions and graph projection/rebuild/reconciliation.
- In-memory and Redis caches, presence, subscriptions, connection quotas, and cross-instance relays.
- Server-sent events, WebSocket subscriptions, collaborative document channels/operations, reconnect, and reauthorization.
- Storage/provider callbacks, payment webhooks, and asynchronous reconciliation.

Test that a user cannot subscribe to, replay, infer, or cause cross-site work; that tenant context cannot be lost or substituted between enqueue and execution; and that revoked access is rechecked where the lifecycle requires it.

### F. Verify denied requests have no cross-tenant side effects

For every meaningful denied operation, assert more than the HTTP status. Check that the denial does not:

- Return another tenant's object, fields, marker strings, counts, existence, or metadata.
- Insert, update, or delete another tenant's data.
- Emit an event, enqueue work, advance a workflow, update a graph projection, or poison a shared cache.
- Trigger an external provider action, create a signed URL, or disclose an asset location.
- Leak sensitive details in errors, logs, audit records, timing, or realtime messages.

Record expected versus actual database state, emitted events, queue/outbox changes, cache/graph effects, provider calls, and response bodies using synthetic data.

## 4. Minimum adversarial coverage matrix

The assessor should extend this matrix to every route family discovered. Add explicit coverage references (test ID, procedure ID, report section, or artifact) and mark each row **pass**, **fail**, **not run**, or **not applicable with rationale**.

| Area | Required adversarial cases | Expected security property |
|---|---|---|
| Tenant selection | Route A with B in header/query/body; malformed, duplicated, or conflicting selectors | Reject before data access; caller input cannot switch tenant context |
| Authentication/session | Missing, invalid, expired, revoked, rotated, mismatched session; membership removed mid-session | No access after required authentication/authorization check |
| Object authorization | A's IDs used by B for read/list/create/update/delete/export/download/history | Denied without disclosing object existence or changing A's data |
| Capability boundaries | Same tenant, but actor lacks read/write/admin capability; owner/admin routes | Least privilege enforced independently of site membership |
| Search/list/filter | Search terms, pagination, counts, aggregate and filter paths crossing sites | No cross-tenant rows, counts, facets, or inference |
| Library/media | Asset bytes, versions, variants, optimization, temporary/public URLs | Site-scoped metadata and byte access; no unauthorized URL issuance |
| Commerce | Order/cart/product/stock/reservation/refund/subscription/entitlement identifiers | No IDOR, cross-site state transition, or provider action |
| Community/membership | Profiles, groups, feed, messages, member list, invitations, moderation | Site boundary and configured privacy rules hold |
| Admin/developer | User, role, membership, cloud, domain, API-key, and site-management actions | Privileged paths require explicit authorized capability |
| Outbox/workers | Replay, retry, dead-letter, scheduled job, stale or forged site context | Tenant scope survives enqueue and execution |
| Graph/cache | Projection, rebuild, lookup, cache key and reconciliation collisions | Tenant-specific data remains partitioned; rebuild cannot merge tenants |
| Realtime/collaboration | SSE, WebSocket, presence, document subscription, reconnect, revocation | Authorization checked at subscribe/use and after relevant revocation |
| Provider callbacks | Invalid/replayed/mismatched webhook/callback and reconciliation | Signature/identity plus tenant binding; replay is safe and scoped |
| Denial side effects | Database, events, queues, graph/cache, audit, provider calls, error body | Denied cross-tenant requests have no unauthorized effects or disclosures |

## 5. Source map — starting points, not an exhaustive inventory

The following files are navigational starting points from the production certification plan. The assessor must discover additional modules and call sites rather than treating this table as complete.

| Area | Starting files | Key questions |
|---|---|---|
| API/authentication/tenant resolution | `apps/api/src/server.js` | Authentication/session resolution, tenant selector normalization, `siteIdFor`, `requireCapability`, route dispatch and realtime upgrade authorization |
| Platform route families | `apps/api/src/platform-routes.js` | Library, commerce, membership, community, firewall, cloud-connection handlers; per-operation scoping and authorization |
| Authentication/federation | `packages/auth/src/service.js`, `oidc.js`, `saml.js`, `totp.js` | Membership and role evaluation, subject mapping, session lifecycle, MFA and recovery |
| PostgreSQL/data access | `packages/db/src/postgres-store.js` | Site predicates, transaction boundaries, object lookup/update/delete, joins, aggregate/search paths |
| Outbox/workers | `packages/db/src/outbox-delivery.js`, `outbox-worker.js`, `apps/worker/src/outbox-worker.js` | Event tenant identity, replay, deduplication, delivery, retry and worker authorization |
| Graph projection | `packages/graph/src/memgraph-store.js`, `rebuild-projection.js` | Tenant keying, projection partitioning, rebuild and reconciliation semantics |
| Library/object access | `packages/library/src/file-store.js`, `reconcile-local-objects.js`, `packages/cloud/src/storage-adapters.js` | Metadata/byte separation, storage keys, download/public URL policy, callback and orphan handling |
| Realtime/collaboration | `packages/realtime/src/sse-gateway.js`, `websocket-gateway.js`, `event-hub.js`, `redis-presence.js`, `redis-realtime.js`; collaboration storage modules | Subscription authorization, channel/key partitioning, session expiry/revocation, replay and cross-instance relay |
| Existing tests | `test/integration/tenant-isolation.integration.test.js`, `test/realtime.test.js`, `test/realtime-websocket.test.js`, `test/redis-realtime.test.js` | Identify covered and uncovered scenarios; add independent adversarial cases |

### What the existing tenant-isolation test does and does not prove

`test/integration/tenant-isolation.integration.test.js` currently builds two sites and verifies that a site-B-only actor cannot read or write site A's community feed. It checks malformed, duplicate, and conflicting route/header/query/body site selectors, response redaction, no cross-site write for its write marker, and a valid own-site request.

That is useful targeted regression coverage. It is not a route inventory, does not cover all resource families or asynchronous/realtime paths, and is not an independent security review. The assessor must independently inspect the implementation and expand coverage.

## 6. Finding and remediation protocol

For every finding, record privately:

- Stable finding ID, affected component/route, and affected commit.
- Severity (Critical/High/Medium/Low/Informational) with impact and rationale; add CWE/OWASP mapping and CVSS vector where useful.
- Preconditions, affected tenant boundary, and concise safe reproduction reference. Store sensitive exploit steps only in the access-controlled channel.
- Confidentiality, integrity, and availability impact; affected data classes and whether cross-tenant side effects occurred.
- Remediation owner and linked issue/PR, target fix commit, compensating controls, and retest status.
- Residual risk and explicit risk acceptance details, if any; acceptance must come from an authorized owner, not the assessor or implementer acting alone.

Critical and High findings must be fixed and independently retested, or formally escalated for explicit risk acceptance before this gate can be considered. Do not suppress a finding because the current release proposal excludes a feature if the code remains reachable or enabled in the assessed deployment.

## 7. Required deliverables and gate acceptance

The review is complete only when the assessor supplies:

1. A signed report stating reviewer identity, qualifications, independence/conflicts, dates, exact commit, environment, scope, methodology, tools, limitations, and an executive conclusion.
2. A route-to-capability/data-access inventory with a coverage matrix and explicit untested/not-applicable items.
3. Adversarial two-tenant test results for the minimum matrix, including read/list/create/update/delete/export/download and asynchronous/realtime behavior where implemented.
4. Findings with severity, safe reproduction references, remediation owner/issue, fix commit, and independent retest outcome.
5. A sanitized machine-readable evidence file at `artifacts/evidence/tenant-isolation-review.json` that validates under `scripts/release-readiness.js` and references retained artifacts that actually exist.
6. Remediation and retest of Critical/High findings, or explicit risk acceptance by an authorized owner. Document residual risks and the assessor's recommendation.

Use [docs/templates/tenant-isolation-review.evidence.template.json](../templates/tenant-isolation-review.evidence.template.json) as a starting structure. It is deliberately stored outside `artifacts/evidence/` so that merely adding this template cannot satisfy or alter the formal release gate. Copy a completed, reviewed JSON file to the canonical evidence destination only after the assessment is finished.

The release-readiness validator requires:
- `status` exactly `passed` for a passing gate;
- a parseable ISO timestamp in `executedAt`;
- non-empty `command` and `environment` strings;
- a non-empty `artifacts` array whose relative paths exist in the repository; and
- if a `commit` is supplied, it must match the current Git HEAD when the readiness report is generated.

Do not set `status` to `passed` while findings, retests, coverage, independence, or report acceptance remain incomplete. If the assessment fails or is incomplete, use a non-passing status and keep the gate open. Never alter the release-readiness validator to make incomplete evidence pass.

## 8. Handoff checklist

- [ ] Qualified independent reviewer identified and accepted.
- [ ] Independence and conflict declaration recorded.
- [ ] Candidate commit and review environment reconfirmed.
- [ ] Access-controlled reporting channel established.
- [ ] Two-tenant synthetic test environment prepared.
- [ ] Route/capability/data-access inventory completed.
- [ ] Minimum adversarial matrix executed or every omission justified.
- [ ] Findings assigned and fixes independently retested.
- [ ] Signed report and sanitized retained artifacts stored.
- [ ] Evidence JSON accepted and gate re-evaluated on the exact clean candidate revision.

**Current handoff state:** no independent reviewer is assigned and no independent review result exists. Issue #14 remains open. SystemFabric 0.5.1 remains `NOT_PRODUCTION_CERTIFIED` / NO-GO.
