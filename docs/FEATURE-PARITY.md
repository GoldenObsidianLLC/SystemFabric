# SystemFabric Feature Coverage & Strategic Capability Matrix — 0.5.1

This matrix separates current implementation evidence from planned and research-stage capabilities. A class, migration, API route, UI surface, provider adapter, or CI workflow definition is not proof of a complete user workflow or production readiness.

SystemFabric's current 0.5.1 baseline remains a developer-preview hardening candidate. The collaborative AI-native capabilities below describe the intended direction; they must not be presented as shipped features until implementation and acceptance evidence exist.

## Maturity definitions

| Maturity | Meaning |
|---|---|
| **Implemented foundation** | Relevant code exists and has focused local evidence. End-to-end integration and production behavior may still be unverified. |
| **Partial** | Some workflows exist, but important functionality, user experience, provider integration, or acceptance evidence remains incomplete. |
| **Planned** | An accepted development direction with scope and dependencies, but implementation is not yet available. |
| **Research / prototype** | Key design choices or feasibility need investigation before implementation is committed. |
| **Production-validated** | The complete advertised workflow has current, retained, reviewable evidence in its intended deployment environment and has passed the applicable release gates. No row should receive this status by inference. |

## Current platform coverage

| Area | Current coverage | Status and boundary |
|---|---|---|
| CMS content | Pages/posts/custom types, structured JSON documents, revisions, restore-as-new-draft, review, publish/schedule/unpublish/archive, optimistic version checks | **Developer-preview foundation.** Editorial collaboration, full import/export, multilingual editing UX, advanced workflows and migration tooling still expanding. |
| Visual builder | Nested drag-and-drop canvas, core widgets, properties, responsive preview, undo/redo, import/export, preview and draft recovery | **Partial.** Not full Elementor parity: theme builder, popup/form builder, global component studio, dynamic query builder and marketplace remain incomplete. Browser E2E was not run locally. |
| Rendering | EnginEx 6.2.0-based safe rendering, constrained widgets, validated documents and output limits | **Implemented baseline.** Supported Node runtime and realistic data/load must still be validated. |
| Authentication | Password hashing, sessions/cookies, CSRF/origin controls, invitations, reset/verification workflows, TOTP foundation, OIDC/SAML integration code | **Partial.** Real provider integration, MFA recovery lifecycle, email delivery, session handling behind real proxies and comprehensive recovery tests remain gates. |
| Tenancy | Site memberships, capability checks and site-scoped repository/API patterns | **Partial.** Production-wide tenant isolation and independent authorization review remain mandatory. |
| PostgreSQL/Memgraph | PostgreSQL authoritative store, transactional outbox, version/idempotency controls, graph integration test | **Implemented foundation.** Live migrations, graph outage/replay/reconciliation and concurrent tests were skipped because services were unavailable in the recorded validation environment. |
| File Library | MIME signature checks, site-scoped metadata, private/public distinction, SHA-256, soft delete and bounded upload | **Foundation with scan policy.** Production requires a configured malware scanner; legacy files are marked `not_scanned`. Live ClamAV and malicious-file-corpus validation remains. |
| Document Library | Allow-listed PDF/text/JSON/OOXML/ZIP/font asset types, metadata, private downloads and version snapshots | **Partial.** ClamAV scanner integration is available, but the live scanner, Office embedded-content inspection, retention, legal hold and end-to-end download tests are incomplete. |
| Icon Library | Curated SVG paths, bounded options and escaped title/label rendering | **Implemented foundation.** Not an arbitrary SVG uploader or full third-party icon marketplace. |
| Video library | MP4/WebM signatures, video widget, optional FFmpeg derivative | **Partial.** Transcoding needs bounded asynchronous workers and codec/browser tests. |
| Document/asset IDs and versions | UUID identities, optimistic asset metadata/content versions, content revision controls | **Implemented foundation.** Full restore semantics and retention policies need end-to-end tests. |
| Math formula rendering | TeX pre-filter, optional KaTeX with `trust:false`, strict rendering and escaped fallback | **Partial.** KaTeX must be installed; the input guard is not a formal sanitizer for arbitrary renderers. |
| Media optimization | Optional Sharp WebP variants and optional FFmpeg video variants | **Partial.** Representative media corpus, metadata preservation, performance/resource limits and queue-based processing remain. |
| Malware scanning and quarantine | ClamAV `clamdscan` adapter; production fails closed without scanner; non-production unscanned uploads are quarantined and non-public | **Implemented policy, unvalidated integration.** No real ClamAV daemon or malware corpus was available in the recorded environment. Existing assets are not automatically cleared. |
| Local object reconciliation | `npm run reconcile:library`, dry-run default, minimum age and apply gate, SQL reference checks, symlink/path protections | **Implemented local-storage tool.** Not remote object reconciliation; must be rehearsed against real database/storage fixtures before use. |
| WooCommerce-like commerce | Product/order/line-item foundations, bounded cart, minor-unit arithmetic, Stripe Checkout, signed/idempotent webhook processing, durable finite-stock reservations, commit/release transitions, Stripe-session-state reconciliation before expiry release and recoverable ambiguous provider outcomes | **Partial.** The reservation lifecycle has source and unit-test coverage, plus a gated live-PostgreSQL integration test. Tax, shipping, discounts, refunds, fulfilment, downloadable-product entitlements, variations, full subscriptions, extensions and live Stripe acceptance remain incomplete. |
| Membership/subscriptions | Plan records, one-time/month/year checkout, status updates and webhook foundations | **Partial.** Billing portal, renewal/cancellation/proration/dunning, reconciliation, grace periods and dispute handling remain. |
| BuddyPress-like community | Profiles/visibility, groups, memberships, friend requests and activity model, plus site-scoped direct conversations/messages, unread/read notifications, block/report/moderation routes and per-user transactionally serialized message/report rate limits | **Partial.** These routes have unit tests and a gated live-PostgreSQL integration test. Group conversations/privacy, full browser workflows, forums, abuse tooling, search, privacy export/deletion and live tenant-isolation evidence remain. |
| Mega menus | Validated menu tree and stored presentation settings for layout, responsive behavior and display toggles | **Partial.** Full theme integration, advanced widgets and browser keyboard/screen-reader checks remain. |
| Application security/firewall | IP/CIDR/path/user-agent rules, deny/challenge/rate-limit outcomes and deployment deny list | **Partial.** Not a network firewall, managed WAF, DDoS service, bot manager or reputation service. Country rules are not executed by the current evaluator. |
| Cloud storage | Local, S3/S3-compatible, GCS and Azure Blob adapter families; read-only probe methods | **Partial.** Unit tests use mocked clients. Live provider auth, secret-reference resolution, permissions, lifecycle, CDN and failure tests remain. |
| Billing | Stripe Checkout and signature verification foundation; event de-duplication and order/membership status update foundations | **Partial.** No PCI certification, full tax compliance assertion, accounting ledger, invoice engine or validated live webhook lifecycle. |
| AI integration | Mock, OpenAI Responses, OpenAI-compatible, Anthropic and Gemini adapters; page/content proposals, SEO/translation, validation, site policies and MCP | **Implemented foundation.** Live provider calls, model availability, broader governance, contextual retrieval and enterprise integrations need environment-specific tests. AI output never authorizes itself to publish. |
| Third-party plugins | Manifest/capability approval, Ed25519 provenance, pinned-image runner interface and restricted container invocation foundations | **Partial.** Full archive-to-signed-image supply chain, runtime isolation tests and adversarial review remain. |
| CI and verification | Workflow definitions for Node 22.23.4/24.22.1, PostgreSQL/Memgraph integration, Playwright and CodeQL; npm audit/SBOM steps; a release-readiness reporter that records test evidence and blocks on missing gates | **Configured/source-tested, not production-certified.** A committed lockfile, supported-runtime run, live services, real integrations, browser E2E, audit/SBOM and independent security evidence are still required. |
| Production validation | 105 SystemFabric unit tests passed on the previously recorded available runtime; syntax/artifact and live-integration checks are captured by `npm run release:readiness` | **Not production-certified.** Re-run checks against the exact target commit. The recorded environment had a Node version below the declared minimum and lacked several live integrations. Skipped integration tests are not passes. |

### Real-time foundation implementation update

A developer-preview foundation exists for a process-local authorization-aware event hub and authenticated site-scoped SSE presence refreshes. Foundation 1.1 implements the v1 PostgreSQL outbox envelope. Foundation 1.2 adds durable PostgreSQL consumer-group deliveries, explicit event-type subscriptions, independent retries/dead letters, ordering and replay; the Memgraph projector runs as `graph.projection.v1` and uses a monotonic aggregate sequence. Foundation 1.3 adds Redis/Memurai-compatible shared presence leases, multi-session aggregation, hidden-state filtering, per-site capacity and lazy expiry callbacks. Foundation 1.4 adds Redis Pub/Sub fan-out of bounded site-scoped `presence.refresh` invalidations to connected SSE clients on other API instances; receiving hubs recheck subscription authorization, and the live Redis integration validates heartbeat, site isolation and lazy expiry propagation across two API servers. Pub/Sub is ephemeral and best-effort, not the durable event source. Reconnect/resume cursors, collaborative editing, distributed connection quotas, load testing and production validation remain open. See [Real-Time Foundation 1](REALTIME-FOUNDATION-F1.md) for exact scope and limitations.

## Human-AI symbiosis and agency principles

The [SystemFabric Manifesto](../SYSTEMFABRIC_MANIFESTO.md) sets the project's purpose: technology should amplify human capability, preserve creative dignity and productive relevance, and support meaningful human participation as AI capabilities advance. The manifesto also identifies technological determinism, concentration of power and loss of human agency as guiding concerns. These are project values and design intentions, not measurable claims that the software can guarantee employment, income, or macroeconomic outcomes.

The engineering interpretation is:

- **Augment human capability:** prioritize tools that help people create, learn, coordinate, decide and contribute more effectively.
- **Preserve agency and choice:** make AI participation visible and controllable; provide meaningful ways to inspect, accept, reject, revise, undo or opt out of AI assistance where appropriate.
- **Use proportional oversight:** automate bounded, reversible, explicitly authorized tasks when policy permits; require human review for consequential, privileged, externally visible or difficult-to-reverse decisions.
- **Keep authority explicit:** AI agents act with delegated, scoped permissions and cannot grant themselves capabilities, bypass approvals, or alter their own governance controls.
- **Make contributions legible:** distinguish human-authored, AI-generated and collaboratively revised artifacts when that information matters to users, accountability or project history.
- **Support participation without surveillance:** design for skill development, accessible collaboration and meaningful contribution; do not turn presence or productivity telemetry into covert worker scoring.

These principles apply across the capabilities below. Their presence in the matrix indicates intended design scope, not shipped functionality.

## Strategic collaborative and AI capability matrix

The following rows are roadmap scope, not claims of current implementation. Priorities are relative sequencing guidance: **P0** = blocking platform safety/reliability, **P1** = foundational next capability, **P2** = major product capability after foundations, **P3** = strategic/advanced capability.

| Capability | Intended scope | Maturity | Priority | Principal dependencies / acceptance focus |
|---|---|---|---|---|
| Real-time event delivery | Authenticated, tenant-scoped event fan-out, reconnect/resume, backpressure and delivery observability | Planned | P1 | Event contract, outbox relay, transport and broker evaluation, authorization on subscribe and delivery |
| User and workspace presence | Online/idle/away state, heartbeats, device/session awareness and bounded presence leases | Planned | P1 | Ephemeral presence store, TTL/expiry, privacy controls and cross-instance behavior |
| CMS collaboration | Concurrent editing, cursors/selections, collaborator list, comments, conflict handling and revision integration | Planned | P1 | Collaboration model decision, event gateway, versioned documents, access checks and browser acceptance |
| AI writing assistant | Grammar, spelling, clarity, coherence, rewrite, autocomplete and contextual suggestions | Planned | P1 | Editor integration, provider governance, text privacy, streaming UX, user-controlled accept/reject and usage budgets |
| AI orchestration and context | Central task routing, context assembly, provider abstraction, budgets, traces and policy enforcement | Planned | P1 | AI policy engine, tenant-aware context retrieval, secure tool contracts and audit trail |
| AI roles/capabilities/permissions assistance | Explain access, identify risky grants, recommend least-privilege changes and draft policy diffs | Research / prototype | P1 | Canonical authorization model, capability matrix tests, human approval and immutable audit events; AI cannot grant itself access |
| AI security and firewall assistance | Explain alerts, correlate signals, recommend rules and draft incident response actions | Research / prototype | P1 | Reliable telemetry, threat model, trusted signals, false-positive review and human approval; no autonomous disruptive enforcement initially |
| Error reporting, monitoring and debugging assistance | Correlate errors/traces/log metadata, summarize incidents, suggest likely causes and diagnostic steps | Planned | P1 | Structured telemetry, redaction, trace correlation, retention controls and operator review |
| Collaborative admin environment | Shared admin sessions, change previews, co-editing of safe configuration and review/approval | Planned | P2 | Presence, authorization, audit log, configuration versioning and conflict-safe updates |
| Collaborative user environment | Personalized workspace with live activity, collaborative tasks, saved context and assistance | Planned | P2 | User identity/privacy model, presence and notification services, accessible interaction model |
| Contextual AI user assistant | User-scoped assistance grounded in permitted content and actions | Planned | P2 | AI context engine, user consent, authorization-aware retrieval and transparent citations/context sources |
| AI moderation | Spam/abuse classification, triage queues, policy explanations and moderator recommendations | Planned | P2 | Moderation policy, evidence retention, appeal/reversal workflow, bias review and human oversight |
| AI search | Natural-language and semantic retrieval across authorized content and platform records | Planned | P2 | Search indexing, tenant/ACL filters, freshness/deletion propagation, evaluation set and relevance metrics |
| AI documentation, help and translation | Contextual product help, generated draft documentation, translation suggestions and terminology consistency | Planned | P2 | Versioned documentation sources, localization workflow, editorial review and source provenance |
| AI-assisted UI semantics | Semantic component descriptions, accessible labels, interaction hints and consistency recommendations | Planned | P2 | Design/component metadata, accessibility standards, human review and automated/manual accessibility tests |
| Notification and badge presence | Live counters, unread state and notification fan-out across active sessions | Planned | P2 | Durable notification records, delivery preferences, event gateway and idempotent counter updates |
| Chat/forum presence | Typing indicators, active participants, discussion activity and live message delivery | Planned | P2 | Existing messaging/community foundations, privacy boundaries, moderation and abuse controls |
| AI presence | Visible assistant states such as queued, working, awaiting approval, streaming, completed and failed | Planned | P2 | AI task lifecycle events, privacy-safe status payloads and reconnect semantics |
| Observability presence | Live operational health, queue depth, latency, dependency status and incident indicators | Planned | P2 | Metrics/traces/log pipeline, alert rules, access controls and retention policy |
| Security presence | Live security activity, session-risk indicators, policy events and incident state | Planned | P2 | Security event schema, privileged visibility, alert thresholds and incident workflow |
| Workflow Studio | Collaborative Figma-like canvas for plans, decision trees, automation graphs and approval paths | Research / prototype | P3 | Workflow schema, node contracts, collaboration engine, simulation, execution isolation and versioning |
| AI workflow planning | Convert natural-language intent into draft workflows; explain, simulate and revise plans | Research / prototype | P3 | Workflow Studio, AI policy, typed node catalog, static validation and explicit execution approval |
| Workflow execution presence | Live node/task state, execution logs, participant presence and pause/resume status | Planned | P3 | Durable execution state machine, worker orchestration, event gateway and recovery design |
| Human-AI agency controls | Visible AI participation, user preferences, opt-in/opt-out controls and meaningful accept/reject/revise/undo paths | Planned | P1 | Shared AI task lifecycle, UI affordances, preference storage and accessibility acceptance |
| Human approval and recourse | Risk-tiered review, explanation, appeal/reversal and human intervention for consequential actions | Planned | P1 | AI policy engine, action classification, authorization, immutable audit and operational runbooks |
| AI contribution attribution and provenance | Identify AI-generated, human-authored and collaboratively edited contributions where useful and consented | Planned | P2 | Version history, actor identity, provenance metadata, privacy policy and export semantics |
| Collaborative knowledge and skill development | AI-assisted learning, contextual explanations, reusable team knowledge and skill-building workflows | Planned | P2 | Consent-aware context retrieval, source provenance, editorial controls and user feedback |
| Human participation and economic agency support | Tools that help people discover, organize and contribute meaningful work; transparent recognition of contributions | Research / prototype | P3 | Product discovery, governance, accessibility and research with affected users; no income or employment guarantee |

## Cross-cutting acceptance requirements

Every planned capability must satisfy the following before it can be marked implemented:

1. **Tenant and authorization boundaries:** enforce the authenticated principal's permissions on reads, writes, subscriptions, event delivery, background jobs and AI context retrieval.
2. **Human accountability:** privileged AI-suggested changes remain proposals until an authorized actor approves them. AI cannot approve its own actions, change its own policy, or elevate its own capabilities.
3. **Auditability:** record actor, tenant/site, action, decision, target, timestamp, correlation ID and approval context without storing secrets or unnecessary personal data.
4. **Failure behavior:** define retries, idempotency, timeouts, cancellation, reconnect, backpressure, stale state and partial failure behavior.
5. **Privacy:** minimize event payloads, redact sensitive telemetry, define retention/deletion behavior and respect user visibility preferences.
6. **Accessibility:** provide keyboard and screen-reader support, meaningful status announcements, reduced-motion support and usable non-real-time fallbacks.
7. **Provider independence:** core workflows must define behavior when an AI provider is unavailable, rate-limited, expensive or returns invalid output.
8. **Evidence:** attach tests and reviewed artifacts to the exact commit. A mocked provider test is not live-provider evidence; a skipped test is not a pass.
9. **Human agency:** make AI involvement visible and provide meaningful user control, recourse and undo where the operation allows it. Oversight should be proportional to impact rather than forcing human approval for every low-risk task.
10. **Consent and choice:** respect user preferences for AI assistance and data use; explain material context collection and provide non-AI paths where feasible.
11. **Contribution integrity:** represent AI and human contributions accurately when attribution is relevant. Do not imply that contribution metadata alone establishes authorship, ownership or compensation rights.
12. **No surveillance by default:** presence, activity and productivity telemetry must not become covert individual performance scoring. Define purpose, visibility, retention and access before collection.
13. **Societal aspiration boundary:** the manifesto's economic-agency goals are guiding aims. Product documentation must not promise employment, income, job protection or macroeconomic results.

## Parity boundaries

WordPress, Elementor, WooCommerce and BuddyPress remain useful comparison points for selected product areas. SystemFabric should define explicit acceptance subsets for each comparison. Do not claim full parity based on a similarly named module, API route, data table, or visual control.

The collaborative AI-native capabilities are an additional strategic direction, not a substitute for completing the existing core platform, security and release gates.

## Release statement

SystemFabric 0.5.1 is an expanded developer-preview hardening candidate. It is not feature-equivalent to WordPress, WooCommerce, BuddyPress or Elementor and has not been production-certified. The strategic AI and real-time capabilities in this document are planned or research-stage unless a row explicitly states otherwise. See `LOCAL-VALIDATION.md`, `RELEASE-GATE.md`, `RELEASE-EVIDENCE.md` and [the roadmap](ROADMAP.md).
