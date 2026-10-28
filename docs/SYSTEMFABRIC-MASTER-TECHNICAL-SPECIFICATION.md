# SystemFabric Master Technical Specification

**Document version:** 0.5.1  
**Status:** Foundation baseline / architecture RFC accepted for implementation  
**Product classification:** AI-integrated, contract-driven headless CMS and HTML rendering runtime  
**Primary runtime:** Node.js 22.23.4+  
**Authoritative content store:** PostgreSQL  
**Relationship query projection:** Memgraph  
**Initial renderer:** EnginEx 6.2.0, vendored and pinned under `vendor/enginex/`  
**Last updated:** 2026-10-27

> This specification defines the intended architecture and the current starter implementation. Sections marked “implemented baseline” exist in the repository. “Planned / release gate” items are not claimed to be complete. SystemFabric 0.5.1 is not production-certified.

## 1. Executive summary

SystemFabric is a modular Node.js content-management platform inspired by WordPress's content workflows and Elementor's visual page-building model. It represents pages as versioned, structured JSON documents; manages content and revisions in PostgreSQL; uses Memgraph as a relationship-oriented projection for traversal-heavy queries; renders through an EnginEx-based subsystem; exposes manifest-driven widgets and content-type definitions; and integrates AI through provider adapters, validated structured outputs, and the Model Context Protocol (MCP).

SystemFabric is not designed as a monolithic application that permits every module to query every store or execute arbitrary plugins inside the main process. The architecture uses explicit service boundaries and contracts so that the editor, content services, renderer, graph projection, AI service, and integrations can evolve independently.

### 1.1 Product goals

1. Provide a headless CMS core for pages, posts, custom content types, media references, revisions, publication workflows, and relationships.
2. Provide an Elementor-style nested page-document model and an extensible widget registry.
3. Reuse EnginEx as the rendering subsystem, retaining compiled templates, prepared data, incremental fragment capabilities, bounded workloads, and telemetry where appropriate.
4. Use PostgreSQL for authoritative writes and Memgraph for a rebuildable graph projection.
5. Integrate AI into page creation, content assistance, SEO suggestions, translation, document explanation, preview, and developer tooling without making AI a required runtime dependency.
6. Keep model outputs and third-party plugin inputs untrusted; constrain capabilities outside the model.
7. Make performance and correctness measurable with deterministic fixtures, telemetry, resource ceilings, and staged release gates.

### 1.2 Non-goals for the first release

- Full feature parity with WordPress or Elementor.
- Arbitrary PHP execution, arbitrary JavaScript in page documents, or unrestricted raw-HTML injection.
- Automatically publishing AI-generated content.
- Treating an LLM as an authorization authority, database administrator, or autonomous operator with unrestricted write access.
- Guaranteeing atomic transactions across PostgreSQL and Memgraph by application-level compensating scripts.
- Requiring graph traversal for every page request.
- Claiming production performance superiority before representative load tests.
- Running untrusted extension code inside the main API process.

## 2. Logical architecture

```text
Admin / Visual Editor / API Clients / MCP Hosts
                         |
                  Identity + API Edge
                         |
                 SystemFabric Core API
          +--------------+----------------+
          |              |                |
    Content Service  Widget Registry  AI Orchestrator
          |              |                |
   PostgreSQL       Versioned manifests  Provider adapters
          |              |                |
          +--------- Render Request ------+
                         |
               EnginEx-based Renderer
                         |
                 HTML / preview / patches
                         |
                 Cache and delivery

PostgreSQL transactional outbox ---> Projection Worker ---> Memgraph
        |                                               |
        +---- canonical relationships + revisions ------+
```

This is a logical diagram. It is not a mandatory synchronous call sequence. Public cache hits can avoid data hydration. Graph-dependent services use Memgraph when the required projection is sufficiently fresh. Authorization decisions must not rely solely on stale graph data.

### 2.1 Module boundaries

| Module | Owns | Must not own |
|---|---|---|
| Core API | Contracts, routing, request context, authorization integration, orchestration | Template parsing internals, model-vendor-specific logic, direct arbitrary extension execution |
| Content service | Content records, drafts, revisions, publication lifecycle, content schema resolution | Graph query optimization or HTML widget rendering |
| PostgreSQL repository | Parameterized SQL and authoritative transactions | Business permissions or prompt construction |
| Graph projection service | Memgraph projection and relationship traversal | Canonical content payloads, user passwords, authoritative authorization policy |
| Widget registry | Widget manifests, property contracts, compatibility metadata | Running arbitrary package code during registry discovery |
| Rendering runtime | Validated document + prepared data → HTML / incremental result | Direct SQL, publication decisions, AI provider calls |
| AI service | Prompt/task construction, provider adaptation, schema validation, usage audit | Unreviewed publishing, unrestricted database access, raw secrets in prompts |
| Plugin subsystem | Package metadata, API compatibility, declared capabilities, activation state | Assuming third-party npm code is safe because it installed successfully |
| MCP adapter | Publish narrowly scoped tools/resources/prompts to AI clients | Bypassing normal domain validation, authentication, authorization, or approval controls |

## 3. Data ownership and consistency

### 3.1 PostgreSQL is the source of truth

PostgreSQL owns canonical page/post data, structured page documents, content-type definitions, revisions, media metadata, canonical relationship records, user and role records, site memberships, publication status, audit events, AI usage metadata, and transactional outbox events.

The initial schema is `database/migrations/0001_initial.sql`. It is a baseline for review, not a substitute for migration rehearsals, backup testing, and production schema governance.

`JSONB` is used for versioned page documents and flexible metadata. Indexes must be designed from measured query patterns; do not add wide GIN indexes indiscriminately. Search begins with a maintained `tsvector` and GIN index. The application must update the search vector transactionally when content changes.

Binary media lives in object storage, not inside Memgraph and normally not in page JSON. PostgreSQL stores the asset identifier, storage key, MIME type, dimensions, alt text, ownership, and derivative metadata.

### 3.2 Memgraph is a projection

Memgraph stores lightweight relationship topology and query-friendly node properties, not heavy content blobs. Node IDs refer to canonical content UUIDs. The initial graph projection label is `Content`; relationship types are allow-listed (`HAS_TERM`, `PARENT_OF`, `RELATED_TO`, `LOCALIZED_AS`, `NAVIGATES_TO`). Dynamic labels or relationship types must never be interpolated from untrusted values.

Canonical relationship edges are recorded in PostgreSQL. This allows the projection to be replayed or rebuilt after a graph loss, schema change, or synchronization defect. Memgraph may add indexes/projections optimized for graph traversal, but those are not the only durable copy of the relationships.

### 3.3 No false two-phase-commit guarantee

A Node.js function that writes to PostgreSQL and then Memgraph cannot guarantee atomic commit across both stores by merely running compensating rollback scripts. SystemFabric therefore uses a transactional outbox:

1. Begin a PostgreSQL transaction.
2. Write content/revision/canonical relation changes.
3. Add outbox events in that same transaction.
4. Commit PostgreSQL.
5. A worker leases pending outbox events and applies them to Memgraph.
6. Successful events are marked processed; failures retry with bounded exponential backoff and eventually become dead-letter events.
7. A reconciliation task compares canonical PostgreSQL relationships with graph projections and can rebuild a site's projection.

Workers must be idempotent, version-aware, duplicate-safe, observable, and safe to restart. A graph projection event that is older than the current projected version must not overwrite newer state.

### 3.4 Consistency contract

- PostgreSQL writes are the authoritative commit point.
- Memgraph relationship projections are eventually consistent.
- The API returns the committed database state even if graph projection is delayed, but it reports projection lag through operational telemetry.
- Relationship-heavy features can use a PostgreSQL fallback or a cached graph snapshot when available.
- Authorization never becomes more permissive because a graph projection is stale.
- Failed graph events are visible and recoverable; silent dropping is forbidden.

## 4. Identifiers, sites, and tenancy

- Use UUIDv4 as the initial canonical identifier across PostgreSQL, graph nodes, outbox events, API DTOs, and revisions. A future ULID migration would require a deliberate compatibility plan.
- Do not confuse database-generated foreign keys with public content identifiers.
- Every content, relationship, media, audit, and AI usage record is scoped to a `site_id` where relevant.
- Every data repository method must require a site context, not infer it from untrusted request body fields.
- Public route identity is `(site_id, content_type, locale, slug)` with uniqueness enforced in PostgreSQL.
- Site identity may be derived from a verified hostname, signed token claim, or trusted route configuration. It must not be selected by accepting an arbitrary `siteId` from an unauthenticated client.
- In 0.4.0, cookie-backed database sessions and per-site memberships/capabilities are implemented when PostgreSQL and migrations are configured. The `SYSTEMFABRIC_DEFAULT_SITE_ID` plus static bearer path is retained only as a non-production local development mode; it is not a substitute for production identity controls.

## 5. Content and page-document model

### 5.1 Page document contract

Every page document includes:

- `schemaVersion`: integer; the initial version is `1`.
- `documentId`: stable identifier for the document instance.
- `type`: currently `page`.
- `title`: page title.
- `children`: recursive array of nodes.

Every node includes `id`, `type`, `props`, and `children`. Stable node identifiers make editor operations, migrations, and incremental dependency mapping possible. The initial widget types are `section`, `column`, `container`, `widget.heading`, `widget.text`, `widget.button`, `widget.image`, `widget.list`, `widget.quote`, `widget.divider`, and `widget.spacer`.

The domain validator limits node count and depth, rejects unknown node types and unknown property names, validates heading levels and text lengths, restricts CSS class names, and permits only relative or HTTP(S) button URLs. Image nodes reference asset IDs rather than arbitrary external image markup. Inline styles, event handlers, scripts, arbitrary HTML blobs, and executable widget expressions are not valid page-document fields.

Canonical schema: `schemas/page-document.schema.json`. Runtime validation is implemented in `packages/domain/src/page-document.js`. Runtime domain validation is required even when a model provider claims to have emitted schema-conforming JSON.

### 5.2 Schema migrations

- Each document declares a schema version.
- Widget nodes declare a widget version in the widget registry or migration metadata.
- Migrations are deterministic pure transforms where possible.
- Migrate a copy, validate the target schema, and retain the original revision.
- Do not rewrite published source documents in place without a recorded revision.
- Unknown future versions fail closed for editing and should render only through an explicitly compatible fallback.

### 5.3 Custom content types

Git-managed definitions live in `/config/cpt/*.json`; admin-managed definitions live in PostgreSQL. Both sources normalize into one internal `ContentTypeDefinition` shape with explicit `source`, `version`, `fields`, `validationRules`, `capabilities`, `relationships`, and publication policy.

Conflict policy is explicit ownership, not silent field merging. If both Git and the dashboard define the same slug, the registry should report a conflict and reject activation until an authorized operator resolves it. A registry update should be built off to the side, validated in full, and atomically swapped to the active registry version.

Field types must be allow-listed (e.g. `string`, `number`, `boolean`, `date`, `enum`, `assetRef`, `relationRef`, `richDocument`). A field schema cannot request execution of arbitrary JavaScript.

## 6. Visual builder and widget system

### 6.1 Editor responsibilities

The editor manipulates structured nodes, not raw output markup. It must support stable node IDs, undo/redo, draft autosave, revision restore, responsive breakpoints, reusable templates, global design tokens, accessibility metadata, preview state, and schema migration warnings.

The first repository contains a local AI-assisted developer console; a full drag-and-drop editor is a future phase. The console does not claim to be Elementor feature parity.

### 6.2 Widget manifest

Each widget manifest should declare:

- Stable unique `name` and semantic version.
- `apiVersion` for compatibility.
- Editor label/category/icon metadata.
- Property JSON Schema and defaults.
- Whether children are allowed and permitted child types.
- Responsive style capabilities.
- Rendering implementation entry point and capability declaration.
- Migration functions from prior widget versions.
- Accessibility and asset requirements.
- Required extension capabilities.

The registry validates all manifests before activation. Core widgets are trusted source-controlled modules. Third-party packages require integrity verification, compatibility validation, admin approval, and a constrained execution boundary.

### 6.3 Plugin execution safety

An npm package is executable code. The platform must not assume that a package is safe because it has a `package.json`, is signed, or was uploaded by an editor. Package installation should occur in a separate worker/container with restricted filesystem/network access. Registry discovery should inspect manifests without automatically executing plugin code.

Trusted first-party plugins may run in-process under the application's normal security controls. Third-party extensions should use a narrow RPC/worker protocol; a Node worker thread alone is not a security boundary. Plugins must declare capabilities (content read, content write, media read, network access, filesystem access) and receive only the minimum required.

## 7. Rendering runtime based on EnginEx

EnginEx is the initial rendering subsystem, vendored as version 6.2.0. It is kept behind `packages/render/src/index.js` so SystemFabric can evolve or replace the renderer without coupling content models to one engine's internal types.

### 7.1 Rendering request lifecycle

1. Resolve canonical route and site context.
2. Authenticate and authorize the request (editor preview and private content require protected access).
3. Resolve publication/version state.
4. Load the page document and required content/asset/widget/template data in batched repository calls.
5. Normalize the data into a validated, immutable render snapshot.
6. Resolve the exact active widget registry and template versions.
7. Render with EnginEx and controlled widget wrappers.
8. Return HTML, preview diagnostics, and trace metadata; optionally cache public output under a version-aware key.

The renderer must not query PostgreSQL or Memgraph while walking each widget. That creates N+1 I/O behavior and blurs the security boundary. Data retrieval and render execution remain separate.

### 7.2 Safety and deterministic rendering

Page documents do not contain HTML injection points. Text values go through EnginEx's escaping. URL attributes use validated URLs and the engine's URL-safe helper. Widget rendering uses allow-listed static templates. SystemFabric's output must not be considered secure merely because a template engine is present: every widget is part of the output security boundary, and a new widget cannot bypass the domain contract.

EnginEx's current output-context analyzer is a diagnostic aid, not a complete HTML parser or a universal sanitizer. A separate security review must cover template helpers, URL handling, widget renderers, HTML output, Content Security Policy, and browser sinks.

### 7.3 Incremental rendering

The page builder's stable node IDs and versioned document structure can contribute to dependency tracking. Incremental rendering is enabled only when dependencies are known and the chosen render path supports it. Unknown dependencies, helper side effects, version changes, or incomplete dirty-state information trigger conservative full rendering.

An incremental update must carry document version, template/registry version, data revision, trace ID, and fragment identifiers. If client and server versions diverge, the server returns a full render or requires resynchronization. Never apply a fragment patch to a different base document revision.

### 7.4 Cache rules

- Never cache authenticated draft previews in a shared public cache.
- Cache keys include site, route, locale, published document version, template version, registry version, feature flags, and other output-affecting dimensions.
- Personalization and authorization variants require distinct cache keys or no shared caching.
- Publishing or mutating referenced data generates invalidation events.
- If precise dependency invalidation cannot be computed safely, use broader invalidation rather than serve stale output.
- Cache is an optimization, not an authority source; authorization checks must still be preserved.

## 8. AI integration architecture

AI is a first-class, optional subsystem, not a required part of page rendering. The application supports provider adapters behind a common `generate({system,input,schemaName,schema,maxOutputTokens})` contract. Current provider adapters are `openai-responses`, `openai-compatible`, `anthropic`, `gemini`, and `mock`.

### 8.1 AI capabilities in the baseline

- Generate an unsaved page-document proposal from a natural-language brief.
- Rewrite, proofread, shorten, expand, or clarify text.
- Generate title/description/keyword suggestions for SEO.
- Translate supplied text.
- Validate page documents and render safe preview HTML.
- Expose safe capabilities through MCP for AI coding tools and assistants.

### 8.2 Planned AI capabilities

- AI-assisted content type and widget manifest authoring, subject to schema validation.
- Explain page structures and identify accessibility/SEO issues.
- Suggest responsive layout variants and alternative page sections.
- Semantic content retrieval and retrieval-augmented generation after content access policies are established.
- Draft localization variants with locale-specific review workflows.
- Automated fixture/evaluation generation for template changes.
- Model/provider routing based on task type, cost ceilings, latency, and data sensitivity.

These planned features must use the same provider adapter and policy services; they should not create ad hoc model calls throughout the codebase.

### 8.3 AI data boundaries

- Each AI task has a typed input and output schema.
- Model output is untrusted; validation happens after every provider call.
- Page generation returns a draft proposal. It does not save or publish.
- Saving a draft is a separate explicit request, with authenticated actor and site scope.
- Publishing, deleting, bulk changes, user/role changes, plugin installation, and configuration changes require a separate domain operation and action-specific human approval.
- Model-provided tool arguments must be revalidated at the tool boundary using the caller's current permissions.
- AI context retrieval must filter by tenant and user permission before data reaches the provider.
- External AI data processing is blocked by default by the AI service (`AI_ALLOW_EXTERNAL_CONTENT=false`). When explicitly enabled, submitted prompts and content are sent to the configured provider; deployments must document approved data classes and provider retention policy. `store:false` is set for OpenAI Responses and Gemini Interactions to opt out of response-object retrieval storage, but is not a zero-retention guarantee.
- Prompt bodies and model responses are not written to standard logs by default. Audit records store provider/model/action/status/latency and usage estimates, avoiding unnecessary sensitive content retention.
- API keys are configured in server-side environment/secret management, never sent to browser code or included in page documents.

### 8.4 Provider-specific behavior

OpenAI Responses supports structured output formats and tool calls; SystemFabric uses structured outputs where supported and independently validates every result. OpenAI-compatible providers may expose only JSON mode or no schema-constrained generation; local validation remains mandatory. Anthropic requests JSON in its instruction contract; Gemini uses the Interactions API structured-output format. All adapters reject malformed output. Model names, endpoint support, and provider SDK contracts must be verified when deployments are upgraded.

### 8.5 MCP

The MCP server exposes only a constrained, local stdio tool set in 0.4.0:

- `systemfabric_status` — non-sensitive service status.
- `systemfabric_list_widgets` — approved widget catalog.
- `systemfabric_validate_page_document` — validate a serialized document.
- `systemfabric_generate_page_draft` — generate an unsaved document proposal.
- `systemfabric_render_preview` — render a validated document to safe HTML without persisting it.

The initial transport is stdio for local host integration. The MCP process inherits the launching user's local access and must be configured as a trusted local tool. It does not expose publish/delete/write tools. If a network MCP endpoint is added later, implement transport authentication, tenant propagation, per-tool authorization, request size/rate limits, audit metadata, and human approval before enabling write tools. Stdout is reserved for the MCP protocol; diagnostics go to stderr.

## 9. API contract summary

The 0.4.0 API provides database-backed identity, site tenancy, content and publication workflows, AI policy/usage controls, media adapters, taxonomy relationships, plugin provenance/runner interfaces, and public delivery. Endpoint availability is conditional on PostgreSQL migrations and optional providers. Protected operations require an authenticated actor and site membership/capabilities; the development bearer-token path is disabled in production. Live integration status is documented in LOCAL-VALIDATION.md.

| Area | Routes | Notes |
|---|---|---|
| Identity | `POST /api/v1/auth/bootstrap`, `POST /api/v1/auth/login`, `POST /api/v1/auth/invitations/accept`, `GET /api/v1/auth/me`, `POST /api/v1/auth/logout` | One-time bootstrap, database sessions, invitations; cookie writes require CSRF token |
| Sites | `GET/POST /api/v1/sites`, `GET/POST /api/v1/sites/{siteId}/members`, `DELETE /api/v1/sites/{siteId}/members/{userId}`, `POST /api/v1/sites/{siteId}/invitations` | Site-scoped role/capability checks |
| Content | `GET /api/v1/pages`, `POST /api/v1/pages/drafts`, `GET /api/v1/pages/{id}`, `GET /api/v1/pages/{id}/revisions`, `POST /api/v1/pages/{id}/restore/{version}` | Tenant-scoped content and revision history |
| Publication | `POST /api/v1/pages/{id}/submit-review`, `/approve`, `/reject`, `/publish`, `/schedule`, `/unpublish`, `/archive` | Capability-checked state transitions and immutable published snapshots |
| Page documents | `POST /api/v1/pages/validate`, `POST /api/v1/preview`, `GET /api/v1/widgets` | Validation and safe preview |
| Custom content types | `GET/POST /api/v1/content-types`, `POST /api/v1/content-types/{slug}/records`, `GET/PATCH /api/v1/content-types/{slug}/records/{id}` | Git/admin schema resolution with validation |
| Media | `POST /api/v1/media/uploads`, `GET /media/{assetId}` | Bounded signature-checked raster upload; public media only in current release |
| AI | `GET /api/v1/ai/status`, `POST /api/v1/ai/page-draft`, `/content-assist`, `/seo`, `/translate` | External provider calls opt-in; outputs are proposals |
| Plugins | `GET /api/v1/plugins`, `POST /api/v1/plugins/register`, `POST /api/v1/plugins/{id}/approve`, `/activate`, `/disable`, `/invoke` | Registration is metadata-only; execution requires private runner and pinned allowlisted OCI image |
| Public delivery | `GET /public/{siteSlug}/pages/{slug}`, `GET /api/v1/public/{siteSlug}/search` | Published snapshots and public indexed results only |

Publication and plugin operations enforce per-site capabilities. This foundation still lacks full CMS parity and requires the production gates in the release manifest before deployment.

## 10. Security architecture and threat assumptions

Threat categories include cross-site scripting, SSRF through asset URLs, cross-tenant data access, stale authorization projections, malicious plugins, dependency supply-chain compromise, AI prompt injection, AI output injection, credential leakage, resource-exhaustion prompts, unsafe MCP tools, and stale cache variants.

Controls in the current preview include bounded HTTP request bodies, bounded in-memory rate-limit buckets, database-backed sessions, password hashing, CSRF/origin checks for cookie writes, site capability checks, strict page-document validation, widget allow-lists, escaped output, safe URL checks, no executable markup fields, no publish/delete MCP tools, response security headers, structured AI audit metadata, output validation, and production-startup guardrails. These controls have unit coverage but have not completed live integration, adversarial, or independent security validation.

These controls do not complete a production security posture. Remaining gates include end-to-end validation of password recovery and verified-email delivery, TOTP MFA and OIDC/SAML against real identity providers, comprehensive property-based role/capability checks across every object endpoint, hardened reverse-proxy and host/origin configuration, secret-manager integration, plugin sandbox adversarial testing, dependency scanning/SBOM, storage access controls, backup/restore drills, fuzzing, prompt-injection testing, penetration testing, and external review.

## 11. Observability and operations

Every request gets a trace/request ID. Structured logs must record route, status, latency, error code, site identifier when safely available, cache result, graph projection lag, and AI provider action metadata. Do not log bearer tokens, API keys, raw prompt text, private documents, or complete model output by default.

Required service metrics:

- HTTP request count, p50/p95/p99 latency, response codes, rate limits, and body rejection count.
- PostgreSQL pool occupancy, query latency, deadlocks, transaction failures, and migration status.
- Outbox pending count, oldest pending age, retry count, dead-letter count, and projection lag.
- Memgraph driver errors, query latency, and reconciliation mismatches.
- Render duration, document/node count, widget duration, render profile, memory, cache hit/miss, invalidation count, and full-render fallback count.
- AI provider latency, task count, error rate, input/output size, estimated token usage, timeouts, and budget/limit events.
- Plugin activation failures and execution timeouts after the isolated plugin runtime is implemented.

Production rollout uses staged environments, canary releases, feature flags, backward-compatible migrations, restore-tested backups, rollback manifests, and explicit gates. Do not deploy an unreviewed migration just because unit tests pass.

## 12. Performance philosophy

Optimize measured end-to-end workloads, not isolated assumptions. First implement correct contracts and fixtures, then benchmark representative public pages, editor previews, relationship-heavy listings, personalized content, and AI-generated documents. Compare cache hit/miss cases and cold/warm runtime conditions separately.

The current renderer rejects HTML output above 2 MiB and the API bounds request JSON to 1 MiB by default. These limits are starter defaults and must be tuned using representative workloads.

Resource limits must be explicit: maximum body bytes, prompt characters, page node count, tree depth, widget execution budget, renderer queue depth, AI output tokens, AI request timeout, plugin execution duration, query timeout, and background worker batch size. Overload should reject or defer work rather than build unbounded queues.

EnginEx's optional accelerators are not enabled merely because they exist. Each is feature-gated and must beat the correct baseline on the target deployment before becoming a default.

## 13. Reliability and recovery

- PostgreSQL backups must be encrypted and restore-tested.
- Content revisions and canonical relationship records must be sufficient for recovery.
- Graph projection can be rebuilt by replaying canonical relationships and content events; a projection rebuild is idempotent.
- Outbox retries are bounded and dead-lettered; operational tooling can inspect and replay dead events.
- Cache can be cleared/rebuilt without data loss.
- AI provider outage must not prevent ordinary content reads or deterministic page rendering.
- A failed AI provider call must not partially mutate a page draft.
- Plugin failure must be isolated from the core renderer.
- A malformed page document fails validation with a safe diagnostic instead of arbitrary renderer execution.

## 14. Acceptance criteria for the 0.4.0 developer-preview foundation (historical)

1. The repository installs on a supported Node.js runtime and the test suite passes.
2. Domain validation rejects malformed trees, unknown nodes/properties, excessive depth/nodes, bad links, and duplicate node IDs.
3. EnginEx render fixtures escape text and produce deterministic output for known documents.
4. AI providers are selected from configuration; missing credentials fail closed; provider errors do not leak secrets.
5. Every AI page proposal is normalized, validated, marked unsaved, and marked unpublished.
6. MCP exposes only the documented safe tools and does not include publish/delete functions.
7. The outbox schema supports leases, retries, deduplication, and dead-lettering.
8. PostgreSQL repository uses parameterized queries and transactionally creates content, revision, and outbox entries.
9. Production startup is blocked until missing security gates are implemented and reviewed.
10. Documentation differentiates implemented behavior from planned features and does not claim performance/security certification.

## 15. External technical references

- PostgreSQL JSON and JSONB: https://www.postgresql.org/docs/current/datatype-json.html
- PostgreSQL full-text search: https://www.postgresql.org/docs/current/textsearch.html
- Memgraph Bolt/Neo4j driver compatibility background: https://memgraph.com/blog/memgraph-1-2-release-implementing-the-bolt-protocol-v4
- OpenAI Responses API: https://developers.openai.com/api/reference/responses/overview
- OpenAI structured outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- Model Context Protocol TypeScript SDK: https://ts.sdk.modelcontextprotocol.io/v2/
- OWASP LLM Prompt Injection Prevention: https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html


## Implementation status update — 0.4.0 (historical)

The repository includes a functional starter drag-and-drop Studio editor, database-backed identity and site capability checks, reset/verification token workflows, TOTP MFA, OIDC and optional SAML foundations, content revisions and publication workflows, S3-compatible media storage, taxonomy/relationship APIs, site AI policies and usage budgets, Ed25519 plugin artifact/SBOM provenance, and CI definitions for PostgreSQL/browser checks. These are implementation foundations, not evidence that every integration is production-ready.

The theme/site builder, extensive global component ecosystem, forms/ecommerce/comments, complete marketplace, automatic archive-to-OCI supply chain, and full WordPress/Elementor feature parity remain incomplete. The local environment did not provide supported Node.js, a clean install/lockfile, live databases, external identity/media providers, browser runtime, or a container engine. The current validation limits and mandatory release gates are tracked in `docs/LOCAL-VALIDATION.md` and `docs/RELEASE-GATE.md`.

### Authoritative cross-service behavior

PostgreSQL is the authority for content, revisions, sessions, memberships, permissions and workflow state. Content writes and outbox events are committed atomically within PostgreSQL. Memgraph receives versioned, idempotent projection updates asynchronously and is rebuildable. It is not a second transaction participant and does not grant authorization. The renderer consumes validated, prepared documents/data and has no implicit authority to query or mutate CMS records. Plugin execution crosses a separate runner protocol and is disabled until a pinned, allowlisted OCI image and private runner are configured.


## Additional release validation note — 0.4.0 (historical)

The release contains implementation foundations for password reset and email verification, TOTP MFA, OIDC and SAML SSO, S3-compatible media storage, site-scoped taxonomy/relationship APIs, site AI policy and usage budgets, Ed25519 plugin artifact/SBOM provenance, and CI jobs for PostgreSQL/browser checks. These additions are not considered production-validated because the corresponding live providers, PostgreSQL/Memgraph services, browser binaries, and container runtime were unavailable during local packaging. The remaining release gates are tracked in `docs/RELEASE-GATE.md` and must not be read as completed work.


## SystemFabric 0.4.0 platform extension (historical)

This release adds unified File/Document/Media Library records and derived variants, curated icons, bounded TeX rendering, product/order/membership foundations, community primitives, mega-menu presentation, application-level firewall rules, and cloud adapter families. The migration is `0006_platform_libraries_commerce_social_billing.sql`.

PostgreSQL remains authoritative for content/configuration. Memgraph continues to be a relationship projection. Content document IDs and versions are separate from library asset IDs and versions. External storage blobs and SQL records are not atomically committed; compensation helps with ordinary failures but needs orphan reconciliation for process-crash recovery.

AI provider integrations remain policy-gated and produce untrusted proposals. The AI layer does not bypass site capabilities, publish content directly, change billing state directly, or activate plugins. File uploads and rich-content processing are likewise untrusted inputs; SVG upload is denied, math rendering uses `trust:false` when KaTeX is installed, and third-party plugins must never be loaded as trusted in-process code merely because they were packaged.

The 0.4.0 feature families are foundations, not full WordPress/WooCommerce/BuddyPress/Elementor parity. Consult `FEATURE-PARITY.md`, `PLATFORM-FEATURES.md`, `LIBRARIES-AND-MEDIA.md`, `COMMERCE-AND-MEMBERSHIPS.md`, `CLOUD-INTEGRATIONS.md`, and `RELEASE-GATE.md` for the precise maturity boundaries.


## Implementation status update — 0.5.0 (historical)

This version adds a ClamAV `clamdscan` adapter and scan-gated library uploads: production uploads fail closed if a scanner is unavailable, infected, or errors; non-production uploads without a scanner are quarantined and remain non-public. Migration `0007_release_hardening.sql` adds scan-status metadata and schema foundations for conversations/messages, blocks/reports/notifications, coupon redemptions, stock reservations, refunds, download entitlements and moderation actions. The presence of those tables does not imply complete application workflows.

A local library-object reconciler is exposed as `npm run reconcile:library`; it is dry-run by default, only handles local files, respects database references and age thresholds, and requires `--apply` to delete candidates. S3, Google Cloud Storage and Azure adapters now expose read-only connectivity probes, and cloud connection tests execute those probes when SDKs, configuration and credentials are available. These operations were tested with unit mocks only in the current environment.

The CI workflow now defines a supported-Node matrix, PostgreSQL/Memgraph integration services, browser/accessibility smoke tests, dependency audit/SBOM steps and CodeQL. These definitions have not produced verified CI results during local packaging. Current local validation is 76 passing SystemFabric tests and 88 passing vendored EnginEx tests, with 3 database integration tests skipped. The environment's Node.js 22.16.0 is below the declared 22.23.4 minimum; there is no reviewed lockfile, clean `npm ci`, live database/provider run, Playwright E2E, container runtime validation, production load test or independent security review. See `LOCAL-VALIDATION.md`, `FEATURE-PARITY.md` and `RELEASE-GATE.md`.

## Implementation status update — 0.5.1

The 0.5.1 hardening candidate adds user-facing, site-scoped direct conversations/messages, notifications/read markers, blocks, reports and moderation APIs. Checkout creation now persists its provider request snapshot for idempotent recovery, reconciles expired stock holds against Stripe Checkout Session state (never releasing stock solely because a local timer elapsed), and commits/releases reservations transactionally on observed payment/expiration transitions. The release-readiness command records machine-readable checks and keeps external deployment evidence fail-closed. These changes are covered by unit tests but still require live PostgreSQL/Stripe, browser, security and supported-runtime validation.

SystemFabric 0.5.1 remains an expanded developer preview, not a production-certified or full WordPress/WooCommerce/BuddyPress/Elementor equivalent release.
