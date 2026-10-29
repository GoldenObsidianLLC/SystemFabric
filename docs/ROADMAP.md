# Roadmap

This roadmap is evidence-oriented rather than a promise of dates. Items should be moved to complete only when linked evidence exists for the target commit and environment.

## Reliability and release process

- [ ] Make CI green across the supported Node.js matrix, live PostgreSQL/Memgraph job, browser smoke tests, and CodeQL upload.
- [ ] Add fresh-database migration and supported upgrade-path evidence.
- [ ] Exercise concurrent writes, outbox retry/recovery, and failure recovery under representative load.
- [ ] Perform backup/restore drills and document RPO/RTO results.
- [ ] Require an explicit release-readiness review and approval record.

## Security and identity

- [ ] Complete an independent security review and track remediation.
- [ ] Review tenant/site isolation across all API routes and background work.
- [ ] Validate OIDC/SAML/email delivery/MFA flows with real test infrastructure where applicable.
- [ ] Verify production malware-scanning integration and quarantine behavior.
- [ ] Validate plugin isolation, immutable images, resource limits, and egress policy in the intended deployment environment.
- [ ] Verify SBOM, provenance, dependency scan, CodeQL, and release artifact retention.

## Provider and product parity

- [ ] Validate cloud storage providers using supported integration accounts and failure-mode tests.
- [ ] Validate Stripe flows with test-mode accounts, idempotency, reconciliation, webhook verification, and ambiguous transport outcomes.
- [ ] Add acceptance evidence for commerce and community workflows that spans application, database, and user-facing behavior.
- [ ] Complete keyboard, screen-reader, contrast, focus, and browser acceptance testing.

## Documentation and developer experience

- [ ] Add real screenshots or short screen recordings only after obtaining current, reviewed assets.
- [ ] Keep feature descriptions and badges aligned with CI evidence.
- [ ] Keep setup commands, environment examples, and module responsibilities synchronized with the source.
- [ ] Track recurring onboarding friction from contributor feedback and simplify the most common paths.

## Completion rule

A roadmap checkbox is not a release gate by itself. Link each completed item to a commit, test report, reviewed artifact, or operational record. The authoritative release gate list is [Release readiness](RELEASE_READINESS.md).
