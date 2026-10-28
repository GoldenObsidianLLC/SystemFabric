# SystemFabric Platform Features — 0.5.0

SystemFabric 0.4.0 originally expanded the developer preview with a media/document library, visual page widgets, commerce and membership foundations, community primitives, mega-menu presentation, firewall rule management, and cloud storage adapter configuration.

> **Maturity notice:** This is a developer preview, not a completed WordPress/WooCommerce/BuddyPress/Elementor replacement and not a production-certified security platform. A database-backed route is only functional after migrations are applied to a compatible PostgreSQL instance. Provider and cloud integration status is documented separately from configuration acceptance.

## Libraries and media

The unified library supports image, video, audio, document, generic file, and font asset kinds. Each asset has a UUID, owning site, display metadata, byte count, SHA-256 digest, status, version, and visibility flag. Uploads check the file signature instead of trusting the caller's MIME label. SVG is intentionally not accepted as an uploaded image; use the curated icon library for inline SVG.

Document and file uploads currently allow selected formats such as PDF, plain text, JSON, Office Open XML document types, ZIP, and WOFF fonts. The allow-list is deliberately narrow and should be expanded only alongside archive/content scanning and download policy.

Asset history and optimistic version checks are available. Replacement requires `expectedVersion` and keeps the same library category. Deletion is soft-delete/versioned. The API can return private assets only to a caller with the library management capability; public reads require an asset marked public. SHA-256 is checked when reading stored bytes.

Optional image optimization uses Sharp to produce WebP variants. Optional MP4-to-WebM transcode uses FFmpeg without shell invocation, with an input byte ceiling and execution timeout. Optimization creates a derivative and does not overwrite the original. The installed optimizer can decline a conversion if it cannot reduce bytes. Neither optional dependency is guaranteed to be present until the dependency installation has been reproduced and reviewed.

## File, document, and icon libraries

- **File Library:** general approved file types with metadata and version history.
- **Document Library:** approved document types, MIME signature checks, private downloads, metadata, and version history.
- **Icon Library:** curated programmatic SVG icons, with validated options and escaped accessible titles. It is not an untrusted SVG upload/import system.
- **Video in Media Library:** MP4/WebM upload and a `widget.video` page node referencing a library asset. A media transcoding adapter can optionally produce a WebM variant when FFmpeg is installed.
- **Document ID/version controls:** content items expose document/content IDs, schema version, record version, publication timestamp, revision counts, and optimistic concurrency. Library assets have independent version histories; an asset version is not the same as a page-document version.

## Math formula rendering

`POST /api/v1/math/render` accepts a bounded formula and optional display mode. The formula validator rejects dangerous command families and unbalanced braces. With KaTeX installed, rendering uses `trust: false`, strict parsing, expansion/size limits, and HTML+MathML output. Without KaTeX, the runtime emits escaped text rather than pretending to provide typeset mathematics. The TeX checker is a defensive pre-filter, not a complete formal proof that every possible TeX expression is harmless; never enable unrestricted macros or trusted HTML.

## Commerce and memberships

The preview adds product and order data models, bounded cart validation, minor-unit integer arithmetic, stock reservation in the order transaction, idempotency keys, Stripe Checkout sessions, signed/timestamped webhook validation, membership plans, recurring checkout modes, webhook-driven membership updates, and a public published-product/active-plan catalog API.

Public read endpoints:

- `GET /api/v1/public/sites/{siteId}/products`
- `GET /api/v1/public/sites/{siteId}/products/{slug}`
- `GET /api/v1/public/sites/{siteId}/membership-plans`

Authenticated management endpoints are defined in `docs/API-CONTRACTS.md` and `openapi.yaml`.

This is **commerce functionality groundwork, not WooCommerce parity**. The current milestone does not provide the complete tax, shipping, regional pricing, coupon redemption, full variable-product/attribute matrix, refunds/returns, invoices, downloadable entitlements, subscription lifecycle console, fraud tooling, checkout extensibility, or accounting integrations expected from a mature store. Coupons have a storage schema but a full coupon lifecycle must be added and tested before claiming coupon support.

## Community

The preview defines site-scoped profiles, privacy visibility, groups with privacy states, group memberships, friend requests, and an activity feed model. It is not BuddyPress parity: private messaging, notifications, moderation queue, forums, advanced group content, search/discovery, anti-abuse workflows, data export/deletion, and the complete community UX remain future work.

## Mega menus

Navigation menus support a presentation configuration including layout, width, columns, mobile behavior, hover/click/focus trigger, image/icon/description toggles, and a featured content reference. Menu items pass the existing navigation validator. Client-side rendering and keyboard/accessibility testing are release gates. This is not a full Elementor or WordPress theme builder.

## Firewall and security

The application firewall can evaluate explicit IP, IPv4 CIDR, path-prefix, and user-agent rules, returning pass/deny/challenge/rate-limit decisions. Rule changes require a privileged capability and emit audit events. Deployment CIDR deny rules can be configured by environment.

This is an **application-layer rule engine**, not a network firewall, managed WAF, bot-management system, DDoS service, geolocation engine, or substitute for a reverse proxy and cloud edge protection. Ensure proxy trust is explicitly configured if the network topology requires it; do not trust arbitrary `X-Forwarded-For` values.

## Cloud compatibility

Object storage adapters cover AWS S3 and S3-compatible endpoints (including deployments such as Cloudflare R2 or MinIO), Google Cloud Storage, and Azure Blob Storage. Configuration records store secret references, not secret values. Actual credentials come from the deployment environment or a supported secret/workload-identity mechanism.

A cloud connection marked `configured` means its configuration passed validation. It does not mean that object-store permissions, bucket policy, network access, encryption, retention, lifecycle rules, or CDN delivery have been verified. Live compatibility tests are required for every provider/credential model in use.

## AI integration

AI can draft page documents, provide constrained content assistance, suggest SEO metadata, translate text, and help with preview/review workflows. AI output remains untrusted and is validated by SystemFabric. Publication, billing, permissions, and plugin activation are not granted to AI tools by default. External provider use is disabled unless the operator opts in and configures the appropriate policy.


## 0.5.0 release hardening

The current release adds optional ClamAV malware scanning and quarantine policy for library upload/replacement, a local-only object reconciler that defaults to dry-run, read-only live connectivity probes for S3/GCS/Azure storage adapters, expanded integration tests for outbox concurrency/poison events and Memgraph version ordering, and CI definitions for a supported-Node matrix, database integration services, Playwright checks and CodeQL. CI definitions have not been executed in this build environment and do not constitute passing evidence.
