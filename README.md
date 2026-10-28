# SystemFabric

**An AI-integrated, contract-driven CMS and visual rendering runtime for Node.js.**

SystemFabric is a modular headless CMS and visual site-building developer preview inspired by WordPress, WooCommerce, BuddyPress, Elementor, and modern membership platforms. It combines a versioned page-document model, a browser drag-and-drop studio, site-level identity, PostgreSQL content storage, optional Memgraph relationship projections, an EnginEx-based rendering subsystem, third-party extension controls, AI provider adapters and MCP tools.

> **Release status: 0.5.1 hardening candidate / expanded developer preview — not production-certified and not full feature parity.** This hardening candidate adds initial site-scoped community messaging/report/moderation workflows, durable checkout inventory holds, Stripe-session-state reconciliation before releasing expired stock, and ambiguous Stripe request retry handling, and a fail-closed release-readiness report. It retains the asset-scanning, local object-reconciliation, cloud-probe and CI foundations. Live database/provider/container/browse tests and production security certification are still release gates; see [`docs/RELEASE-GATE.md`](docs/RELEASE-GATE.md).

## Capabilities in 0.5.1

- **CMS and editing:** versioned nested page documents; drag-and-drop canvas, property inspector, responsive viewport preview, undo/redo, import/export, drafts, revisions, approval, scheduling, publication, and immutable published snapshots.
- **Identity and tenancy:** scrypt password hashes, opaque revocable sessions, HttpOnly cookies, CSRF/origin checks, site memberships/capabilities, invitations, password reset and email verification workflows, TOTP MFA foundations, OIDC and optional SAML integration. Real identity-provider and exhaustive tenant isolation tests remain required.
- **File and Document Libraries:** image/video/audio/document/file/font kinds; safe file-signature checks; metadata, stable UUIDs, SHA-256 digests, private downloads, public visibility opt-in, optimistic metadata/content versions, and revision history.
- **Icon Library:** curated inline SVG icons with bounded options and escaped accessible labels; arbitrary SVG upload is intentionally blocked.
- **Video and Math:** video widget references library assets; optional FFmpeg video-to-WebM derivative; TeX validation with optional KaTeX rendering and an escaped fallback when KaTeX is absent.
- **Media optimization:** optional Sharp image-to-WebP and resizing variants. Originals remain unchanged. Derivative generation and large FFmpeg jobs should move to a bounded worker in a production deployment.
- **Commerce and billing foundations:** products, bounded cart validation, integer minor-unit arithmetic, inventory reservations, order snapshots, Stripe Checkout, signed webhook handling, membership plans and status synchronization. This is not full WooCommerce parity: tax, shipping, discounts, refund, fulfilment, and complete subscription lifecycle workflows remain unfinished.
- **Community workflows (partial):** site-scoped direct conversations/messages, read markers and notifications, blocking, report queues, moderation actions and rate limiting. Group privacy, forums, search, export/deletion, and full anti-abuse acceptance remain unfinished; this is not BuddyPress parity.
- **Mega menus:** stored menu presentation controls for column/grid/flyout layouts, mobile behavior, image/icon/description toggles, and activation trigger. Full theme-building parity and browser accessibility checks remain pending.
- **Firewall/security:** request-level deny/challenge/rate-limit controls using IP, IPv4 CIDR, path and user-agent rules. This is not a network firewall or managed WAF; pair it with reverse-proxy and cloud-edge defenses.
- **Cloud storage:** local disk, AWS S3/S3-compatible endpoints, Cloudflare R2/MinIO patterns, Google Cloud Storage, and Azure Blob adapters, plus read-only connectivity probes. Live permissions and complete credential-secret resolution need deployment validation.
- **AI and MCP:** mock, OpenAI Responses, OpenAI-compatible, Anthropic and Gemini adapters; content assistance, page drafts, SEO suggestions, translation, schema validation, constrained previews and local MCP tools. AI proposes; SystemFabric validates; authorized humans control publishing and billing.
- **Rendering:** vendored EnginEx 6.2.0, validated page documents, escaped output, bounded renderer operations and structured rendering contracts.

## VS Code development and testing

The recommended setup is VS Code + Dev Containers, with Node.js 22.23.4, PostgreSQL, Memgraph, Playwright Chromium, and a dedicated integration-test database. Open the folder in VS Code and run **Dev Containers: Reopen in Container**. The first bootstrap installs packages and generates a `package-lock.json` if absent; review the generated lockfile, then validate a clean `npm ci` before committing it.

For host-based setup, install Node.js 22.23.4 or newer plus Docker Compose, then run:

```bash
npm run dev:setup
docker compose up -d postgres memgraph
npm run dev:bootstrap
npm run dev:doctor
```

To work on blockers, run `npm run check`, `npm run test:integration:live`, and `npm run test:e2e`. The live integration command refuses to run if it cannot reach PostgreSQL/Memgraph, requires a separate `TEST_DATABASE_URL` whose database name ends in `test`, applies migrations only to that test database, and fails if an integration test is skipped. `npm run release:readiness` produces the evidence snapshot; `npm run release:assert-ready` intentionally remains non-zero until all release requirements have evidence.

Full instructions, VS Code tasks/debug configurations, optional MinIO and ClamAV services, and a blocker-to-test matrix are in [`docs/VSCODE-DEV-SETUP.md`](docs/VSCODE-DEV-SETUP.md). `.env` contains development-only secrets and must never be committed or reused outside this isolated workspace.

## Configuration notes

- `AI_ALLOW_EXTERNAL_CONTENT=false` is the safe default. External AI processing requires opt-in and site policy approval.
- `LIBRARY_STORAGE_PROVIDER=local` is the default. Cloud providers require optional SDKs, supported credential environment variables or AWS/GCP workload identity, and the production endpoint allowlist for custom endpoints. `vault://` secret references are not resolved by this build.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` must be stored as deployment secrets. Use Stripe test mode until live webhook replay/out-of-order, payment and membership reconciliation are validated.
- `SYSTEMFABRIC_PLUGIN_EXECUTION_ENABLED=false` is the default. Do not execute untrusted packages in the API process.
- `SYSTEMFABRIC_FIREWALL_DENY_CIDRS` supports a deployment-level deny list; it does not replace WAF/DDoS protection at the network edge.

## Library security and reconciliation

Production uploads require `LIBRARY_MALWARE_SCANNER=clamdscan`; scanner errors, timeouts and detections reject the upload. In non-production environments without a scanner, new assets are quarantined and are not public/active. Existing assets are not retroactively marked clean by migration 0007. Run `npm run reconcile:library` first in dry-run mode to identify old unreferenced local objects. Deletion requires an explicit `--apply` and minimum age, for example `npm run reconcile:library -- --apply --min-age-hours=72`. The reconciler only handles local disk objects, never cloud storage, and must be reviewed before deletion.

Cloud connection tests call a provider-specific read-only operation (S3 `HeadBucket`, GCS bucket metadata, or Azure container properties); successful unit mocks do not prove a live deployment's credentials or permissions.

## AI privacy and governance

AI results and documents are untrusted inputs. SystemFabric validates generated documents, and publication remains a separate human-authorized workflow. Request-level provider `store: false` options do not guarantee zero provider-side logging or retention. Review provider terms and your content classification before submitting private data. MCP does not expose unrestricted shell execution, publishing or plugin activation tools.

## Validation status

- SystemFabric suite: **105 passed, 0 failed** in the current local run on Node.js 22.16.0 (below the declared minimum). This includes mocked Stripe reconciliation tests; provider/DB integration is not proven by those tests.
- Vendored EnginEx 6.2.0 suite: **88 passed, 0 failed** on the same below-minimum runtime.
- Integration suite: **5 skipped** because live PostgreSQL/Memgraph services were not configured in the previous packaging environment; skipped tests are not evidence of live integration success.
- API smoke tests: health, platform hub/static assets, icons, escaped math fallback, preview, draft proposal, auth requirements and disabled-database behavior passed.
- New unit coverage: malware quarantine/fail-closed upload policy, local object reconciliation safety, and cloud storage probe behavior passed.
- Not validated here: clean `npm ci`, live PostgreSQL/Memgraph migrations and failure injection, real OIDC/SAML/email/Stripe/cloud calls, media optimization with actual representative media, container sandboxing, Playwright E2E/accessibility, load/soak, backup restore, dependency audit/SBOM, and independent penetration review.

See [`docs/LOCAL-VALIDATION.md`](docs/LOCAL-VALIDATION.md), [`docs/FEATURE-PARITY.md`](docs/FEATURE-PARITY.md), [`docs/RELEASE-GATE.md`](docs/RELEASE-GATE.md), and [`docs/RELEASE-EVIDENCE.md`](docs/RELEASE-EVIDENCE.md).

## Repository map

```text
apps/api/                 API, identity, tenancy, CMS, platform and provider routes
apps/admin/               drag-and-drop Studio and Platform Hub UIs
apps/mcp/                 constrained MCP tools
apps/worker/              outbox projector and publication scheduler
apps/plugin-runner/       separately deployable plugin runner
packages/auth/            sessions, reset/verification, MFA, OIDC/SAML, memberships
packages/db/              PostgreSQL repositories, revisions, workflows and outbox
packages/domain/          page docs, taxonomy/navigation and CPT contracts
packages/render/          EnginEx-backed HTML rendering adapter
packages/graph/           Memgraph relationship projection
packages/plugins/         manifests, archive inspection, provenance and runners
packages/library/         File/Document/Media library persistence and versions
packages/icons/           curated SVG icon catalog
packages/math/            TeX validation and optional KaTeX rendering
packages/media/           local/S3-compatible media stores and optimization
packages/commerce/        product/cart validation
packages/billing/         Stripe Checkout and webhook verification
packages/community/       social profile/group contracts
packages/security/        application firewall rules and malware-scanner adapter
packages/cloud/           S3/GCS/Azure object storage adapters
packages/ai/              provider adapters, policies and usage accounting
config/cpt/                Git-managed content-type definitions
config/widgets/             core widget definitions
schemas/                    JSON Schema contracts
database/migrations/       versioned SQL migrations through 0008 checkout stock-reservation lifecycle
docs/                       architecture, VS Code setup, libraries, commerce, cloud, security and release gates
scripts/reconcile-library-objects.js  dry-run-first local object reconciliation CLI
scripts/test-integration-live.js      strict live database/graph integration runner
test/                       unit, API/security-boundary, DB integration and Playwright E2E tests
```
