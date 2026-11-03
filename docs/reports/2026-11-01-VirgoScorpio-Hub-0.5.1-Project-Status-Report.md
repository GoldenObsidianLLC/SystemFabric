# Golden Obsidian LLC - VirgoScorpio Hub 0.5.1 Project Status Report
**As of:** 1 November 2026, 14:58 CST (America/Chicago)
**Overall:** Engineering-positive / production NO-GO
**Release classification:** Expanded developer preview; NOT_PRODUCTION_CERTIFIED

> **Executive decision:** VirgoScorpio Hub 0.5.1 is not ready for production. Candidate PR #36 has passed its hosted engineering checks, but five CodeQL alerts remain open, 13 formal certification gates lack accepted evidence, the release-readiness artifact reports two blockers, and company scope/governance approvals remain pending.

## 1. Executive decision

Overall project assessment: engineering progress is strong, but production certification readiness remains RED / NO-GO. VirgoScorpio Hub 0.5.1 should continue to be treated only as an expanded, isolated developer preview. The recommended release-scope document is not yet approved by a named release owner. No production deployment, live customer data, live payment collection, provider certification, independent tenant-isolation review, or independent security assessment is evidenced.

## Executive status at a glance

The current candidate branch has passed the hosted engineering checks on both Node.js 22.23.4 and 24.22.1, plus PostgreSQL/Memgraph integration, Chromium browser smoke, and CodeQL analysis execution. The latest dedicated live integration artifact reports 22/22 tests passed with zero skips; all 14 database migrations applied on a fresh disposable database and were idempotently skipped on the second pass. The latest two npm audit scopes each report zero vulnerabilities. However, the branch still has five open CodeQL alerts (four High and one Medium), thirteen formal release evidence gates are missing, the release-readiness snapshot itself reports two blockers, and the dependency license/distribution assessment is unresolved.

### Executive dashboard
| Dimension | Current state | Meaning |
| --- | --- | --- |
| Engineering CI | GREEN | Both hosted workflow runs on candidate PR #36 completed all five jobs successfully. |
| Application tests | GREEN | 245/245 VirgoScorpio Hub tests and 92/92 EnginEx tests passed on Linux CI with zero skips. |
| Live integration | GREEN | 22/22 PostgreSQL/Memgraph/product integration tests passed; fresh migrations, outage recovery, and graph rebuild passed. |
| Browser smoke | GREEN / LIMITED | 9/9 Chromium Playwright tests passed; this is not full WCAG or screen-reader acceptance. |
| Supply chain | AMBER | Audits clean and SBOMs generated; optional inventory variance, LGPL notices, provenance, and maintainer sign-off remain open. |
| Static security | AMBER / RED | Eight baseline High alerts no longer appear on the candidate scan; four cookie High and one legacy-code Medium remain open. |
| Tenant isolation | RED / OPEN | Useful route map and regression coverage exist, but no independent assessment or passing evidence artifact exists. |
| Product scope / operations | RED / OPEN | Release scope awaits owner approval; providers, operations drills, backup/restore, and release approval remain unaccepted. |
| Funding / governance | RED / OPEN | No approved budget or liquid reserve; no company operating resolution has been verified as adopted. |

> **Release decision:** NO-GO for production. Continue low-cost engineering and evidence preparation only. Do not merge a PR as if it were production certification, and do not widen release claims beyond the recommended developer-preview scope.

## 2. Reporting basis and revision control

This report is a point-in-time assessment prepared for 1 November 2026 at 14:58 Central Standard Time (America/Chicago). It reconciles the repository, committed release documentation, GitHub pull requests and issue tracker, latest workflow runs, downloaded CI evidence artifacts, and CodeQL alert state. Evidence freshness is bounded by the latest completed PR workflow run on 1 November 2026 at 19:18 UTC (13:18 CST); no later completed candidate workflow was identified during preparation.

### Revision identifiers
| Item | Verified value | Interpretation |
| --- | --- | --- |
| Repository | GoldenObsidianLLC/VirgoScorpio-Hub | Public repository; current default branch is main. |
| main | 1a903b8eab4304dd61b2489381b091d34f1ea546 | Current main SHA at report time; candidate fixes are not merged into main. |
| Candidate branch | fix/codeql-high-alert-remediation | Branch proposed by PR #36. |
| Candidate head | f9d463ef9ca82d15c9220e15cf50df2ba6367a11 | Latest PR #36 source commit. |
| PR #36 | OPEN / DRAFT | Ten commits; 21 changed files; all hosted checks passed. |
| PR #35 | OPEN / NOT DRAFT | Overlapping earlier CodeQL remediation branch; separate head db18267cece70e30be52425cd66c400b7480d82b. |
| GitHub PR merge ref in readiness artifacts | 15f35a4f28e547b8437c5f034722096e2b3a16db | The generated CI readiness report records this merge-ref checkout SHA; candidate head and merge-ref identity should be reconciled before final release evidence. |

## Important branch caveat

PR #35 and PR #36 are both open and target main. Their changes overlap, but their branch histories have diverged: a GitHub compare between their heads reports 10 commits ahead and 5 behind. PR #36 is more extensive and remains a draft; PR #35 is marked ready for review. Neither has a requested human reviewer, and no human review approval was found. The project should select one canonical change set, reconcile non-overlapping work and documentation, then close the superseded PR only after a reviewed comparison. Do not merge both independently.

## Local workspace caveat

The local candidate worktree was on f9d463e and had one untracked file, test/integration/billing-webhook-tenant.integration.test.js. That file is not part of PR #36’s 21-file change list and is not covered by the reported hosted CI evidence. It appears to be a draft two-site PostgreSQL webhook test; it must be reviewed and intentionally committed or discarded before anyone relies on it. It is excluded from the candidate evidence summarized here.

## 3. Product and supported 0.5.1 scope

VirgoScorpio Hub is an AI-integrated headless CMS and site platform with visual page editing/rendering, media and document library foundations, commerce and membership workflows, community features, plugin infrastructure, AI-assisted content workflows, and collaborative editing/realtime foundations. The presence of adapters and code does not make every provider or capability supported. The current recommended 0.5.1 boundary is an isolated, self-hosted developer preview, not a production-ready SaaS, not a production-certified multi-tenant service, and not a parity replacement for WooCommerce, BuddyPress, or Elementor.

### Recommended preview profile (approval still pending)
| Area | Current preview boundary | Not yet certified / excluded |
| --- | --- | --- |
| Runtime | Node.js >=22.23.4; CI on Ubuntu 24.04 with Node 22.23.4 and 24.22.1. | No full Windows/macOS production support matrix; local Windows/Node 26 test is not certification. |
| Data and graph | PostgreSQL is authoritative; Memgraph is an optional rebuildable projection. | No managed DB/graph provider, HA, RPO/RTO, or SLA assurance. |
| Realtime | Redis 7.4 exercised in CI; realtime remains opt-in. | No production-scale/HA realtime claim. |
| Identity | Built-in local account/password/session flows; password hashing uses scrypt. | No certified OIDC/SAML, enterprise SSO, verified-email, or account recovery provider. |
| Email / MFA | Mail disabled by default; TOTP/MFA code is preview functionality. | No certified delivery, recovery, or enterprise MFA assurance. |
| Storage / scanning | Local filesystem storage for preview; scanner-dependent uploads are quarantined or fail closed according to mode. | S3/GCS/Azure not certified; ClamAV corpus, outage, false-positive and legacy rescan gate open. |
| Payments | Product/order/cart foundations; Stripe testing only in test mode. | No live charges, complete refunds, coupons, tax/shipping, downloads, or full subscriptions parity. |
| Community | Site-scoped profiles, groups, memberships, activity and messaging foundations. | No BuddyPress parity; privacy, forums, abuse controls, search, export/deletion remain incomplete. |
| Plugins | Plugin metadata/provenance tools and isolated runner foundations; execution disabled by default. | No production third-party execution or adversarial isolation certification. |
| AI | Mock provider by default; external content opt-in disabled. | No external model/provider certification or customer-confidential content claim. |
| Browser | Chromium/Chrome desktop smoke tests. | No full WCAG conformance, Firefox, Safari/WebKit, mobile or screen-reader certification. |

> **Release scope sign-off:** docs/RELEASE-SCOPE.md explicitly labels itself a recommended scope baseline with named release-owner sign-off pending. It must be approved or amended with a named owner, date, candidate SHA, provider matrix and known limitations. Its recorded source baseline (af21b728...) is historical and should be refreshed to the actual approved candidate before signature.

## 4. Architecture and operating boundaries

The design places PostgreSQL at the center of durable identity, content, memberships, commerce and outbox state. Memgraph is a derived relationship projection; it does not independently grant authorization. Redis is used for optional shared presence/realtime behavior. Site context is resolved at API routes, checked against user membership/capability and expected to flow into data access, events and subscriptions. The codebase has explicit local identity/session flows, OIDC/SAML adapters, media/library adapters, commerce and Stripe webhook handling, ClamAV integration, plugin runner constraints, AI provider adapters, and realtime collaboration. Provider integrations remain preview foundations unless the exact provider and configuration have passed their dedicated gate.

### Key architectural trust boundaries
- Browser/API: untrusted input, authenticated sessions, CSRF checks for cookie writes, origin checks, and server-side route/capability enforcement.
- Tenant/site: site identifier plus membership/capability and object-level query scope must protect every route, database lookup, cache key, background effect, asset/object key and realtime topic.
- Durable data/projections: PostgreSQL is authoritative; outbox workers and Memgraph are asynchronous/rebuildable and must preserve tenant IDs and tombstones.
- Providers: external identity, mail, payments, object storage, malware scanning and AI are separate trust boundaries; test adapters do not establish live provider assurance.
- Plugins: no untrusted plugin code in the API process; private runner, immutable allow-list and OS/container isolation need hostile-code tests.

## 5. Engineering delivery and test evidence

PR #36 contains ten commits with security fixes, CI evidence improvements, dependency/license records, a tenant route/capability map, additional authorization regression tests, and a Stripe subscription webhook tenant-binding correction. All changes remain on the feature branch and have not been merged to main.

### Recent candidate work
| Commit | Workstream | Outcome |
| --- | --- | --- |
| 5830abd | CodeQL remediation | Descriptor-bound template/manifest reads; monotonic template scanning; direct constant-time byte comparison for configured bearer secrets; private media file mode; test regex cleanup; regression tests. |
| f8262c6 | Development env safety | Hardens .env opening using O_NOFOLLOW where supported, descriptor checks, regular-file/hard-link checks, and owner-only POSIX permissions. |
| 9a004ff | Supply-chain CI | Dynamic SBOM and audit evidence generation with exact counts, hashes, runtime/npm identity, and platform metadata. |
| 6935e26 / e41b24a | Evidence records | Adds verified CodeQL/SBOM triage and seven-package license/archive inspection records. |
| 3a378f1 / 7e30caf | Security preflight | Adds browser auth token tests and a preliminary route-to-capability/data-access map. |
| d3c4985 / f9d463e | Authorization coverage | Adds table-driven denied-capability tests across 16 site-addressed route families and an authorized community group-member listing positive control; repairs a route dispatch guard. |
| ba88874 | Billing tenant safety | Scopes Stripe subscription status updates using signed subscription metadata: purchase type, site, user, plan, provider and subscription ID. |

### Latest hosted engineering evidence
| Evidence | Latest result | Boundary / caveat |
| --- | --- | --- |
| CI on Node.js 22.23.4 | SUCCESS | Unit/security tests 245/245; EnginEx 92/92; audits; SBOM; readiness snapshot. |
| CI on Node.js 24.22.1 | SUCCESS | Unit/security tests 245/245; EnginEx 92/92; audits; SBOM; readiness snapshot. |
| Live PostgreSQL/Memgraph/product integration | 22/22 PASS, 0 skips | Dedicated integration job with isolated PostgreSQL test database, Memgraph 3.13.1 and Redis service; artifact generated at 19:17:40Z. |
| Fresh migrations | 14/14 apply; 14/14 idempotent skip | Disposable fresh PostgreSQL database was dropped after verification. |
| Memgraph outage/recovery | PASS | Event remained pending during outage, replayed after recovery, expected projection existed, no duplicate replay. |
| Canonical graph rebuild | PASS | Preserved tombstones, removed stale nodes, enforced safety limit and was deterministic on second run. |
| Chromium Playwright | 9/9 PASS | Two workers; includes two-node editor scenario at 2, 5 and 10 editors. Not full accessibility/load acceptance. |
| npm audit (full tree + production-only) | 0 vulnerabilities | Both thresholds run in both Node/npm matrix jobs. Audit does not address licensing or code-scanning findings. |
| CodeQL analyzer execution | SUCCESS; 5 open results | Analysis completed, but four High cookie findings and one Medium legacy dynamic-code finding remain open. |

## CI evidence freshness

The latest completed candidate workflows were push run 41340896118 and pull_request run 41340899584, both on head f9d463ef9ca82d15c9220e15cf50df2ba6367a11. Each completed all five jobs successfully. The browser job recorded 9 passed in 31 seconds and printed collaboration smoke observations (2/5/10 editors, 153 delivery-latency samples, p50 1.090s, p95 2.054s, p99 2.065s, and 100ms reconnect recovery in the tested failure scenario). These figures are scenario-specific smoke metrics, not performance SLAs or a substitute for dedicated load/soak evidence.

## 6. Application security and CodeQL

The main branch scan at 1a903b8 still shows 13 open CodeQL alerts: 12 High and 1 Medium. The candidate branch analysis at f9d463 shows five open alerts: four High and one Medium. Eight of the original High findings are no longer open on the candidate analysis; the CodeQL workflow itself ran successfully. No alerts were bulk-dismissed, no security rule was disabled, and no unverified suppression is claimed.

### Open candidate CodeQL findings
| Alert | Severity / rule | Location | Current disposition |
| --- | --- | --- | --- |
| #4 | High - js/clear-text-storage-of-sensitive-data | apps/api/src/server.js:574 | Cookie-based auth protocol flow; requires human review of purpose, entropy, flags, scope, expiry, CSRF and session handling. |
| #5 | High - js/clear-text-storage-of-sensitive-data | apps/api/src/server.js:588 | Cookie-based auth protocol flow; remains open, not dismissed. |
| #6 | High - js/clear-text-storage-of-sensitive-data | apps/api/src/server.js:655 | Cookie-based auth protocol flow; remains open, not dismissed. |
| #7 | High - js/clear-text-storage-of-sensitive-data | apps/api/src/server.js:679 | Cookie-based auth protocol flow; remains open, not dismissed. |
| #14 | Medium - js/unsafe-code-construction | vendor/enginex/engine-legacy.js:569 | Legacy renderer dynamic code construction; explicitly unsafe compatibility path, requires reachability and product/security boundary decision. |

## Cookie alert interpretation

Source documentation states that session tokens are random opaque bearer values whose SHA-256 digests are stored server-side; the browser must present the token value on requests. Session/MFA cookies are HttpOnly and Secure when deployed securely; SameSite, path and expiry controls are configured. The CSRF double-submit token is separate and script-readable by design. This context is a reason for careful manual triage, not proof that the CodeQL alerts are false positives or that residual risk is zero. A security owner must inspect each data flow and decide whether a design change or a documented risk acceptance is justified.

## Legacy dynamic-code alert interpretation

The alert is in the legacy EnginEx compatibility renderer. The current code/documentation describe legacy JavaScript blocks as requiring explicit allowUnsafeCode: true and trusted templates; the safe default renderer rejects legacy blocks. This is an intentionally risky opt-in surface, not a clean bill of health. The maintainer/product decision is whether to remove/deprecate it or keep it with a clearly enforced trust boundary, tests, and explicit security sign-off.

## Static analysis conclusion

CodeQL has materially improved on the candidate branch, but the current open-alert set prevents describing the codebase as clean. The production security gate also requires independent assessment and retesting. The main branch has not received the candidate fixes and still presents the original alert set until a reviewed change is merged.

## 7. Tenant isolation and authorization assurance

This is the most consequential open engineering/security gate. VirgoScorpio Hub is multi-site by design. The source contains site selector resolution, capability authorization, own-content rules, object-store scoping, event envelopes, graph partitions, Redis site-qualified channels and realtime reauthorization. Those patterns are positive design evidence but cannot prove every route and side-effect path is isolated.

### Evidence now present on the candidate
- A preliminary 146-line route/capability/data-access map covers the API, platform routes, public paths, provider callbacks, PostgreSQL/outbox, Memgraph, Redis/realtime, collaboration, community, media/library, commerce and privileged operations.
- A table-driven route capability suite tests 16 denied-capability route families and checks that tenant-store work does not occur after denial; one authorized community group-member listing is a positive control.
- The live PostgreSQL-gated tenant-isolation integration test provisions two sites and confirms a site-B-only actor cannot read/write the site-A community feed; malformed/conflicting site selectors are rejected.
- The Stripe subscription change requires complete membership metadata and uses a SQL update predicate bound by site, provider, subscription ID, user and plan. The committed webhook unit regression signs a Stripe-style event and checks the query parameters with a test double.
- Existing PostgreSQL, Memgraph, Redis and collaboration suites cover selected cross-site reads, site-scoped invalidation, replay and session-revocation behavior.

## Coverage limitations

The route map pins source commit 3a378f17635ccb046dca96f3660314c88ad3a260, which predates the final candidate head f9d463. It must be refreshed and rechecked on the exact candidate. The new route matrix is a fake-store capability-denial test, not a comprehensive A/B database side-effect matrix. The committed Stripe test uses a query-recording test double; a local untracked two-site PostgreSQL webhook test is not in PR #36 and not part of hosted evidence. Real provider-generated event shapes, mismatched site/user/plan IDs, duplicate deliveries and two-site PostgreSQL writes still need dedicated testing.

> **Independent review status:** OPEN / NOT PERFORMED. No independent reviewer has been assigned, contacted, retained or given an exact reviewed commit. No passing artifacts/evidence/tenant-isolation-review.json exists. The assessor packet and route map are internal preparation, not independent assurance. GitHub issue #14 remains open.

## 8. Dependency, SBOM, licensing and provenance

The committed package-lock.json identity is consistent across the two latest Linux CI matrix jobs: SHA-256 5b2b79b4fff771a6f0209f51737b320b0513685db5997b1dce9c437adf0d1ad3. Both jobs generated CycloneDX 1.5 SBOMs for VirgoScorpio Hub 0.5.1. The refreshed generator corrects an older static-log count/date defect and records live runtime, npm, hashes, inventory counts and licenses.

### Latest SBOM matrix
| Runtime | SBOM counts | SBOM SHA-256 | Observed licensing |
| --- | --- | --- | --- |
| Node 22.23.4 / npm 10.9.9 | 167 components / 168 dependency records | 0dba803c0403b52e1a1b2f13896d1f1b0d1e183961f30c1b9354e127d354a508 | Includes two Linux libvips LGPL components and sharp-wasm32 compound Apache/LGPL/MIT. |
| Node 24.22.1 / npm 11.19.1 | 165 components / 166 dependency records | ee2cf8c18879e1c0ccf0dc8893f148f4c4b11aa9f9f73913b302d34e51968b05 | Includes two Linux libvips LGPL components; no unknown-license components. |

## Inventory variance

The same lockfile produces a three-component symmetric difference: Node 22 only has @emnapi/runtime@1.11.3 (MIT) and @img/sharp-wasm32@0.35.5 (Apache-2.0 AND LGPL-3.0-or-later AND MIT); Node 24 only has tslib@2.8.1 (0BSD). Node 22 uses npm 10.9.9 while Node 24 uses npm 11.19.1. The difference is observed but not root-caused; runtime and npm-version effects are confounded. Do not claim byte-equivalent component inventories or complete runtime parity until this is isolated.

## License/distribution risk

A separate archive-level check verified lockfile SRI for seven exact Sharp/libvips/platform package tarballs. Two Linux libvips archives declare LGPL-3.0-or-later but contain no separate LICENSE/COPYING/NOTICE file. WASM and Windows Sharp platform packages declare compound LGPL expressions while the included LICENSE file starts with Apache 2.0. The root repository LICENSE is GPL-2.0; vendored EnginEx LICENSE is MIT. The SBOMs identify licenses for all components, but the applicable texts, distribution obligations and notice package remain unresolved. A qualified legal/maintainer review must map each shipped target-platform binary to its upstream license terms and required notices/source/relinking obligations before distribution.

## Dependency gate conclusion

Audit result: PASS for vulnerability threshold only. SBOM generation and artifact identity: PASS. Inventory variance root-cause: OPEN. License notice completeness and distribution analysis: OPEN. Provenance/attestation: OPEN. Maintainer review: OPEN. Issue #23 remains open, so the formal dependency-SBOM-CodeQL gate is not complete.

## 9. Release readiness and formal gate matrix

The latest release-readiness JSON/Markdown was generated inside the Node 22 and Node 24 CI matrix at approximately 19:17 UTC. Both snapshots report 6 PASS, 2 PARTIAL, 2 BLOCKED, 13 MISSING_EVIDENCE, and 0 NOT_RUN. This is the most current formal readiness summary retrieved, but its two BLOCKED results require interpretation alongside separate successful hosted jobs.

### Formal readiness snapshot summary
| Category | Count | Assessment |
| --- | --- | --- |
| PASS | 6 | Runtime, migration inventory, syntax/artifact check, unit/security tests, EnginEx tests, and Playwright dependency availability. |
| PARTIAL | 2 | Lockfile review: install passes but human review incomplete. Integration tests: the unit job runs without DB services, so all 22 optional integration tests skip there. |
| BLOCKED | 2 | Clean source tree and PostgreSQL/Memgraph live evidence blocked in the readiness script. The dedicated integration job separately passed; the snapshot fails to aggregate that evidence. |
| MISSING_EVIDENCE | 13 | All 13 formal external/independent release evidence gates remain unaccepted. |
| NOT_RUN | 0 | All programmatic checks configured inside the readiness script ran. |

## Readiness report integrity issue

The readiness script reports four tracked/untracked modified paths and labels the release source tree BLOCKED. The CI job also writes generated logs, reports and build assets into its checkout before readiness runs; the exact four paths were not captured in the summary output reviewed. It must be determined whether these are expected generated outputs or a real source mutation. The integration-test check is likewise PARTIAL in each unit job because the 22 PostgreSQL/Memgraph integration tests skip without services, even though the separate live integration job on the same workflow passed 22/22 with zero skips. The current readiness script does not consolidate that separate job artifact. This is an evidence aggregation/control defect, not evidence of a failed integration test, but it still prevents the formal readiness snapshot from cleanly accepting the candidate.

### Formal gate status (GitHub issues #13-#26)
| Issue / priority | Gate / subject | Status | Current assessment |
| --- | --- | --- | --- |
| #13 / P0 | Freeze 0.5.1 release scope and provider matrix | OPEN | Recommended scope exists; owner approval, date, candidate SHA and scope/provider decisions pending. |
| #14 / P0 | Independent tenant/site isolation review | OPEN | Preflight and targeted tests exist; no independent reviewer or evidence artifact. |
| #15 / P1 | OIDC/SAML, email, MFA recovery, session lifecycle | OPEN | Local identity tests only; no approved/live provider E2E evidence. |
| #16 / P1 | ClamAV/malware corpus and legacy quarantine | OPEN | Scanner foundation exists; no accepted live corpus, outage, false-positive and legacy rescan evidence. |
| #17 / P1 | Object storage provider and least-privilege lifecycle | OPEN | Local storage is the preview boundary; no live S3/GCS/Azure account validation. |
| #18 / P1 | Stripe checkout/webhook/replay/refunds/subscriptions | OPEN | Tenant-binding code fix and unit test; no dedicated live test-mode lifecycle evidence or two-site DB acceptance. |
| #19 / P1 | Browser and manual accessibility acceptance | OPEN | 9 Chromium smoke tests pass; full keyboard, focus, contrast, screen-reader and matrix acceptance missing. |
| #20 / P1 | Commerce acceptance/parity evidence | OPEN | Core workflow foundations; tax/shipping/coupons/refunds/fulfillment/entitlements/subscriptions not accepted as a scoped set. |
| #21 / P1 | Community privacy/parity acceptance | OPEN | Group member authorization regression added; privacy, abuse, forums, search and export/deletion acceptance incomplete. |
| #22 / P1 | Signed plugin pipeline and adversarial runtime isolation | OPEN | Manifest/archive/provenance foundations; hostile plugin and production container isolation tests missing. |
| #23 / P1 | Lockfile, SBOM, provenance, dependency scan, CodeQL | OPEN | Audits/SBOM refreshed; five CodeQL alerts, license gap, npm variance root cause, provenance and maintainer sign-off open. |
| #24 / P1 | Load/soak, fault injection, backup/restore | OPEN | No capacity, RPO/RTO, full restore, failover or fault-injection evidence accepted. |
| #25 / P0 | Independent security assessment and High/Critical remediation | OPEN | No independent assessor/report; CodeQL and product risks need human assessment. |
| #26 / P0 | Operations runbooks and release-owner approval | OPEN | No named operations owner, rehearsed production runbooks, or exact-candidate approval artifact. |

## Additional corporate governance gate

GitHub issue #32 remains OPEN / P0: approve zero-reserve operating, compensation and capital controls. It requires validation of jurisdiction/entity status, company agreement and member/manager authority, adoption or rejection of the draft resolution through the proper process, confirmation of no unfunded expense/compensation authority, lawful revenue/funding pathways, bank/accounting controls and an actual reserve target. It is not one of the 13 technical evidence gates, but it is a prerequisite to any paid external work or commitments.

## 10. Funding, governance and procurement position

The operating premise is that Golden Obsidian LLC currently has no funding and no liquid asset reserve, with no approved budget or spend authority. This is consistent with the open content of issue #32. No external assessor/vendor has been contacted, retained or approved. The independent-review engagement brief is procurement preparation only; the shortlist is research, not outreach, endorsement or evidence of availability or price. No statement of work, rules of engagement, purchase, subscription, hiring, borrowing, paid labor or provider mutation has been initiated in the work covered by this report.

## Corporate action boundary

The zero-reserve operating/capital resolution packet remains a draft, not an adopted company resolution. No signatures, effective date or company authorization are verified. Before any formal adoption or spending authority is relied on, confirm the entity’s current legal standing, jurisdiction, governing documents, membership/manager structure, tax status and required approval thresholds with appropriate professional advice. An old historical status note is not a current legal-status determination.

### Financial and labor controls recommended while unfunded
- Maintain a no-spend/no-commitment posture: no paid personnel, assessor, vendor, advertising, subscriptions, travel, borrowing or other obligation without cleared funds and transaction-specific approval.
- Do not create unpaid productive labor arrangements or promise deferred compensation, equity, tokens, revenue share or future payment informally; classification and compensation require proper legal review.
- Allow only authorized, genuinely no-cost internal engineering, documentation, market discovery and non-binding quote research; do not represent these activities as external independent assurance.
- Do not solicit investments, advertise tax-deductible donations or offer securities-like arrangements without a reviewed legal pathway.

## 11. Principal risks and management implications

The risks below are prioritised by release impact and the evidence currently missing; they are not an independent risk assessment.

### Risk register
| Risk | Rating | Why it matters | Required response |
| --- | --- | --- | --- |
| Cross-tenant authorization defect remains undiscovered | CRITICAL | Multi-tenant boundary is central to the product; current tests are targeted and not independent or exhaustive. | Keep production NO-GO; complete A/B object-ID and side-effect matrix, then independent review/retest. |
| Residual CodeQL cookie and legacy-code findings | HIGH | Four High data-flow findings and one Medium unsafe dynamic-code finding remain open. | Human security disposition; change design or document controls/risk acceptance; retain alerts until verified. |
| LGPL package notice and distribution uncertainty | HIGH | License files/expressions are incomplete or ambiguous in optional Sharp/libvips archives. | Map shipped binaries by platform; obtain complete upstream terms/notices and legal review before distribution. |
| Release evidence aggregation inconsistency | HIGH | Latest readiness artifact reports clean-tree and integration blockers although dedicated integration job passed. | Identify four changed paths; fix readiness script/CI artifact aggregation; regenerate for exact clean commit. |
| Provider capabilities exceed tested preview scope | HIGH | OIDC/SAML, email, cloud storage, scanner, Stripe lifecycle, and plugins are not validated end to end. | Freeze preview scope and keep unselected features disabled/excluded from claims. |
| Product parity claims could outrun acceptance | MEDIUM-HIGH | Commerce/community feature subsets have known incomplete functionality. | Define accepted feature subset; explicitly exclude incomplete capabilities from all release/marketing claims. |
| Operations and recovery readiness absent | HIGH | No accepted load, backup/restore, rollback, monitoring or incident response evidence. | No production launch; prepare a real topology and perform funded operational drills before approval. |
| Unfunded governance commitments | HIGH | No cash/liquid reserve or approved budget for assessors/vendors/operations. | Maintain no-spend guardrails; lawful funding strategy and governing approval before commitments. |

## 12. Recommended next actions

The following sequence prioritises no-cost work first and avoids creating obligations the company cannot fund. The owner should update GitHub issues and release evidence only after the work is actually complete.

### Priority execution plan
| Order | Action | Expected result / exit condition |
| --- | --- | --- |
| 1 - Immediate | Choose one canonical PR between #35 and #36 after a reviewed file-by-file and commit-history reconciliation. Refresh documentation pins to the chosen SHA; request a human maintainer/security review. | One coherent branch; duplicate/overlapping PR resolved; review comments and approvals recorded; no blind merge. |
| 2 - P0 | Get a named release owner to approve or amend docs/RELEASE-SCOPE.md and identify the exact candidate SHA, providers, disabled features and exclusions. | Issue #13 approved with owner, date, source SHA and scope matrix. |
| 3 - P0 | Complete a code-level decision on CodeQL #4-#7 and #14. Review token purpose/entropy/cookie flags/CSRF/session expiry and legacy engine reachability. Avoid suppressions without evidence. | All five findings have explicit technical disposition and verification; no bulk dismissal. |
| 4 - P0 | Refresh tenant route map to the final candidate, add two-site PostgreSQL object-ID/no-side-effect cases for priority route families and webhook metadata mismatch, then prepare a reviewer handoff. | Candidate-specific coverage matrix and reproducible test evidence; independent gate remains open until qualified reviewer performs it. |
| 5 - P1 | Resolve the SBOM component variance by holding Node/npm variables constant; complete target-platform Sharp/libvips license mapping and notice/legal review; produce artifact provenance/attestation. | Issue #23 has an accepted reviewer record and exact candidate evidence. |
| 6 - P1 | Correct readiness reporting: ensure generated artifacts do not dirty source checks, consume the dedicated integration artifact, and distinguish a service-less skipped suite from the live integration job. | One candidate-linked readiness record with no self-generated blockers and accurate cross-job evidence. |
| 7 - P1 | Complete preview-scope validation for identity, malware scanning, cloud storage, Stripe test-mode lifecycle, plugin isolation, browser accessibility, commerce and community; disable out-of-scope capabilities. | Each selected capability has gate evidence and provider/account/version scope; excluded capabilities are not claimed. |
| 8 - P0 | Adopt corporate zero-reserve controls through the lawful company process; only after cleared funding and explicit authority should vendor/assessor outreach begin. | Issue #32 decision recorded; no unfunded liabilities; assessor statement of work and rules of engagement only if budget approved. |
| 9 - Final | Perform load/soak, fault injection, backup/restore, rollback and operational tabletop drills on the approved deployment topology; obtain exact-candidate operations/release approval. | Issues #24 and #26 accepted; readiness regenerated; only then consider a production certification decision. |

## 13. Final assessment

VirgoScorpio Hub 0.5.1 has a credible and improving engineering baseline: reproducible installs on the tested matrix, clean vulnerability audits, passing unit and EnginEx tests, successful live database/graph integration, successful Chromium collaboration smoke, targeted tenant authorization tests, and meaningful source-level remediation. The candidate branch is materially stronger than current main, but it is not merged and is not independently assessed. Four High cookie data-flow alerts and one Medium legacy-code alert remain open; supply-chain/legal questions remain; the 13 formal evidence gates are missing; the latest readiness artifact still has two blocked checks; the release-scope decision and corporate zero-reserve controls are not adopted. The project is therefore ENGINEERING-POSITIVE / PRODUCTION-NO-GO. Preserve the developer-preview boundary, keep the company unfunded/no-spend constraint explicit, and do not infer production assurance from green CI.

## Appendix A. Primary references reviewed

Repository and evidence references below were read or queried directly for this report. CI timestamps are UTC; local report time is America/Chicago.

### GitHub repository and change sets
- Repository: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub
- main branch: 1a903b8eab4304dd61b2489381b091d34f1ea546
- PR #36 (draft candidate): https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/36
- PR #35 (overlapping earlier remediation): https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/35
- Candidate push run 41340896118: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41340896118
- Candidate pull-request run 41340899584: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41340899584
- Candidate CodeQL alerts: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/security/code-scanning

### Key open execution and governance issues
- Release scope: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/13
- Independent tenant review: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/14
- Identity: #15; malware scanning: #16; cloud storage: #17; Stripe: #18; accessibility: #19.
- Commerce: #20; community: #21; plugin isolation: #22; dependency/SBOM/CodeQL: #23.
- Load/backup/restore: #24; independent security assessment: #25; operations/release approval: #26.
- Zero-reserve corporate controls: https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/32

### Repository documents read
- docs/RELEASE-SCOPE.md; docs/RELEASE_READINESS.md; docs/PRODUCTION-CERTIFICATION-PLAN.md; docs/SECURITY-AND-THREAT-MODEL.md.
- docs/security/CODEQL-TRIAGE-2026-11-01.md; DEPENDENCY-SBOM-REVIEW-2026-11-01.md; DEPENDENCY-LICENSE-PACKAGE-INSPECTION-2026-11-01.md; TENANT-ISOLATION-ROUTE-CAPABILITY-MAP-2026-11-01.md.
- docs/assessors/TENANT-ISOLATION-ASSESSMENT-BRIEF.md and docs/assessors/INDEPENDENT-REVIEWER-ENGAGEMENT.md.

## Appendix B. Interpretation rules

A passing workflow confirms the configured checks executed successfully on the tested runner and revision; it does not certify production behavior. A CodeQL analyzer success does not mean zero alerts. A zero-vulnerability npm audit does not establish license compliance, provenance, package completeness or independent security assurance. A test double is not a live provider or database validation. Internal test plans and assessor briefs are not independent assessment evidence. A missing evidence artifact is not a pass. A draft operating resolution is not an adopted resolution or spending authorization.
