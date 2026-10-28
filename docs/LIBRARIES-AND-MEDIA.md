# Libraries and Media Operations

## Data model

`library_assets` is the current asset record; `library_asset_versions` stores snapshots and storage references for optimistic history; `media_variants` stores derived assets such as WebP or WebM. The database identifies the owning site and tracks content type, SHA-256, byte count, public/private visibility, status, and metadata. Binary data is stored in local storage or a configured object store.

## Upload restrictions

- Default maximum library asset size is 50 MiB at the library service level; API body limits include base64 overhead and must be configured consistently.
- Uploads validate a file signature plus an explicit category/MIME allow-list.
- SVG, HTML, executable formats, scripts, and unapproved archives are not accepted by the library upload route.
- Download responses use content-disposition, `nosniff`, private/no-store headers, and a restrictive CSP.
- Public assets must be explicitly marked public. Public access must never be used for confidential documents.

## API outline

Authenticated routes use `Authorization: Bearer …` in development or an authenticated cookie/session with CSRF checks for browser write operations:

- `GET /api/v1/sites/{siteId}/library/items?category=image|video|audio|document|file|font`
- `POST /api/v1/sites/{siteId}/library/items`
- `GET /api/v1/sites/{siteId}/library/items/{assetId}`
- `PATCH /api/v1/sites/{siteId}/library/items/{assetId}` (metadata, with `expectedVersion`)
- `PUT /api/v1/sites/{siteId}/library/items/{assetId}` (new bytes/version, with `expectedVersion`)
- `GET /api/v1/sites/{siteId}/library/items/{assetId}/versions`
- `GET /api/v1/sites/{siteId}/library/items/{assetId}/download`
- `POST /api/v1/sites/{siteId}/library/items/{assetId}/optimize`
- `DELETE /api/v1/sites/{siteId}/library/items/{assetId}` (version-aware soft delete)

Upload JSON fields include `category`, `fileName`, `mimeType`, `dataBase64`, `displayName`, `altText`, `caption`, `description`, `isPublic`, and bounded `metadata`. The server derives the digest; callers cannot select a storage path.

## IDs and versions

Asset IDs are stable UUIDs. Versions increment on metadata/content changes; clients must send the latest `expectedVersion` or receive a conflict rather than overwrite a concurrent edit. Page documents also have content IDs, schema versions, record versions, and revision records; do not mix up these independent version spaces.

## Video and optimization

MP4/WebM uploads are accepted as video. Optimization is optional and should run in a worker for large production workloads; the current API path performs the operation synchronously. Configure a maximum optimizer input and execution timeout, and isolate FFmpeg at the deployment boundary. Keep the original, checksum every derivative, and deliver a derivative only after its row/object has been committed.

## Backups and deletion

The SQL row and stored object cannot be atomically committed by a generic filesystem/S3 adapter. Failed uploads compensate by removing the newly written object, but a process crash can still create an orphan object. Schedule an orphan reconciler, object lifecycle rules, and periodic digest/metadata consistency checks before production. Soft-deleted assets require a separate retention/garbage-collection policy; they are not immediately erased from storage.
