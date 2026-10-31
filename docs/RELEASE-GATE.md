# SystemFabric 0.5.1 — Release Gate

**Current release state:** `EXPANDED_DEVELOPER_PREVIEW_NOT_PRODUCTION_CERTIFIED`.

Do not deploy this build to a public production site until the gate below is complete. Passing local unit tests does not prove the production deployment model is safe. A CI workflow for the checks exists, but it has not been executed successfully in this packaging environment.

## 1. Build and runtime

- [x] Validate on Node.js 22.23.4 or newer, matching `package.json` and vendored EnginEx; local evidence is Node.js 26.12.1 on 2026-10-30. The exact CI matrix still requires current-run evidence.
- [x] `package-lock.json` exists, is tracked, and is synchronized with `package.json`. A fresh isolated `npm ci --no-audit --no-fund` passed on Windows x64 / Node.js 26.12.1 on 2026-10-30; see `artifacts/evidence/clean-npm-ci.json`.
- [x] `npm run check` passed locally on Node.js 26.12.1 on 2026-10-30.
- [ ] Verify repeatable installation in CI and retain evidence for the supported Node.js matrix.
- [ ] Complete human dependency review and SBOM/provenance review. Local evidence: `npm audit --audit-level=high` reported 0 vulnerabilities and CycloneDX 1.5 SBOM generation completed (162 components, 163 dependency records); manual review, provenance and CI retention remain open.
- [ ] Verify container images, provenance and deployment configuration are pinned and signed.
- [ ] Run the configured GitHub Actions jobs and retain their actual logs and artifacts; workflow definitions alone are not release evidence.

## 2. Data and consistency

- [x] Apply all 13 migrations to a newly created disposable local PostgreSQL database and verify idempotent re-run; evidence: `artifacts/evidence/fresh-migrations.json`.
- [ ] Retain current-revision CI evidence for fresh install and supported upgrade fixtures before release.
- [ ] Test constraints, transaction rollback, backup, restore, retention and schema drift.
- [ ] Run outbox concurrent-worker, duplicate/out-of-order, graph outage/replay, poison-event and reconciliation tests against real PostgreSQL and Memgraph.
- [ ] Rehearse the local object reconciler in dry-run, validate its SQL references and age guard, and verify storage recovery after process termination.
- [ ] Test all tenant access paths, including IDs supplied in path, body, query, asset key, menu tree, commerce cart, membership, group and plugin records.

## 3. Identity and authorization

- [ ] Validate password reset, email verification, invitations and mail delivery using a real isolated mail provider.
- [ ] Test TOTP enrollment/recovery/replay prevention and account recovery.
- [ ] Test OIDC and SAML with actual isolated identity providers, key rotation, issuer/audience/redirect checks, replay, clock skew, logout and provider outage.
- [ ] Complete role/capability matrix tests and independent tenant-isolation review.
- [ ] Test session fixation, cookie security behind the real proxy, CSRF, origin policy, brute-force throttling and audit integrity.

## 4. Library, rendering and visual editor

- [ ] Deploy and test the ClamAV `clamdscan` integration, scanner timeout/unavailable behavior, known test signatures, malware corpus, false positives and quarantine review procedure.
- [ ] Rescan or quarantine legacy assets as part of migration planning; migration 0007 marks legacy rows `not_scanned` and does not imply that files are clean.
- [ ] Test MIME spoofing, polyglots, malformed/malicious files, Office embedded content, file size limits, private/public delivery and download authorization.
- [ ] Test optimistic versions, conflict responses, digest failure, delete/retention, metadata changes and replacement across storage adapters.
- [ ] Test optional KaTeX, Sharp and FFmpeg on actual supported runtimes with timeouts, memory ceilings and adversarial inputs.
- [ ] Test local object reconciliation dry-run and apply on disposable fixtures; verify it never follows symlinks, deletes referenced objects or traverses outside the storage root.
- [ ] Complete broad Playwright acceptance for drag/drop, keyboard operation, undo/redo, autosave/recovery, revision conflict, responsive layout, media widgets and preview/public rendering. Local smoke: 4 Chromium tests passed on 2026-10-30; this does not cover the full acceptance scope.
- [ ] Run WCAG-focused accessibility scans and manual keyboard/screen-reader review for editor, libraries, icon controls and mega menus.
- [ ] Test theme/template builder, global styles, dynamic content queries, reusable blocks and export/import before any Elementor parity claim.

## 5. Commerce, billing and memberships

- [ ] Test Stripe test-mode Checkout and webhooks for duplicates, signature failures, out-of-order/late events, expired sessions, async payments and process restarts.
- [ ] Complete guest/authenticated checkout policy, tax/shipping calculation, coupons, refunds, invoice/receipt, fulfilment, downloadable products and returns. Provider-aware stock expiry reconciliation is implemented in source but requires live Stripe/DB state-transition and failure-injection evidence.
- [ ] Complete recurring membership lifecycle: renewal, cancellation, proration/plan change, dunning, billing portal, refunds/disputes, grace periods and membership access reconciliation.
- [ ] Review tax, privacy, consumer rights and payment-provider compliance for each target jurisdiction.
- [ ] Do not claim WooCommerce or billing-platform parity until acceptance tests define and pass the required feature subset.

## 6. Community

- [x] Add initial site-scoped direct messaging, unread/read markers, notifications, blocking, reports, moderation actions and transactionally serialized message/report rate limits (0.5.1 source coverage).
- [ ] Validate those workflows against live PostgreSQL and adversarial cross-tenant tests. Finish group privacy, forums, spam/abuse controls, search, user privacy export/deletion and browser acceptance before BuddyPress parity claims.
- [ ] Test non-member/private group/profile/feed/message read access across every API route. Migration 0007 adds schema foundations, but does not alone establish complete user-facing workflows.

## 7. Plugins and application security

- [ ] Build a complete quarantine-only npm archive → scan → SBOM → OCI image → signed provenance pipeline.
- [ ] Verify signature, SBOM digest, artifact digest and image digest in the activation gate.
- [ ] Run adversarial plugins in the selected runtime with egress blocked, read-only filesystem, dropped capabilities, no privileged mode, seccomp/AppArmor/SELinux policy, CPU/memory/PID/time/output limits, and no host secrets.
- [ ] Pen-test path traversal, SSRF, deserialization, resource exhaustion, cross-tenant access, XSS/HTML/TeX/media handling, upload/download, billing webhooks, auth workflows, and route/worker boundaries.
- [ ] Deploy a managed WAF/reverse proxy/DDoS control; test forwarded-header and proxy-trust policy. The in-app firewall is not that layer.
- [ ] Complete independent security review and document severity-based remediation.

## 8. Cloud and operations

- [ ] Test S3, GCS, Azure and each S3-compatible deployment actually advertised; validate least-privilege identity, encryption, retention, URL access, CORS, deletion and lifecycle behavior.
- [ ] Verify cloud connection probes with real credentials and prove each secret-reference type maps to the intended identity/credential chain.
- [ ] Test provider failure, timeout, throttling, bucket/container misconfiguration and sanitized diagnostics.
- [ ] Add reviewed deployment modules (IaC), secret rotation, autoscaling and readiness/liveness probes for chosen cloud targets.
- [ ] Run load/soak, queue saturation, database outage, object-store outage and recovery tests.
- [ ] Practice backup restore and incident response; validate telemetry does not leak prompts, tokens, PII, or secrets.

## 9. Release evidence required

Run `npm run release:readiness` to produce a local evidence snapshot. Before a release claim, attach supported Node/clean-install logs, reviewed lockfile, migration outputs, live database/provider integration evidence, browser/accessibility results, security scan/audit/SBOM, load/soak reports, backup/restore evidence, artifact provenance, threat model update, rollback plan, and release approval. `npm run release:assert-ready` is the fail-closed release command; it is expected to fail while any required gate is missing. Until these are complete, retain the developer-preview release classification.
