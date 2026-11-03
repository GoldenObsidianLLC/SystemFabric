# Production Observability Deployment Contract

**Status:** A vendor-neutral evidence contract and fail-closed structural validator are implemented. No collector/backend, retention policy, access model, data residency, or operational owner is selected for a real deployment. This document does not approve production use.

## Purpose and boundary

F1.16 added an opt-in OTLP/HTTP Logs transport. F1.17 defines the deployment evidence required before a production collector/backend may be treated as approved. It does not provision infrastructure, resolve secret references, query external evidence systems, perform a load test, or independently attest to a deployment.

The contract applies to both the OTLP trace and log paths. A deployment may choose any backend or hosting model that meets its own legal, security, service, and data-governance requirements. The manifest deliberately has no default provider, region, retention period, data classification, throughput target, loss tolerance, recovery objective, or owner.

## Required deployment decisions

### 1. Backend and data boundary

Record the selected provider and service, managed or self-hosted deployment model, deployment region, approved data-residency boundary, and the data classification assigned by the data owner. These are deployment decisions, not application defaults.

The backend's terms and configuration must be reviewed for data processing, subprocessors, regional processing, support access, export, deletion, backup and legal hold. Trace identifiers and operational events may remain linkable even when content fields are redacted.

### 2. Transport and identity

The contract requires HTTPS OTLP/HTTP endpoints ending exactly in /v1/traces and /v1/logs, TLS 1.2 or later, explicit receiver authentication, private ingress, restricted ingress sources, and controlled egress. It accepts TLS with workload identity, bearer token or API key authentication, or mTLS with certificate identity. The selected reference must point to a deployment-managed secret, identity or certificate; it must never contain the credential value.

The deployment must name its secret manager, rotation owner, rotation interval and last rotation time. Rotation evidence is checked against the deployment-declared interval. mTLS and its authentication mode must agree. Credential references use typed, non-secret identifiers such as secret:observability/receiver, identity:virgoscorpio_hub/api, or certificate:virgoscorpio_hub/collector-client; bearer/API-key modes require a secret reference, workload identity requires an identity reference, and mTLS requires a certificate reference.

### 3. Access, retention and deletion

The data owner must approve the classification, data-residency statement, retention duration, deletion service level, and legal-hold behavior. The access owner must document the actual authorization model, least-privilege review, access logging, and review cadence. If legal holds are supported, include the approved procedure; if unsupported, record that explicitly.

No retention period or access role is prescribed by VirgoScorpio Hub. The deployment must use its own approved legal, contractual, privacy and records-management rules.

### 4. Delivery reliability and capacity

Document the actual durable queue, encryption-at-rest, restart survival, restore test, capacity and overflow behavior. The validator requires bounded exponential retry with jitter, a dead-letter path, and a redrive procedure.

Record the deployment's expected peak records per second and burst size, then provide a measured sustained rate and burst result at or above those values. The deployment owner sets the accepted loss tolerance; the validator checks the measured loss against that approved tolerance and rejects a total-loss tolerance. Queue capacity must cover the validated burst, and the observed queue utilization must remain below saturation.

A separate outage/recovery exercise must record an outage interval, submitted/recovered/lost record counts, actual recovery time and the approved recovery target. The counts must reconcile, observed loss must remain within the declared tolerance, and recovery must meet the target. Do not substitute a synthetic unit test for production-topology load, queue, restart, or restore evidence.

### 5. Monitoring and ownership

The manifest records distinct service, technical, data and security owners, plus the on-call route. The operational contract includes alerts for exporter failures, queue saturation, dropped records and unauthorized access, with an incident runbook and named alert owner.

The evidence references must resolve in the deployment's controlled evidence system and must point to redacted, access-controlled evidence. The validator checks their syntax, evidence dates and owner-declared validity periods. It does not fetch or authenticate those references; reviewers must verify their contents and independence.

## Complete the manifest

1. Copy docs/templates/observability-deployment.evidence.template.json to artifacts/evidence/observability-production.json.
2. Choose the real backend, transport and deployment model, and obtain the data/security/legal approvals.
3. Fill every decision, owner, security, retention, delivery, capacity and recovery field with deployment-approved values. A field may not be left at its template value.
4. Populate each evidence reference with a resolvable non-secret identifier, UTC execution timestamp and validity period approved by the relevant owner.
5. Set sourceRevision to the exact 40-character Git commit that the deployment will run.
6. Run:

~~~sh
npm run observability:deployment:validate
~~~

Pass an alternate manifest path as the script argument when necessary:

~~~sh
npm run observability:deployment:validate -- path/to/observability-production.json
~~~

The command fails closed for missing or malformed manifests, unapproved decisions, unbounded/untrusted transport, absent owners, stale evidence, insufficient measured capacity, excess data loss, inconsistent recovery counts, or missed recovery objectives. It outputs field paths and reason codes only; it does not print manifest values.

The default evidence file is ignored by Git because it may contain internal provider names, region and evidence references. Store the authoritative record in the deployment's controlled evidence system, keep any local working copy access-controlled, and never include credentials, tokens, passwords, private certificates, customer data or raw logs.

## Release-gate integration

npm run release:readiness includes a dedicated observability-production evidence gate. It requires the manifest to pass structural validation, target the exact current Git revision, and be evaluated from a clean source tree. npm run release:assert-ready remains fail-closed while the manifest is missing or blocked.

A structural pass is not a production certification. The named approvers, external references, backend contract, deployed controls, live topology, queue durability, load-test execution, incident exercise and actual retention/deletion behavior still require independent human verification and the normal operations/security release approvals.

## Validator scope and limitations

The validator is intentionally strict about unknown keys so that secrets or unreviewed data cannot be smuggled into an accepted manifest. Its evidence references are opaque identifiers with a namespace such as artifact:, run:, policy:, change: or ticket:. It does not know or assume the external evidence system behind those identifiers.

A successful result means that the declarations are complete and internally consistent under this schema. It does not prove that a provider exists, a secret reference resolves, a TLS certificate is trusted, an ACL is correctly deployed, a queue is durable, an alert fired, a deletion occurred, or a measured test was honestly performed.

VirgoScorpio Hub remains **NOT_PRODUCTION_CERTIFIED / NO-GO** until all independent security, deployment, operational, backup/restore, legal/governance and release gates are satisfied.
