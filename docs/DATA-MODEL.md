# SystemFabric Data Model

## Ownership overview

| Entity | Canonical location | Key links | Notes |
|---|---|---|---|
| Site | PostgreSQL `sites` | site memberships, content, assets | Tenant boundary |
| User / role / membership | PostgreSQL | site, role, audit event | Authority for access decisions |
| Content item | PostgreSQL `content_items` | site, revisions, asset refs, relationships | Draft / review / published lifecycle |
| Page document | JSONB `content_items.body` | widget node IDs, content references | Versioned schema; no executable HTML |
| Revision | PostgreSQL `content_revisions` | content ID and version | Immutable snapshot of a content version |
| Custom content type | PostgreSQL `content_type_definitions`; Git files in `/config/cpt` | site, fields | Normalized registry with explicit source/version |
| Canonical relationship | PostgreSQL `content_relationships` | source/target content or taxonomy | Projection source for Memgraph |
| Graph node / edge | Memgraph | shared UUIDs | Derived, rebuildable projection |
| Media | PostgreSQL `media_assets` + object storage | site, storage key, content references | Binary data is not placed in graph nodes |
| Widget manifest | source/config/release artifact | widget type and version | Registry validates before activation |
| Outbox event | PostgreSQL `outbox_events` | aggregate ID/version | Durable cross-store change event |
| AI run audit | PostgreSQL `ai_run_audit` | optional site/actor, provider/model/action | Metadata only by default; no prompt body |
| Audit event | PostgreSQL `audit_events` | optional site/actor/target | Authentication and business operation trail |

## Page document v1 example

```json
{
  "schemaVersion": 1,
  "documentId": "01JEXAMPLEPAGE000000000001",
  "type": "page",
  "title": "Welcome to SystemFabric",
  "children": [
    {
      "id": "hero-section",
      "type": "section",
      "props": { "className": "sf-hero" },
      "children": [
        {
          "id": "hero-title",
          "type": "widget.heading",
          "props": { "text": "Build a better site", "level": 1 },
          "children": []
        },
        {
          "id": "hero-copy",
          "type": "widget.text",
          "props": { "text": "A reusable, structured content experience." },
          "children": []
        },
        {
          "id": "hero-cta",
          "type": "widget.button",
          "props": { "text": "Explore", "url": "/explore" },
          "children": []
        }
      ]
    }
  ]
}
```

AI-generated IDs are rewritten during normalization. Persisted IDs should remain stable through ordinary editing; assign new IDs only to newly inserted nodes and preserve IDs across property edits/moves where the node identity remains the same.

## Core content lifecycle

1. A create/update command checks caller permissions and site scope.
2. The document is validated and normalized.
3. A PostgreSQL transaction writes the content record and new version.
4. The transaction writes a full or delta revision snapshot.
5. The transaction inserts an outbox event for the content/relationship projection.
6. The transaction commits.
7. The API returns the committed draft/published state.
8. The projection worker asynchronously updates Memgraph.
9. The outbox record is marked processed or retried/dead-lettered.
10. Cache invalidation and search index updates are driven by durable events or transactionally updated fields.

## Revision policy

- Each stored content mutation increments the aggregate version.
- Published pages point at an explicit published version or use a publication state plus retained revision; a future release should add a dedicated `published_version` if drafts and published versions need simultaneous operation.
- Edits to a draft must not silently modify the live published document.
- Reverting a revision creates a new revision based on the chosen snapshot; it should not erase history.
- Content migration preserves source revision and records the migration version.

## Search policy

Start with PostgreSQL full-text search over normalized text derived from the document, not expensive unbounded recursive JSON queries in every request. Store/update the `tsvector` during the content transaction or a durable indexing workflow. Use GIN indexing for frequently queried `tsvector` columns. Add external search only if measured language, scale, relevance, or latency requirements justify it.

## JSONB policy

Use JSONB for versioned structured documents and flexible metadata. Use relational columns for high-cardinality filters, uniqueness, foreign keys, statuses, timestamps, and transactionally important values. Index only demonstrated query patterns. Large media payloads remain in object storage; Memgraph carries only identifiers and the minimal properties required for traversals.


## 0.4.0 persistence additions (historical)

- `auth_sessions` stores session token digests, CSRF digests, expiry, revocation and hashed request metadata; raw session tokens are returned only once to the browser.
- `site_invitations` stores a digest of a single-use invitation token, role and expiry. Email delivery is not yet integrated.
- `content_items.published_snapshot` and `published_version` preserve the currently published document while a newer draft is being edited. `published_search_vector` indexes the published snapshot separately from the mutable draft search vector.
- `workflow_events` records content lifecycle transitions and actor references.
- `plugin_installs` records per-site manifest, requested/approved capabilities and immutable OCI image digest. `plugin_invocations` records result category, duration and errors without storing plugin payloads.
- `media_assets` records the site-scoped storage key, MIME type, size, alt text and public/private metadata. Current bytes are on local disk outside webroot; object storage is future work.

The content and graph projection use common application UUIDs. Outbox events are written in the PostgreSQL content transaction; the Memgraph projection is asynchronous and rebuildable. A graph outage must not make stale graph permissions authoritative.


## 0.4.0 model additions (historical)

Migration `0004_governance_taxonomy_release.sql` adds taxonomy soft deletion, `site_ai_policies` and per-site daily AI usage counters. Migration `0005_saml_shared_cache.sql` adds PostgreSQL-backed short-lived SAML request/replay state, consumed atomically to support multiple API replicas. Media storage supports local disk and an S3-compatible object adapter; PostgreSQL retains metadata and the object store owns bytes. Plugin installs store artifact and SBOM digests, provenance metadata, signature result, and a separate two-person security-review state. Those records require integration and security testing in the target deployment.


## 0.4.0 platform library, commerce, membership and community data (historical)

Migration `0006_platform_libraries_commerce_social_billing.sql` adds:

- `library_assets`, `library_asset_versions`, and `media_variants` for a unified site-scoped media/file/document library, checksums, public/private state, version history, and derivatives.
- `commerce_products`, `commerce_orders`, `commerce_order_items`, `commerce_coupons`, and `billing_webhook_events` for product and order snapshots, checkout idempotency, inventory state, coupon schema foundation, and provider event deduplication.
- `membership_plans` and `paid_memberships` for one-time and recurring access plans.
- `social_profiles`, `social_groups`, `social_group_memberships`, `social_friendships`, and `social_activities` for community foundations.
- `firewall_rules`, `cloud_connections`, and `site_security_events` for application-level rule management, cloud configuration metadata, and security audit events.
- `navigation_menus.presentation` for mega-menu layout and responsive display settings.

PostgreSQL remains the authoritative store. Cloud credentials are not intended to be stored in configuration JSON; connection rows refer to deployment-owned secret references. Asset blobs live in local/object storage, and SQL/object writes are not one distributed transaction. The release must include orphan reconciliation and backup/restore evidence before public deployment.

Order totals are stored in integer minor units. Product checkout snapshots price/name/SKU into line items and applies a provider-hosted checkout flow; coupon table existence alone does not mean coupon redemption is implemented. Community tables represent a starting model and do not constitute full BuddyPress-equivalent messaging, notifications, forums, or moderation.


## 0.5.0 persistence additions

Migration `0007_release_hardening.sql` adds malware scan metadata to library assets and schema foundations for social conversations/messages/blocks/reports/notifications, coupon redemptions, inventory reservations, refunds, downloadable-product entitlements, and moderation actions. The presence of a table is not evidence that its complete domain workflow or public API exists. Existing library rows default to `not_scanned`; they must not be treated as malware-clean solely because the migration completed.
