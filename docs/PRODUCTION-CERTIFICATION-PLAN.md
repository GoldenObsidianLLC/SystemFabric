# SystemFabric 0.5.1 — Production Certification Execution Plan

> **Decision: NO-GO.** This plan organizes the 13 missing formal evidence gates and the one partial dependency-review check recorded in the 2026-10-31 readiness snapshot. It is a work plan, not evidence that any gate has passed.

## 1. Baseline and operating rules

The latest retained readiness snapshot reports 9 pass, 1 partial, 0 blocked, 13 missing evidence, and 0 not run. The report was generated on 2026-10-31 at `f4d78c6037a658006e72785d9bcc403b3508ec6d`, before its evidence-reporting change was squash-merged. The resulting main commit is `81e31b235a846c291d3d100eb33c08bf0ecd86cf`. PR #12 checks and the post-merge main workflow passed all five CI jobs, including the supported Node.js matrix, PostgreSQL/Memgraph integration, browser smoke, and CodeQL. Those results validate the tested source/CI paths; they do not close the independent or provider evidence gates below.

The readiness report and evidence format remain authoritative:
- [Readiness assessment](RELEASE_READINESS.md)
- [Latest human-readable report](../artifacts/release-readiness.md)
- [Latest machine-readable report](../artifacts/release-readiness.json)
- [Evidence format](RELEASE-EVIDENCE.md)
- [Security model and reporting boundaries](SECURITY.md)

Rules for this work:
1. Evidence must identify the exact candidate commit, environment, provider/service versions, procedure, result, reviewer, date, and retained artifact paths. Redact credentials, personal data, tokens, and sensitive provider responses.
2. A test definition, adapter interface, mock, unit test, green CI run, or local smoke test is not live-provider or independent-review evidence.
3. Reviewers must be independent of the implementation being reviewed. An implementer may prepare evidence, but must not self-approve an independent gate.
4. A gate may be excluded only by an explicit release-scope decision and corresponding product/configuration changes that disable or remove the excluded capability. Do not mark an untested capability as passed or quietly waive a gate.
5. Keep public issues at the level of scope, process, and remediation status. Share exploit details and sensitive evidence only through the repository's security-reporting process.
6. Keep the release classification `NOT_PRODUCTION_CERTIFIED` and `readyForProduction: false` until all in-scope gates have accepted evidence and the release owner signs off.

## 2. Workstream sequence

### Phase 0 — Freeze the candidate scope and provider matrix

Before provisioning external systems, record a release-scope decision for SystemFabric 0.5.1:

| Decision | Required record |
|---|---|
| Deployment topology | Single-node or multi-node; supported OS/runtime; database, graph, cache/relay and plugin-runner topology. |
| Identity | Which OIDC and/or SAML providers, email-delivery service, MFA methods, recovery channels and account lifecycle flows are enabled. |
| Object storage | Which of local storage, S3, GCS, Azure Blob or S3-compatible services are enabled and supported in this release. |
| Malware scanning | Selected scanner/version, daemon topology, fail-closed behavior and legacy-asset policy. |
| Payments | Whether Stripe Checkout, webhooks, refunds and recurring subscriptions are enabled; test-mode validation scope. |
| Plugin execution | Supported runner/runtime, image policy, isolation controls, network policy and resource limits. |
| Browser/product scope | Supported browsers, accessibility target, and explicitly included/excluded commerce and community capabilities. |
| Operations | Target environment, owner, monitoring, backup/restore strategy, rollback path and support expectations. |

**Scope rule:** validate every provider and feature enabled or claimed for the candidate. Where the release supports only a selected provider, validate that selected provider end to end and explicitly mark the other adapters unavailable/not supported for this release. A provider matrix is a scope decision, not proof of a successful integration.

### Phase 1 — Independent tenancy and authorization review (start here)

Commission an independent reviewer to challenge tenant/site boundaries across the application, not merely rerun the existing regression tests. The merged tenant-isolation tests are useful targeted evidence but are not an independent assessment.

Reviewer scope:
- Inventory HTTP/API routes, authentication and authorization middleware, capability checks, object lookup/update/delete paths, and administrative routes.
- Trace tenant/site scoping through PostgreSQL queries and transactions, background jobs, event/outbox consumers, Memgraph projections, caches, realtime presence/document channels, exports, downloads, and provider callbacks/webhooks.
- Challenge direct-object-reference handling, cross-site identifiers, role/capability escalation, stale sessions, revoked access, missing/forged identity context, and authorization rechecks on long-lived connections.
- Verify that tenant context is derived from trusted authenticated context and cannot be selected or overridden by untrusted request fields.
- Review error paths and side effects: a denied request must not leak object existence, mutate data, publish events, enqueue work, or trigger external provider actions across tenant boundaries.
- Build an adversarial two-tenant matrix with colliding or guessable object identifiers and both permitted and denied operations.

Minimum test matrix:
- Tenant A read/list/create/update/delete/export/download against Tenant B resources: all denied with no side effects.
- Same-tenant authorized and unauthorized roles/capabilities, including privileged/admin paths.
- Missing, malformed, stale, rotated, revoked or mismatched session/identity context.
- Cross-site subscriptions, SSE/WebSocket presence and document hints, reconnect and reauthorization.
- Background/queued work, event replay, graph projection, cached lookups and signed/temporary asset access.
- Provider webhooks/callbacks and asynchronous reconciliation where tenant/site context is relevant.
- Negative assertions for event emission, audit records, external calls and database mutations after denial.

**Exit evidence:** a signed independent report covering scope/methodology, reviewed commit, route/capability coverage, findings with severity and reproduction references, remediation references, retest results, explicit residual risk, reviewer identity/date, and an accepted `artifacts/evidence/tenant-isolation-review.json`. Do not put exploit steps or sensitive data in the public evidence summary.

### Phase 2 — Live identity, scanning, storage and payment integrations

Run each test against a dedicated non-production account/project/bucket and test-mode payment account. Capture sanitized configuration and provider request/correlation IDs, never secrets.

- **Identity:** exercise the chosen OIDC/SAML provider(s), email delivery, account verification, MFA enrollment and recovery, state/nonce/PKCE or SAML signature/replay defenses, authorization mapping, session rotation/logout, replay/expiry, provider outage and recovery. Evidence: `artifacts/evidence/identity-provider-e2e.json`.
- **Malware scanning:** use a safe, recognized test corpus (including EICAR where appropriate), benign files and malformed/boundary inputs; test timeout, daemon unavailable, scan error, false-positive review, fail-closed upload behavior, quarantine, and legacy `not_scanned` assets through rescan/retention/deletion. Evidence: `artifacts/evidence/clamav-corpus.json`.
- **Object storage:** for every provider in the frozen scope, verify real credential resolution, least-privilege list/read/write/delete, multipart behavior where used, denied permissions, encryption, retention/lifecycle, object-version behavior, timeout/unavailable behavior, credential rotation, orphan reconciliation, and restore/recovery. Evidence: `artifacts/evidence/cloud-live-providers.json`.
- **Stripe:** use test mode; validate Checkout creation and idempotency, signed webhook verification, duplicate/out-of-order/replayed events, invalid signatures, network timeout/5xx ambiguous outcomes, provider lookup/reconciliation, stock reservation commit/release, refunds and enabled subscription lifecycle. Prove replay does not double-commit, double-refund or incorrectly restock. Evidence: `artifacts/evidence/stripe-live-lifecycle.json`.

Do not use production customer data or live payment collection for these acceptance tests. Keep test accounts isolated and clean up resources after evidence capture.

### Phase 3 — Browser, accessibility and feature-scope acceptance

- **Browser/accessibility:** execute the full declared browser matrix, not only the existing 9-test smoke suite. Add keyboard-only workflows, visible focus, focus order/return, dialogs and menus, form errors, zoom/reflow, contrast, accessible names/roles/states, and manual screen-reader acceptance. Record browser/OS/assistive-technology versions and unresolved exceptions. Evidence: `artifacts/evidence/browser-accessibility.json`.
- **Commerce:** define the release's explicit supported subset and test tax, shipping, discount/coupon behavior, inventory, order/payment reconciliation, cancellation/refund, fulfilment/download entitlements and subscriptions end to end. The feature model currently records some foundations as incomplete; do not claim full commerce parity without completing and accepting the corresponding flows. Evidence: `artifacts/evidence/commerce-parity-acceptance.json`.
- **Community:** define and test the supported subset for group privacy, membership and visibility, forums, messaging, reporting/moderation/abuse controls, search, export and deletion. The current manifest explicitly says several of these capabilities remain incomplete. Exclude incomplete functionality from the release claims and ensure it is not represented as production-ready. Evidence: `artifacts/evidence/community-parity-acceptance.json`.

### Phase 4 — Plugin isolation and software supply-chain review

- Validate the plugin build, signing, provenance and verification pipeline with an actual supported runner. Demonstrate trusted key handling/rotation and rejection of unsigned, altered, untrusted or stale artifacts.
- Run adversarial plugin tests against the real execution boundary: filesystem and host access, process escape, privilege escalation, network egress/SSRF, secret exposure, malicious input, CPU/memory/PID/disk exhaustion, timeout/termination and noisy-neighbor isolation.
- Verify the runtime's user identity, filesystem mounts/permissions, syscall/container policy, network policy and resource enforcement. Document any platform-specific limitation.
- Have a maintainer review the committed lockfile and full dependency tree, including transitive dependencies, pinned versions, optional/native packages, lifecycle scripts, licenses and known advisories. Reconcile the SBOM to the candidate install; review provenance/attestation and the current CodeQL/dependency-analysis records for the release revision.

Evidence: `artifacts/evidence/plugin-container-isolation.json` and `artifacts/evidence/dependency-sbom-codeql.json`. The existing clean `npm ci`, audit, generated SBOM and CodeQL checks are useful inputs, but do not by themselves complete the maintainer review or runtime isolation test.

### Phase 5 — Load, recovery, operations and final security approval

- Define workload assumptions, SLOs, concurrency, throughput, data volume and target topology before running load tests. Execute ramp, sustained soak, burst, resource-exhaustion and fault-injection scenarios; capture latency/error/queue/resource trends and recovery behavior.
- Restore from backups into an isolated environment. Verify PostgreSQL, graph projection and every in-scope object-storage component; measure actual RPO/RTO, verify data consistency and permissions, and test crash/restart recovery. Prove documented rollback steps.
- Complete the independent security assessment across the in-scope threat model, track all findings, fix and retest critical/high findings, and obtain explicit risk acceptance for any remaining material finding from an authorized owner.
- Review deployment/rollback runbooks, migrations, configuration, secret provisioning/rotation, monitoring/alerting, incident response, data retention/deletion, backup schedule and restore contacts. Conduct a practical release/rollback or incident tabletop.
- The named operations/release owner signs the approval for the exact release commit and scope only after all required evidence is accepted.

Evidence: `artifacts/evidence/load-backup-restore.json`, `artifacts/evidence/independent-security-review.json`, and `artifacts/evidence/operations-release-approval.json`.

## 3. Formal evidence gate register

The evidence IDs and paths below map to the formal gates in `artifacts/release-readiness.json`. Each gate remains open until an evidence file is present, validated, reviewed and tied to the release candidate.

| # | Gate ID | Required evidence artifact | Primary accountable role |
|---:|---|---|---|
| 1 | `tenant-isolation-review` | `artifacts/evidence/tenant-isolation-review.json` | Independent application-security reviewer |
| 2 | `identity-provider-e2e` | `artifacts/evidence/identity-provider-e2e.json` | Identity/integration owner |
| 3 | `clamav-corpus` | `artifacts/evidence/clamav-corpus.json` | Platform/security test owner |
| 4 | `cloud-live-providers` | `artifacts/evidence/cloud-live-providers.json` | Storage/infrastructure owner |
| 5 | `stripe-live-lifecycle` | `artifacts/evidence/stripe-live-lifecycle.json` | Commerce/payments owner |
| 6 | `browser-accessibility` | `artifacts/evidence/browser-accessibility.json` | QA/accessibility reviewer |
| 7 | `commerce-parity-acceptance` | `artifacts/evidence/commerce-parity-acceptance.json` | Product/commerce acceptance owner |
| 8 | `community-parity-acceptance` | `artifacts/evidence/community-parity-acceptance.json` | Product/community acceptance owner |
| 9 | `plugin-container-isolation` | `artifacts/evidence/plugin-container-isolation.json` | Plugin/runtime security reviewer |
| 10 | `dependency-sbom-codeql` | `artifacts/evidence/dependency-sbom-codeql.json` | Maintainer/supply-chain reviewer |
| 11 | `load-backup-restore` | `artifacts/evidence/load-backup-restore.json` | SRE/operations owner |
| 12 | `independent-security-review` | `artifacts/evidence/independent-security-review.json` | Independent security assessor |
| 13 | `operations-release-approval` | `artifacts/evidence/operations-release-approval.json` | Named operations/release owner |

### Additional partial check — dependency/lockfile review

The committed lockfile installs cleanly, but an explicit human maintainer review remains incomplete. Review dependency provenance, direct/transitive version choices, install scripts, optional/native modules, licenses, advisories, SBOM consistency, and intended runtime inclusion. Record reviewer/date and findings in the dependency evidence artifact; do not treat a successful `npm ci` or zero-vulnerability audit as a substitute.

## 4. Evidence acceptance checklist

For every evidence artifact, include at least:
- Gate ID, outcome, and concise scope statement.
- Full SystemFabric commit SHA and repository revision reviewed.
- Environment/topology, OS, Node.js and database/service/provider versions.
- Test account/project identifiers in redacted form; no credentials or secrets.
- Exact commands or human procedure, with inputs/test fixtures described safely.
- Results with pass/fail/blocked/not-run counts and any skips.
- Retained raw logs/reports and stable relative paths; hashes where practical.
- Reviewer name or accountable role, independence statement where required, and UTC date.
- Findings, linked remediation commits/issues, retest outcome, caveats and approved residual risks.

Evidence is acceptable only when it is reproducible, current for the candidate, relevant to the frozen scope, complete enough for independent scrutiny, and reviewed by the accountable role. A missing artifact is not a pass. A waived or out-of-scope gate must be explicitly documented in the scope decision, with the associated feature disabled and the release claims corrected.

## 5. Release exit criteria

Production certification is **NO-GO** until:
1. The target release scope/provider matrix is approved and matches the shipped configuration and claims.
2. Every in-scope formal gate has current, accepted evidence for the exact candidate revision.
3. Critical/high security findings are resolved and retested, or formally accepted by an authorized risk owner with rationale and expiry.
4. Backup restoration, rollback, secret rotation and incident procedures have been exercised in a representative environment.
5. The readiness report is regenerated for the release candidate and its source SHA is reconciled with the candidate under review.
6. The named release owner records an explicit approval and any scope limitations.

Until then, SystemFabric remains an expanded developer preview and must not be represented as production-certified.

## Appendix A — Independent reviewer source map

This is a navigation aid for the review, not a statement that these files have been exhaustively inspected or that any security conclusion has been reached.

| Area | Starting files | Review emphasis |
|---|---|---|
| API identity and tenant resolution | `apps/api/src/server.js` | Authentication/session resolution, `siteIdFor`, `requireCapability`, route ordering, site/member management and real-time upgrade authorization. |
| Platform route dispatch | `apps/api/src/platform-routes.js` | Library, commerce/membership, community, firewall and cloud-connection handlers; verify every selector and database operation. |
| Authentication and federation | `packages/auth/src/service.js`, `oidc.js`, `saml.js`, `totp.js` | Membership lookup, role/capability evaluation, session lifecycle, federated subject mapping, MFA and recovery. |
| Data/event processing | `packages/db/src/postgres-store.js`, `outbox-delivery.js`, `outbox-worker.js`, `packages/graph/src/memgraph-store.js`, `rebuild-projection.js` | Query scope, transactions, delayed jobs, outbox replay, projection isolation and rebuild semantics. |
| Library and object access | `packages/library/src/file-store.js`, `reconcile-local-objects.js`, `packages/cloud/src/storage-adapters.js` | Site-scoped asset metadata and bytes, download/public URL behavior, variants, object reconciliation and provider callbacks. |
| Realtime/collaboration | `packages/realtime/src/sse-gateway.js`, `websocket-gateway.js`, `event-hub.js`, `redis-presence.js`, `redis-realtime.js`, plus collaboration storage modules | Site/document subscription authorization, session expiry/revocation, cross-instance relay, cache/key partitioning and replay. |
| Existing regression tests | `test/integration/tenant-isolation.integration.test.js`, `test/realtime.test.js`, `test/realtime-websocket.test.js`, `test/redis-realtime.test.js` | Establish what is covered, then identify missing route families, roles, lifecycle cases and failure paths. |

The current `test/integration/tenant-isolation.integration.test.js` is a valuable focused regression test: it creates two sites and verifies a site-B-only actor cannot access or write to site A's community feed, and that conflicting/malformed route, header, query and body site selectors are rejected. It also verifies a valid own-site request succeeds. That test does **not** establish full route-family coverage or replace the independent assessment.

The reviewer should build a complete route-to-capability inventory from the current candidate, map each route to the relevant data/event/storage side effects, and record test coverage gaps as findings or explicit limitations. Review the full files at the candidate commit; the table above is not an exhaustive route inventory.

## Appendix B — GitHub execution tickets

The open tickets below provide per-gate execution and evidence tracking. No reviewer or service owner has been assigned yet; ownership fields remain role-based until a qualified person is confirmed.

| Work item | GitHub issue |
|---|---|
| Freeze 0.5.1 release scope/provider matrix (prerequisite) | [#13](https://github.com/GoldenObsidianLLC/SystemFabric/issues/13) |
| Independent tenant/site isolation review — first review task | [#14](https://github.com/GoldenObsidianLLC/SystemFabric/issues/14) |
| Identity provider and MFA lifecycle evidence | [#15](https://github.com/GoldenObsidianLLC/SystemFabric/issues/15) |
| Malware-scanning corpus and legacy-asset quarantine | [#16](https://github.com/GoldenObsidianLLC/SystemFabric/issues/16) |
| Live object-storage provider validation | [#17](https://github.com/GoldenObsidianLLC/SystemFabric/issues/17) |
| Stripe checkout/webhook/payment lifecycle | [#18](https://github.com/GoldenObsidianLLC/SystemFabric/issues/18) |
| Browser and manual accessibility acceptance | [#19](https://github.com/GoldenObsidianLLC/SystemFabric/issues/19) |
| Commerce acceptance | [#20](https://github.com/GoldenObsidianLLC/SystemFabric/issues/20) |
| Community acceptance | [#21](https://github.com/GoldenObsidianLLC/SystemFabric/issues/21) |
| Plugin pipeline and runtime isolation | [#22](https://github.com/GoldenObsidianLLC/SystemFabric/issues/22) |
| Lockfile, SBOM, provenance and CodeQL review | [#23](https://github.com/GoldenObsidianLLC/SystemFabric/issues/23) |
| Load, fault-injection and backup/restore drills | [#24](https://github.com/GoldenObsidianLLC/SystemFabric/issues/24) |
| Independent security assessment | [#25](https://github.com/GoldenObsidianLLC/SystemFabric/issues/25) |
| Operations runbooks and release-owner approval | [#26](https://github.com/GoldenObsidianLLC/SystemFabric/issues/26) |

Start with #13 to freeze the supported release scope, then #14 to commission the independent tenant/site review. Provider-specific work in #15–#18 should use only the resulting approved provider matrix. The 13 evidence gates remain open until their respective artifacts are accepted; opening an issue does not change the readiness status.
