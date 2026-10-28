# SystemFabric Security and Threat Model

**Scope:** SystemFabric 0.5.1 hardening candidate / developer preview. This document describes the implemented controls and the remaining security work. It is not a certification or independent audit.

## Assets to protect

- User credentials, session tokens, invitation tokens, API/provider/runner secrets.
- Draft and published content, author information, revisions, tenant configuration and media.
- Authorization and workflow decisions, site membership and plugin approval state.
- AI provider requests/responses and any confidential content included in prompts.
- Plugin runner host, container runtime, database credentials, and outbox/projection events.

## Trust boundaries

1. Browser ↔ API: all input is untrusted; cookie-based writes require CSRF validation and origin checks; authentication and route capability checks run server-side.
2. Tenant ↔ tenant: each content repository, media, plugin and workflow request must carry a verified site context and be scoped by it in SQL.
3. API ↔ PostgreSQL: PostgreSQL is authoritative for identity, roles, content, revisions, published snapshots, workflow events and outbox data.
4. API/outbox ↔ Memgraph: the graph is a rebuildable projection. Graph relationships never independently grant permissions.
5. API ↔ AI provider: external content submission requires explicit opt-in; model output is untrusted and goes through domain validation.
6. API ↔ plugin runner: separate service with private connectivity, shared secret authentication, bounded requests and allowlisted immutable images.
7. Plugin container ↔ host: no network, read-only root, dropped Linux capabilities, non-root user, no-new-privileges, CPU/memory/PID limits, timeout and bounded JSON IO are configured by the runner.

## Implemented controls

### Identity/session
- Passwords are hashed with Node.js `scrypt`, per-password 16-byte salts, a fixed N/r/p configuration, and 64-byte output; plaintext passwords are not persisted.
- Session tokens are random opaque values; only their SHA-256 digest is stored. Sessions expire, are revocable, and are not returned by the `/me` response.
- Browser session cookie is HttpOnly. The CSRF token is supplied by a separate non-HttpOnly cookie and must be mirrored in `x-csrf-token` for unsafe cookie-authenticated calls.
- Origin is checked when supplied. Deployments must set secure cookies and enforce HTTPS.
- Login endpoint and internal login bucket counts are bounded; authorization is capability-based.
- Bootstrap is controlled by a configured secret and closes after an active account exists.
- Site owner removal checks for a remaining active owner.

### Content and rendering
- Page documents and custom field values are validated against allowlisted types and schemas.
- Rendered text/attributes use escaping; style declarations come from a CSS property/value allowlist. Arbitrary HTML, SVG and script execution are not accepted by the standard widget contract.
- Preview iframe is sandboxed. Preview/public render responses use CSP with scripts disabled.
- Body sizes, image size, render output, worker queues, plugin input/output and execution time are bounded.
- Public page delivery reads a published snapshot, not the mutable draft document.
- Expected-version checks prevent silent lost updates.

### SSO, AI governance, and media
- SAML request correlation and replay checks use PostgreSQL-backed shared cache state; cache entries are periodically purged. Optional SP request signing requires a matching RSA private key and X.509 certificate. This path still requires live IdP interoperability and key-rotation tests.
- Site AI policies can constrain allowed providers, external-content processing, data classification, and daily request/input-character budgets. These controls need concurrency and bypass testing against live PostgreSQL.
- S3-compatible media storage is available behind the media adapter; bucket policy, object lifecycle, public/private delivery, and CDN behavior must be tested with the target provider.

### Plugin supply chain and execution
- Plugin manifest fields and capability names are restricted; unknown manifest keys are rejected.
- Third-party activation requires approval and an immutable OCI digest. The runner verifies the digest against an explicit allowlist.
- `.tgz` archive inspection rejects unsafe paths, oversized archives and install lifecycle scripts, but this inspection is not a complete malware analysis and is not a substitute for isolated build/review.
- Do not run untrusted plugin code in the main API process. The runner must be private, independently deployed, and tested against a hostile-plugin suite.

### AI
- Mock AI is the default; external provider content submission requires `AI_ALLOW_EXTERNAL_CONTENT=true`.
- Credentials remain server-side; provider adapters avoid placing keys in URLs and do not include secrets in health output.
- Prompt logging is off by default. Applicable adapters request non-stored interactions where supported, but this is not a guarantee of zero provider-side retention.
- Model output cannot publish content or assign roles. All generated page documents must pass SystemFabric validation.

## Threats and required mitigations

| Threat | Current mitigation | Remaining work |
|---|---|---|
| Credential brute force | Request throttling, strong password policy, scrypt, optional TOTP MFA | Distributed/global rate limiter and operational alerting |
| Session theft | Opaque tokens, HttpOnly cookie, expiry, revocation | Rotate sessions after privilege changes, device/session management, reauthentication for critical operations |
| CSRF | CSRF cookie/header and Origin check for cookie writes | Enforce Origin on all same-site mutations in production and test proxy edge cases |
| Cross-tenant data access | Site-scoped data access and capability checks on API paths | Exhaustive route-by-route tenant isolation testing / independent review |
| Stale graph authorization | Graph projections do not grant access | Rebuild/reconciliation and outage tests |
| SQL injection | Parameterized application queries; allowlisted interpolated graph relationship types | SQL fuzz/property tests, least-privileged DB role and review every query |
| XSS/unsafe HTML | Escaped rendering, restricted styles, script-disabled CSP | Browser-level tests, HTML fuzzing, review every new widget/renderer helper |
| Malicious archive | Safe path checks, metadata validation, Ed25519 provenance tooling and signed artifact/SBOM digest fields | Complete quarantine build pipeline, registry/image attestation, malware/vulnerability scanning and adversarial testing |
| Malicious plugin | Isolated OCI runtime controls and allowlist | Host-level sandbox validation, gVisor/Kata assessment, per-capability enforcement and independent audit |
| Resource exhaustion | Request/render/media/plugin bounds; queue backpressure | Load/soak tests, per-tenant quotas and distributed rate limiting |
| AI prompt injection | Allowlisted task and tool design; model output validation | Adversarial prompt-injection evaluation; tenant/model/provider policies |
| AI data disclosure | External processing opt-in, site provider policy, classification field, request/input-character budgets and selected audit events | Verify enforcement for every data path, provider contracts/regions/retention, cost accounting and policy/audit UI |
| Secret leakage | `.env.example` uses placeholders; status avoids keys | Secret scanner, rotation procedures, production secret manager and repository scan |

## Production gate

Do not launch publicly until supported-runtime validation and lockfile creation, production migration tests, exhaustive site-scope authorization tests, database least privilege, secure cookie/TLS review, invitation/reset delivery, plugin runtime tests, backup/restore, fuzzing, penetration testing, load/soak testing and an independent security review are complete. A passing unit suite is not a substitute for these gates.


## 0.5.0 release-hardening additions (historical)

The library upload path now supports a ClamAV `clamdscan` adapter. In production, uploads fail closed if a scanner is not configured; a detection or scanner failure prevents activation. In non-production without scanning, newly stored assets are quarantined and non-public. Migration `0007_release_hardening.sql` marks legacy assets `not_scanned`; it does not retroactively establish that they are clean. A deployment must scan and reconcile existing assets under a documented migration plan before public release.

A local-library orphan reconciler is available with dry-run behavior by default. Review the candidate list and retain backups before using `--apply`. It does not reconcile remote object storage. Cloud connection testing uses read-only live probes when the relevant provider SDK and credentials are available; provider-specific permissions and identity flows still require live tests.

These changes improve the security foundation but are not a substitute for a malware corpus test, adversarial upload testing, cloud IAM review, container sandbox testing, or an independent penetration assessment.


## Cloud credential-reference boundary

Cloud connection configuration accepts only a small allow-list of non-secret fields; arbitrary `accessKey`, `secret`, `connectionString`, or token fields are rejected. Endpoint values reject URL user-info, query and fragment components, and production endpoints must use HTTPS. The connection-test route fails closed for secret-reference types that this runtime cannot resolve and does not return raw provider SDK errors. These checks do not replace egress network policy: administrators who can configure endpoints still require a tightly controlled capability, and private-service allow-lists plus real SSRF testing are release gates.
