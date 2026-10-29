# Pre-Publication Checklist

Use this checklist against the exact commit intended to become public. A checked item should have a reproducible result or review record, not just an assumption.

## Source and history

- [ ] `git status --short` is clean except for the intended, reviewed changes.
- [ ] `git diff --check` passes for staged changes.
- [ ] `gitleaks dir --redact --verbose .` reports zero unresolved findings.
- [ ] `gitleaks git --redact --verbose --log-opts="--all"` reports zero unresolved findings on all refs intended for publication.
- [ ] No real keys, private certificates, `.env` files, production dumps, personal data, or sensitive provider payloads are in source or Git history.
- [ ] A verified history backup exists outside the repository and remains private.
- [ ] GitHub's `main` SHA matches the reviewed local commit after the push.
- [ ] Tags, branches, release assets, workflow artifacts, and historical logs have been reviewed for sensitive content where applicable.

## Documentation and legal

- [ ] README links, badges, commands, and architecture diagram are correct.
- [ ] `LICENSE`, `COPYRIGHT`, `NOTICE.md`, `TRADEMARKS.md`, and third-party notices reflect the actual rights and licensing.
- [ ] GPL license scope and company/personal copyright ownership have been confirmed by the rights holder or counsel as appropriate.
- [ ] No placeholder demos, screenshots, contacts, coverage badges, or claims remain.
- [ ] Contributor, issue, PR, and security-reporting instructions work.

## Engineering validation

- [ ] `npm ci` succeeds from a clean checkout.
- [ ] `npm run check` passes.
- [ ] `npm --prefix vendor/enginex test` passes.
- [ ] `npm run test:e2e -- --workers=1` passes.
- [ ] `npm run test:integration:live` passes with isolated PostgreSQL and Memgraph test services.
- [ ] `npm audit` and `npm audit --omit=dev` results have been reviewed.
- [ ] GitHub Actions succeeds for every supported Node.js matrix, database integration, browser, and CodeQL job.
- [ ] CodeQL upload works where the workflow is configured to upload results.

## Production readiness is separate

- [ ] Fresh-install and upgrade migrations are verified.
- [ ] Tenant/site isolation, identity-provider flows, email, MFA, provider APIs, plugin isolation, and malware scanning have reviewable evidence.
- [ ] Load, backup/restore, observability, incident handling, and rollback are rehearsed.
- [ ] Independent security review and release approval are recorded.
- [ ] All required release gates are updated in `docs/RELEASE_READINESS.md`.

## Decision

- [ ] **Publish source** only after source/history, legal, and repository checks pass.
- [ ] **Claim production readiness** only after all required runtime/operational gates have been met and approved.

These are separate decisions. Public source code is not a claim of production certification.
