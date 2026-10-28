# SystemFabric API Contracts v1

## Common behavior

- Base prefix: `/api/v1`.
- JSON request bodies are bounded by `MAX_REQUEST_BYTES` by default; media uploads use a separate bounded ceiling. A request identifier is emitted in `x-request-id` and error JSON.
- Errors use `{ "error", "code", "requestId", "details?" }`.
- Interactive browser clients use an HttpOnly `sf_session` cookie plus the `sf_csrf` cookie and `x-csrf-token` header on unsafe requests. Bearer `SYSTEMFABRIC_API_TOKEN` is a local development facility and is rejected in production mode.
- Site-bound APIs require a verified membership/capability or a local development token. An explicitly selected `siteId` is recommended even when the user belongs to one site.
- Public page delivery reads immutable published snapshots; it never returns a draft body.

## Identity and tenancy

- `POST /api/v1/auth/bootstrap` — create the initial owner/site only when the configured bootstrap secret matches and no active account exists.
- `POST /api/v1/auth/login` — create a database-backed session; session credential is set as HttpOnly cookie.
- `GET /api/v1/auth/me` — current user and site memberships.
- `POST /api/v1/auth/logout` — revoke current session and clear cookies.
- `POST /api/v1/auth/invitations/accept` — accept a one-time invite token; new accounts must choose a compliant password.
- `POST /api/v1/auth/password-reset/request` and `POST /api/v1/auth/password-reset/complete` — request a one-time reset and complete it with the short-lived token. The response is designed not to disclose whether an account exists. Configure and test the mail provider before enabling this workflow publicly.
- `POST /api/v1/auth/email-verification/request` and `POST /api/v1/auth/email-verification/confirm` — issue and consume one-time verification tokens.
- TOTP MFA enrollment, confirmation, challenge, recovery-code, and disable operations are supported by the identity service; test key management, replay protection and recovery procedures before production.
- `GET /api/v1/auth/oidc/start` and `GET /api/v1/auth/oidc/callback` — configurable OIDC federation with pre-provisioned account linking.
- `GET /api/v1/auth/saml/metadata`, `GET /api/v1/auth/saml/start`, and `POST /api/v1/auth/saml/acs` — optional SP-initiated SAML federation. SAML requires PostgreSQL-backed shared request-state storage and a currently valid trusted IdP signing certificate. Production URLs must use HTTPS; configure the SP RSA key/certificate pair if signed AuthnRequests are required by the IdP.
- `GET /api/v1/sites`, `POST /api/v1/sites` — list/create sites (site creation requires an existing site-owner membership).
- `GET|POST /api/v1/sites/{siteId}/members`, `DELETE /api/v1/sites/{siteId}/members/{userId}` — member management.
- `POST /api/v1/sites/{siteId}/invitations` — issue a short-lived single-use invite. The API returns the token to the privileged caller; it must be delivered through a trusted channel and not ordinary logs.

## Content and page builder

- `GET /api/v1/pages?siteId=...` — list pages visible to the current user.
- `GET /api/v1/pages/{id}` — read content scoped to the selected site and permissions.
- `POST /api/v1/pages/drafts` — validate/save a new draft or a new revision. Supply `expectedVersion` when updating a loaded record to avoid overwriting concurrent edits.
- `GET /api/v1/pages/{id}/revisions` — revision metadata.
- `POST /api/v1/pages/{id}/restore/{version}` — restore a prior snapshot by creating a new draft revision.
- `POST /api/v1/pages/validate` — validate a page document without persistence.
- `POST /api/v1/preview` — render a valid document into CSP-restricted HTML without saving.
- `POST /api/v1/pages/{id}/submit-review`, `.../approve`, `.../reject`, `.../publish`, `.../schedule`, `.../unpublish`, `.../archive` — transition content with capability checks. Workflow transitions accept optional `expectedVersion` and `note`; scheduling also requires an ISO `scheduledAt` between one minute and one year ahead.
- `GET /public/{siteSlug}/pages/{slug}` — public published render only.
- `GET /api/v1/public/{siteSlug}/search?q=...` — published search.

## Custom content types

- `GET /api/v1/content-types?siteId=...` — list resolved Git/admin definitions.
- `POST /api/v1/content-types` — persist a validated admin definition. Git-managed definitions are not overwritten by admin definitions of the same name.
- `GET|POST /api/v1/content-types/{slug}/records` — list/create records after field validation.
- `GET /api/v1/content-types/{slug}/records/{id}` — retrieve a record with permission scope.

## Media

- `GET /api/v1/media?siteId=...` — list assets (requires `media:manage` in this version).
- `POST /api/v1/media/uploads` — base64 PNG/JPEG/WebP/GIF upload, max 10 MiB decoded. Actual image signatures are verified; SVG and unknown formats are rejected. Files are stored locally or through the configured S3-compatible adapter.
- `GET /media/{assetId}` — public assets only. Private media delivery and signed URL handling are not yet complete; storage metadata flags must not be treated as a full private-delivery security boundary. S3/CDN policies require integration tests.

## AI and MCP

- `GET /api/v1/ai/status` — configured provider/model status without credentials.
- `POST /api/v1/ai/page-draft` — return a validated, unsaved page proposal.
- `POST /api/v1/ai/content-assist` — return a content edit suggestion.
- `POST /api/v1/ai/seo` — return SEO metadata suggestions.
- `POST /api/v1/ai/translate` — return a translation proposal.
- `GET /api/v1/widgets` — list core widget metadata.
- `GET|PUT /api/v1/sites/{siteId}/ai-policy` — site-level provider allowlist, external-content opt-in, data classification, and daily request/input-character budgets. Deployment-wide provider restrictions still apply.
- MCP tools include status, widget listing, document validation, draft generation and preview. MCP has no publication/deletion tool.

## Taxonomy, menus and relationships

- Site-scoped taxonomy term endpoints and allow-listed content/term relationship endpoints create versioned outbox events for the Memgraph projection. Memgraph does not independently authorize requests.
- `GET|POST /api/v1/sites/{siteId}/menus` and `PUT|DELETE /api/v1/sites/{siteId}/menus/{slug}` manage validated navigation menu documents.

## Plugins

- `GET /api/v1/plugins` — list site-scoped plugin records.
- `POST /api/v1/plugins/register` — register a validated manifest as pending. npm archive registration records the SHA-256 but does not execute/build the archive.
- `POST /api/v1/plugins/{id}/approve` — approve a subset of requested capabilities.
- `POST /api/v1/plugins/{id}/activate` — activate only after approval and with a pinned OCI image digest.
- `POST /api/v1/plugins/{id}/disable` — disable execution.
- `POST /api/v1/plugins/{id}/invoke` — invoke through the configured private runner; runner checks pinned image allowlist and resource limits.

## Compatibility policy

- `/api/v1` request/response changes must remain backward compatible or use a new version/migration period.
- JSON schema and runtime validator changes are tested together.
- Endpoint presence does not imply that a production environment has the required database, graph, media or plugin runner configured.


## 0.4.0 libraries, visual platform and commerce routes (historical route group)

The Platform Hub is served at `GET /platform`; its data operations require an authenticated actor. The principal API families are:

| Route family | Operations | Required capability / notes |
|---|---|---|
| `/api/v1/sites/{siteId}/library/items` | list/upload, read/update/version/optimize/download/delete | `library:manage`; uploads validate a MIME signature and category, and writes use `expectedVersion` where applicable |
| `/api/v1/icon-library` | list curated icon catalogue | Authenticated; icons are generated from allow-listed paths, not arbitrary uploaded SVG |
| `/api/v1/math/render` | validate and render TeX or return escaped fallback | Authenticated; optional site context also checks edit capability |
| `/api/v1/sites/{siteId}/content/{contentId}/version` | document/content ID, schema/version and revision information | `content:read` |
| `/api/v1/sites/{siteId}/products` | manage product records | `commerce:read` / `commerce:manage` |
| `/api/v1/public/sites/{siteId}/products` | list published products by bounded pagination, or one by slug | Public read-only fields; published records only |
| `/api/v1/sites/{siteId}/commerce/checkout` | create order snapshots and Stripe Checkout | Authenticated; validates product availability and stock server-side |
| `/api/v1/sites/{siteId}/memberships/plans` | manage plans | `content:read` / `memberships:manage` |
| `/api/v1/public/sites/{siteId}/membership-plans` | list active plans | Public read-only fields; active plans only |
| `/api/v1/sites/{siteId}/memberships/checkout` | hosted one-time/recurring checkout | Authenticated account and active plan required |
| `/api/v1/sites/{siteId}/memberships` | membership administration | `memberships:manage` |
| `/api/v1/sites/{siteId}/community/*` | profile, group, friendship and activity primitives | Site-scoped identity checks and route capabilities apply |
| `/api/v1/sites/{siteId}/mega-menus` | read/write validated menu tree/presentation | `content:read` / `site:manage` |
| `/api/v1/sites/{siteId}/security/firewall-rules` | inspect/create/delete application firewall rules | `security:manage`; rules are not a managed WAF |
| `/api/v1/sites/{siteId}/cloud/connections` | configure/inspect adapter metadata | `cloud:manage`; configuration test is not a real bucket I/O test |

Stripe's webhook endpoint is provider-authenticated by timestamped HMAC verification, not browser session. It records event IDs for duplicate handling. Use the OpenAPI document as the machine-readable API inventory, and note that it is a subset of routes rather than a guarantee that every conditional provider route is available in a deployment.


## 0.5.0 operational additions

The library upload/replacement flow applies the configured malware scan policy before activating an asset. Production requires a configured scanner; the ClamAV adapter is enabled via `LIBRARY_MALWARE_SCANNER=clamdscan`. The `npm run reconcile:library` CLI is an operator tool, not a public API. Cloud connection test routes now issue a provider-specific read-only probe and update health status; they still require provider-specific live integration tests. The feature matrix remains authoritative for which community and commerce data tables have complete API workflows.
