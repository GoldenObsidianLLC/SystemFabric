# VirgoScorpio Hub 0.6.2 — Tenant Isolation Internal Pre-Review

> **INTERNAL MAINTAINER PRE-REVIEW ONLY.** This is not an independent security assessment, penetration test, certification, or closure of GitHub issue #14. The independent reviewer, exact final revision, findings disposition, retest and formal evidence record remain outstanding.

## Review identity and scope

| Property | Value |
|---|---|
| Product | VirgoScorpio Hub 0.6.2 (unreleased developer preview) |
| Mainline reviewed | 9c28d5501b6e3cfd723f2495d1544beed4f29d4d |
| Candidate change | Relationship-route site-context validation and two-tenant regression coverage |
| Candidate base | 9c28d5501b6e3cfd723f2495d1544beed4f29d4d |
| Review type | Internal maintainer code/test review |
| Independent reviewer | Not assigned / not performed |
| Production disposition | NO-GO / NOT_PRODUCTION_CERTIFIED |

This pass reviewed the shared site-context resolver, relationship route, tenant integration fixtures, relevant route-capability coverage and existing PostgreSQL/Memgraph/outbox tenant-scope patterns. It is narrower than issue #14's full API, worker, provider, cache, storage, realtime and privileged-operation scope.

## Finding and remediation

The relationship collection/item handler in apps/api/src/server.js used the path siteId for authorization and SQL filters, and its POST endpoint checked both relationship endpoints against that same path site. It did not call the shared siteIdFor resolver used by other site-addressed routes.

**Impact assessed:** no cross-tenant disclosure or write was demonstrated from this omission because relationship reads, endpoint lookups, writes and deletion remained constrained to the path site, and the capability check also used the path site. However, the handler silently ignored contradictory site selectors in the header, query string or POST body. This violated the platform's consistent request-context contract and left the route without the same mismatch/repeated-selector defenses as other site-addressed handlers.

**Correction in the candidate:** resolve the path, header, query and POST-body site selectors through the shared siteIdFor function before route authorization or tenant data access. The POST body remains bounded by the existing 32 KB request limit and is parsed once. The existing route-specific capability and path-scoped SQL remain unchanged.

## Adversarial test evidence

The targeted local PostgreSQL command ran against the dedicated virgoscorpio_hub_test database:

    node --test --test-concurrency=1 test/integration/tenant-isolation.integration.test.js test/integration/tenant-content-object-isolation.integration.test.js

Result: **9/9 tests passed, zero failures, zero skips, zero TODOs.**

| Scenario | Expected / observed result |
|---|---|
| Site B relationship GET with conflicting site A header | HTTP 400, ERR_VIRGOSCORPIO_HUB_SITE_CONTEXT_MISMATCH |
| Site B relationship GET with conflicting site A query selector | HTTP 400, same mismatch code |
| Site B relationship DELETE with conflicting site A header | HTTP 400, same mismatch code, before relationship lookup |
| Site B relationship POST with conflicting site A body selector | HTTP 400, same mismatch code, before relationship writes |
| Repeated siteId query selectors | HTTP 400, same mismatch code |
| Site B relationship with site A content as source | HTTP 404, ERR_VIRGOSCORPIO_HUB_RELATIONSHIP_ENDPOINT_NOT_FOUND; no relationship persisted |
| Site B relationship with site A content as target | HTTP 404, same non-disclosing error; no relationship persisted |
| Site B relationship between two Site B content records | HTTP 201; stored site_id, source and target verified as Site B |
| Existing Site B page/revision/collaboration/restore/publish attempts against Site A | HTTP 404; private content omitted and Site A content/revision/workflow/outbox/collaboration state unchanged |
| Existing generic site-context selector cases | Conflicting, repeated and malformed selectors rejected; matching selectors and valid own-site request accepted |

## General repository validation

- npm run check: PASS after route and regression changes.
- Artifact/syntax verifier: 212 required paths and 219 JavaScript files checked.
- git diff --check: PASS.
- Targeted PostgreSQL tenant integration: 9/9, zero skips.
- No database migration, dependency, package-version or public route/response-shape change was introduced. Inconsistent selector combinations now reject using the existing 400 error contract.

## Existing tenant-isolation coverage inventory

| Surface | Repository coverage | Evidence boundary / remaining review |
|---|---|---|
| Site selector reconciliation | test/integration/tenant-isolation.integration.test.js | API route selector cases; does not exhaust every route/middleware/proxy combination. |
| Content, revisions and collaboration | test/integration/tenant-content-object-isolation.integration.test.js | Cross-site object reads/writes and side effects for selected page/revision/collaboration paths. |
| Commerce | tenant-commerce-isolation.integration.test.js and tenant-checkout-idempotency-isolation.integration.test.js | Selected product/order/checkout/idempotency/inventory/Stripe-stub paths; not full provider lifecycle acceptance. |
| Library and media | tenant-library-media-isolation.integration.test.js | Metadata, versions, download, optimization, deletion and public bytes; production object store/CDN/temp-URL review remains. |
| Community | tenant-community-object-isolation.integration.test.js | Groups, conversations, messaging, social graph, reports, moderation and notifications; broader abuse/privacy review remains. |
| Membership administration | tenant-membership-administration-isolation.integration.test.js | Member list/add/remove, invitations, mail/audit side effects; external identity/email integration remains. |
| Route capability gates | test/tenant-route-capabilities.test.js | Denied capability before route-specific store access for selected site routes; not a complete route-to-capability inventory. |
| Realtime and collaboration | test/realtime-tenant-isolation.test.js and integration collaboration suites | Selected site/session/topic boundaries; production multi-node, Redis Cluster, proxy and long-duration fault tests remain. |
| PostgreSQL outbox/event contracts | test/outbox-contract.test.js and test/outbox-delivery.test.js | Site-scope envelope validation, subscriptions, ordering/replay rules; not an independent two-tenant worker review. |
| Memgraph projection | test/integration/memgraph.integration.test.js | Site-scoped node/edge projection and mismatched-site reads in isolated fixtures; full two-site adversarial projection/rebuild review remains. |

## Independent reviewer work still required

The reviewer for issue #14 must be independent of implementation and must review an exact final commit. At minimum:

1. Build and retain a route-to-capability/data-access inventory covering authentication, API routes, PostgreSQL, graph projections, workers/outbox/replay, caches, realtime, object storage, temporary URLs, invitations and privileged/admin paths.
2. Execute adversarial two-tenant read/list/create/update/delete/export/download tests and verify no forbidden side effects, metadata leaks, or cross-tenant asynchronous delivery.
3. Include negative and positive controls, malformed/repeated selectors, stale sessions/membership revocation, retries/replay, graph lag/rebuild and failure recovery.
4. Review database roles/privileges and query boundaries, worker event identity/scope, object-store key/presigned URL policy, cache key namespacing and global configuration paths.
5. Record severity-ranked findings, safe reproduction references, owners, remediation issues and independent retest outcomes. Critical/high findings require remediation and retest or formally approved risk acceptance.
6. Commit the independently authored summary and exact-source machine evidence at the formal path required by issue #14, with reviewer/date and no public secrets or exploit details.

## Gate disposition

**Issue #14 remains OPEN.** This pre-review does not satisfy the independent reviewer requirement and must not be counted as a PASS in the release evidence contract. The broader independent security assessment in issue #25 also remains open. VirgoScorpio Hub remains **NO-GO / NOT_PRODUCTION_CERTIFIED**; no release tag, package publication, GitHub Release or production deployment is authorized.