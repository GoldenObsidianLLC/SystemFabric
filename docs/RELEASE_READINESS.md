# Release Readiness and Certification Gates

> **Current status: NOT_PRODUCTION_CERTIFIED.** This page intentionally avoids treating a clean unit-test run as release approval.

## Last known recorded assessment

The latest release-readiness snapshot available during this documentation refresh was generated on 2026-10-28. It reported `Production-ready: NO`, `NOT_PRODUCTION_CERTIFIED`, 7 passing gates, 1 partial gate, and 14 missing-evidence gates. Re-run the repository's release-readiness tooling after current changes to produce a fresh snapshot; the historical counts below are a pointer to work, not a substitute for current evidence. The checklist below groups related requirements for readability, so individual checkboxes do not map one-to-one to the historical gate count.

## Gate groups requiring evidence

### Build and test integrity

- [ ] CI passes for all supported Node.js versions.
- [ ] Fresh database installation and migrations pass from an empty supported database.
- [ ] Supported upgrade path is tested against a snapshot from the previous version.
- [ ] PostgreSQL and Memgraph live integration jobs pass on the reviewed commit.
- [ ] Browser and accessibility acceptance passes for the target browser matrix.

### Identity, tenancy, and external providers

- [ ] Tenant/site isolation review has test evidence and independent review.
- [ ] OIDC/SAML, email delivery, and MFA paths are verified in supported configuration.
- [ ] ClamAV or the selected production malware scanner is integrated and tested.
- [ ] Cloud providers have live connectivity, authorization, failure, and recovery evidence.
- [ ] Stripe checkout, webhooks, idempotency, and reconciliation have isolated live test evidence.
- [ ] Commerce and community parity checks cover cross-layer workflows.

### Isolation and supply chain

- [ ] Plugin container isolation has been validated in the actual supported runtime.
- [ ] Dependency SBOM, provenance, CodeQL, and dependency-analysis evidence are current and retained.
- [ ] Git history and working-tree secret scans have zero unresolved findings for all published refs.

### Operations and approval

- [ ] Representative load and concurrency tests are complete.
- [ ] Backup restoration is demonstrated and operational runbooks reviewed.
- [ ] Independent security review is complete, and critical/high findings are resolved or formally accepted.
- [ ] Operations/release owner has recorded explicit approval.

## Evidence record template

For each gate, record:

| Field | Required value |
|---|---|
| Gate | Named requirement. |
| Commit | Full commit SHA reviewed. |
| Environment | OS/runtime, deployment shape, database/provider versions; exclude secrets. |
| Command or procedure | Exact command or linked runbook. |
| Result | Pass, partial, blocked, or not run. |
| Evidence | Workflow run, artifact, report, or reviewed approval record. |
| Reviewer/date | Person or role and UTC date. |
| Caveats | Known limitations, failed tests, or waivers. |

## Release decision

Do not mark the platform production-ready until all required gates have current evidence, exceptions are documented and approved, rollback/restore paths are validated, and a release owner signs off. Public repository visibility is not production certification.
