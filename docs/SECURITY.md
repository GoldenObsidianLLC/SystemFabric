# Security Model and Review Boundaries

This document describes design intent and review areas. It is not a certification or a promise that every control has passed independent security review.

## Secure-by-default principles

- Validate request and stored data before side effects.
- Bound request sizes, quantities, nesting, time budgets, concurrency, and generated output.
- Require explicit configuration for external providers and production-only behaviors.
- Fail closed when a required security control, malware scanner, provider credential, or immutable plugin execution policy is unavailable.
- Scope database operations by the authenticated principal and the correct site/tenant boundary.
- Keep credentials out of source, logs, error messages, fixtures, and public artifacts.
- Avoid returning internal snapshots, secret references, or upstream error details to clients.

These are design goals and tested behaviors in selected code paths; they do not establish complete coverage across the platform.

## Credentials and sensitive data

- Never commit live or test-mode credentials, private keys, webhook secrets, session tokens, `.env`, production data, or unredacted provider responses.
- If a real key is committed, revoke/rotate it first, review use and logs, then address every affected Git ref/history.
- Removing a secret from the current file does not remove it from history, tags, branches, forks, caches, or existing clones.
- Scan the current tree and Git history before publication. Keep original-history backups private.
- Prefer secret managers and platform secret stores for deployment. Examples and tests must use invented fixtures that are clearly not valid keys.

## Important trust boundaries

### Authentication and authorization

Review authentication/session lifecycle, CSRF and same-origin checks, MFA enrollment and replay, OIDC/SAML configuration, authorization enforcement, and tenant/site scoping. Having an auth module or unit test does not prove that every route applies the correct policy.

### File and media pipelines

Validate content by file signature and policy before trusting metadata. Keep uploads quarantined until required scanning succeeds. A missing malware scanner must not silently be treated as a clean verdict in a production path.

### Plugins

Manifest validation, provenance checks, and allow-list enforcement are not equivalent to a hardened production sandbox. Independently test container/VM isolation, resource quotas, filesystem and network policies, image immutability, secrets exposure, and escape paths for the actual deployment platform.

### External providers

Use mocks for deterministic unit coverage. Use isolated test accounts for live verification. Stripe checkout, mail, AI, and cloud adapters require provider-specific failure, retry, timeout, reconciliation, and credential-handling evidence.

### Database and background work

Review transaction boundaries, idempotency, outbox delivery, retry policy, concurrency, least-privilege credentials, migrations, backups, restore drills, and tenant separation.

## Reporting a vulnerability

Please do not publish an exploitable vulnerability, credential, or personal data in a public issue. Use GitHub's private vulnerability reporting/security advisory mechanism for this repository if it is enabled; otherwise contact the maintainers through the official organization profile to arrange private disclosure. Include affected version/commit, impact, prerequisites, and a minimal safe reproduction, but do not include real secrets or customer data.

## Current status

SystemFabric is **not production-certified**. An independent security review, tenant-isolation evidence, plugin isolation evidence, secret-scan results for the release refs, provider/live validation, and operational recovery testing remain necessary release gates. See [Release readiness](RELEASE_READINESS.md).
