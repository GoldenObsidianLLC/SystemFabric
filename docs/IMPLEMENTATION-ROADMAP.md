# SystemFabric Implementation Roadmap — 0.5.1

## Completed foundations in this source snapshot

- Node.js modular core, PostgreSQL source of truth, Memgraph graph projection, versioned transactional outbox.
- EnginEx 6.2.0 rendering adapter and versioned page-document model.
- AI provider adapters, content/page drafting, schema validation and constrained MCP tools.
- Identity/session and publication workflow foundations; browser editor baseline.
- File/Document/Media libraries, curated icons, video widgets, math formula validation/rendering, optional optimization.
- Product/order/membership domain foundations; 0.5.1 adds finite-stock reservation lifecycle helpers, provider-aware reconciliation of expired Stripe Checkout Sessions, and ambiguous create-session recovery with exact request snapshots. It fails closed and retains holds when the session ID/provider state is unknown. Live Stripe/DB tests remain gated.
- 0.5.1 adds partial site-scoped direct-conversation/message, notifications/read markers, blocks, reports and moderation routes with rate limiting; group privacy, forums, export/deletion and full browser workflows remain open.
- Release-readiness tooling records syntax/unit/vendor/integration results separately from required deployment evidence and produces a fail-closed gate report.
- F1.7 completes a documented CRDT-versus-semantic-OT assessment for the current page-document/editor model and records a provisional server-authoritative OT direction in ADR-019; implementation remains a separate milestone.
- Optional ClamAV scanner adapter, fail-closed production upload policy, non-production quarantine, local disk object reconciliation tool.
- Read-only cloud-storage probe methods (live provider operations require provider credentials and were not tested here).
- PostgreSQL outbox concurrency/dead-letter test definition, Memgraph monotonic projection integration test, and CI definitions for supported Node, database services, Playwright and CodeQL.

## Milestone C — Runtime and integration validation

1. Generate and commit a reviewed lockfile; run a clean install on Node.js 22.23.4 and a supported Node 24 release.
2. Execute CI and retain artifact evidence for npm audit, SBOM, integration, browser/accessibility and CodeQL jobs.
3. Run migrations 0001–0008 on real fresh/upgrade PostgreSQL fixtures; run Memgraph outage/replay/reconciliation and concurrent-worker suites.
4. Run ClamAV using a managed scanner and a known safe/infected test corpus; plan legacy asset rescanning/quarantine; test uploads and replacements across supported stores.
5. Rehearse the local library-object reconciler with reference fixtures, old orphan fixtures, symlinks and apply/backup recovery.
6. Verify actual cloud credential resolution and live S3/GCS/Azure/R2/MinIO operations under least-privilege policies.
7. Complete password reset/email delivery, MFA recovery, OIDC/SAML end-to-end tests and tenant isolation.

## Milestone D — Product workflows and feature completeness

1. Complete visual-editor browser and accessibility acceptance: drag/drop, keyboard operation, undo/redo, autosave, conflicts, responsive preview, media, reusable templates and publishing preview.
2. Add theme/template builder, global styles/design system, forms, popups, dynamic content/query loops and export/import acceptance before Elementor parity claims.
3. Finish commerce lifecycle: tax/shipping rules, coupon application/redemption policy, refunds, invoices/receipts, fulfilment, downloadable entitlements, disputes and full subscription lifecycle; validate the new stock-reservation state machine with live database/provider failure-injection tests.
4. Complete community workflows: group conversation/privacy policy, spam/abuse controls, search, privacy/export/deletion, browser UI and live tenant-isolation/rate-limit tests.
5. Complete recurring membership portal, renewal/cancellation/plan change/proration/dunning and access reconciliation.
6. Complete plugin archive-to-OCI builds, malware/dependency scan, SBOM/provenance/signature verification and adversarial isolation.

## Milestone E — Production readiness

1. Complete performance, load/soak, fault-injection, fuzzing and resource-exhaustion test plans.
2. Verify backup/restore and graph projection rebuild from canonical PostgreSQL data.
3. Complete dependency and container-image review, independent security assessment and severe-finding remediation.
4. Establish deployment modules, secret rotation, managed edge/WAF protection, monitoring/alerting and incident runbooks.
5. Define feature acceptance criteria against the chosen WordPress, WooCommerce, BuddyPress and Elementor subset; publish a parity claim only after all required acceptance tests pass.

## Release policy

The CI workflow is a test definition, not evidence that a job passed. Each milestone needs retained acceptance logs/results. Capability files, UI surfaces and database tables alone do not imply user-facing parity. SystemFabric must not claim production certification until all release-gate requirements are satisfied.
