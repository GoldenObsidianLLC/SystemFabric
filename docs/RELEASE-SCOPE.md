# SystemFabric 0.5.1 — Recommended Release Scope

> **Status: Recommended scope baseline; named release-owner sign-off is pending.**
>
> **Release classification: EXPANDED_DEVELOPER_PREVIEW_NOT_PRODUCTION_CERTIFIED.**
>
> This document narrows what SystemFabric 0.5.1 may claim and what the next certification work should cover. It does not approve a production release, prove the provider integrations, or waive the production gates. The scope is based on the committed `RELEASE-MANIFEST.json`, `.env.example`, CI workflow, and Playwright configuration at the baseline commit recorded below.

## 1. Decision summary

Recommend keeping 0.5.1 as an isolated, self-hosted developer preview. Do not certify or market it as a production-ready multi-tenant platform, a parity replacement for WooCommerce/BuddyPress/Elementor, or a provider-certified hosted service.

The implementation contains adapters and feature foundations beyond the configured/validated baseline. Code presence is not a supported-provider commitment. For this preview, keep optional external integrations disabled, avoid real customer data and live payment collection, and describe unfinished capabilities as previews or deferred features.

| Area | 0.5.1 recommended scope | Explicit exclusions / limitations |
|---|---|---|
| Release intent | Expanded developer preview for evaluation and isolated non-production testing. | No production deployment recommendation, SLA, production certification, or general-purpose hosted-service claim. |
| Runtime / OS | Node.js `>=22.23.4`; CI validates Node 22.23.4 and 24.22.1 on Ubuntu 24.04. | Node 26.12.1 was exercised locally on Windows x64; do not infer a formal Windows production support matrix from that local result. Other OS/runtime combinations are not certified by the current CI matrix. |
| Durable data | PostgreSQL is the system of record. The current hosted integration workflow validates PostgreSQL 18 (Alpine) with fresh migrations and live integration tests. | No managed database vendor, HA topology, failover SLA, or production RPO/RTO claim is certified. |
| Graph projection | Memgraph 3.13.1 is the optional relationship projection used by the integration job; PostgreSQL remains authoritative. | Memgraph is not the source of truth. No managed graph service or production high-availability claim. |
| Realtime transport | Redis 7.4 is exercised in CI for integration coverage. Realtime remains opt-in and disabled in the sample configuration. | Do not enable multi-node realtime in production or claim production-scale fan-out/HA until the realtime/tenant and load gates are accepted. |
| Identity | Built-in local account/password and session flows for isolated preview evaluation. | No certified OIDC or SAML provider, federation interoperability commitment, enterprise SSO, verified-email workflow, or production account-recovery guarantee. |
| Email | Mail provider remains `disabled` by default. | Resend and SendGrid adapters are not certified; do not promise delivery, verification, password recovery or notification email. |
| MFA | The code includes TOTP/MFA foundations; treat them as preview functionality only pending recovery/replay/session testing. | No production MFA recovery assurance or enterprise MFA certification. |
| Asset storage | Local filesystem storage only, scoped to the isolated preview deployment. | AWS S3/S3-compatible (including R2/MinIO patterns), GCS and Azure Blob are adapter options, not certified providers for 0.5.1. CDN/public bucket behavior is not certified. |
| Malware scanning | Development preview only. Where ClamAV is not configured, uploads may remain `not_scanned`/quarantined. | Do not use 0.5.1 to accept untrusted uploads in production. The required ClamAV live corpus, timeout/unavailable and legacy-asset rescan gate remains open. Production upload policy must remain fail-closed. |
| Payments / commerce | Product/order/cart foundations may be evaluated with test data. Stripe work, if exercised, must use test mode only. | No live payment collection or production commerce claim. Full refunds, coupon redemption, download entitlements and subscription lifecycle/parity are not included in the supported 0.5.1 claim. |
| Community | Site-scoped profiles, groups/membership, friend/activity and messaging foundations may be evaluated as preview features. | No BuddyPress parity claim. Group privacy/conversations, forums, full abuse controls, search and privacy export/deletion remain incomplete. |
| Plugin execution | Plugin execution remains disabled by default. The Docker runner is an integration foundation only. | No production plugin execution, third-party plugin marketplace, or adversarial isolation certification. |
| AI | Mock provider only by default; external content sharing stays opt-in and disabled in the sample configuration. | No external OpenAI, OpenAI-compatible, Anthropic or Gemini provider is certified by this scope. Do not send customer/confidential content to external providers under the 0.5.1 preview claim. |
| Browser | Chromium/Chrome desktop smoke coverage, as configured in Playwright. | No full WCAG conformance claim and no Firefox, Safari/WebKit, mobile-browser or screen-reader certification. |
| Security / tenancy | Existing automated tests and CI are engineering evidence only. | No independent tenant-isolation review, penetration test, or independent security certification has been completed. |
| Operations | Local/non-production developer operation only. | No production deployment/rollback certification, backup restore assurance, incident response or operational sign-off. |

## 2. Required safe configuration posture

For a deployment describing itself as the 0.5.1 developer preview, use the following policy:

- Keep `NODE_ENV=development` or another explicitly isolated non-production environment. Do not represent the sample environment as a production template.
- Keep `SYSTEMFABRIC_REALTIME_ENABLED=false`, `MEMGRAPH_ENABLED=false` unless a developer deliberately enables the local test topology, and do not expose internal service ports publicly.
- Keep `AI_PROVIDER=mock`, `AI_ALLOWED_PROVIDERS=mock`, `AI_ALLOW_EXTERNAL_CONTENT=false`, and `AI_LOG_PROMPTS=false`.
- Keep `SYSTEMFABRIC_MAIL_PROVIDER=disabled`, `SAML_ENABLED=false`, and OIDC credentials unset unless conducting isolated integration testing.
- Keep `MEDIA_DRIVER=local` and `LIBRARY_STORAGE_PROVIDER=local`; do not configure remote storage providers as supported production services under this release claim.
- Keep `SYSTEMFABRIC_PLUGIN_EXECUTION_ENABLED=false`, with no external plugin runner exposed.
- Do not configure Stripe live credentials. Any checkout/webhook testing must use a dedicated test-mode account and isolated test data.
- Do not accept untrusted uploads unless a real scanner is configured and the relevant scanner acceptance procedure has passed. Production upload policy must fail closed when ClamAV is absent or unavailable.
- Set real, unique secrets in any isolated environment; never reuse the example bootstrap credentials/API tokens. Use HTTPS and secure cookies if exposing the preview beyond loopback.
- Do not put real customer data, production secrets, personal data or confidential material into this preview environment.

These are operating restrictions for the preview claim. They do not replace code-level feature flags, access controls, infrastructure isolation, or the independent security review. Where a capability cannot be reliably disabled for a deployment, do not expose that deployment as a supported 0.5.1 preview environment until it is disabled or isolated.

## 3. Production certification is a separate scope decision

The above is a deliberately narrow preview scope, not the target production service definition. Before a production certification candidate can be declared, the release owner must make and record explicit provider/product decisions, at minimum:

1. The exact OIDC/SAML identity provider(s), email delivery provider, account verification and MFA recovery policy.
2. The malware scanner deployment/version and the operational process for quarantine, false-positive review and legacy rescanning.
3. The exact object-storage provider(s) and credential mechanism to be supported (do not claim all S3/GCS/Azure adapters merely because they exist).
4. Whether Stripe payment collection is in scope, and the complete order/refund/subscription behavior that will be supported.
5. Whether plugins may execute in the certified service, and the supported runtime/platform plus signing, provenance and isolation controls.
6. The supported browser/assistive-technology matrix and accessibility conformance target.
7. The specific commerce/community functionality that will be delivered and tested end-to-end; remove parity claims for capabilities that remain incomplete.
8. Single-tenant versus multi-tenant deployment topology, supported OS/runtime/database versions, availability goals, backup/restore expectations and operational owner.

Every selected production provider must be tested against a dedicated non-production account using the evidence acceptance rules in [PRODUCTION-CERTIFICATION-PLAN.md](PRODUCTION-CERTIFICATION-PLAN.md). An unselected provider must be excluded from release claims and disabled or unavailable in the production configuration. The production evidence gates remain open until reviewed evidence exists for the exact candidate commit.

## 4. Baseline and decision ownership

| Field | Value |
|---|---|
| Repository | `GoldenObsidianLLC/SystemFabric` |
| Version | `0.5.1` |
| Source baseline | `af21b728bb906bb37b561bb5a381deb0a19da007` |
| Manifest state | `EXPANDED_DEVELOPER_PREVIEW_NOT_PRODUCTION_CERTIFIED` |
| Decision status | Recommended technical scope; awaiting named release-owner approval |
| Decision owner | Product/release owner (name and approval date to be recorded) |
| Next required approval | Review this matrix and record accept/change decision on GitHub issue #13 |

The CI workflow and sample configuration establish the evidence boundaries for this proposal: the workflow currently tests Node 22.23.4/24.22.1 on Ubuntu 24.04, PostgreSQL 18, Memgraph 3.13.1, Redis 7.4 and Chromium smoke coverage. The sample environment defaults to local storage, mock AI, disabled mail, disabled SAML, disabled realtime and disabled plugin execution. The release manifest explicitly says provider validation, ClamAV, Stripe integration, plugin runtime tests, load/restore and independent security assessment remain incomplete.

## 5. Release decision

This scope does **not** change the current release status:

**SystemFabric 0.5.1 remains an expanded developer preview and is NOT_PRODUCTION_CERTIFIED / NO-GO.**

The named release owner must approve or amend this scope before it is treated as an official product decision. Independent tenant/site review (#14) remains the first independent security workstream; this scope proposal does not close or reduce that gate.
