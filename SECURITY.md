# Security Policy

## Supported baseline

Security work is performed against the current maintained branch. Before reporting a finding, identify the affected commit or version and whether the issue reproduces against the current `main` branch.

## Reporting a vulnerability

**Please do not open a public issue for an unpatched exploitable vulnerability or publish credentials.** Use GitHub's private vulnerability reporting/security advisory flow for this repository if it is enabled. If it is not enabled, contact the maintainers through the official Golden Obsidian LLC organization profile to arrange private disclosure.

Please include:

- A concise impact statement and affected component/version.
- Preconditions and a minimal reproduction that avoids real user data.
- Any relevant sanitized logs or test case.
- Suggested mitigation if known.

Do not include live keys, personal data, production dumps, session cookies, or other sensitive information.

## Secret-handling expectations

If a credential is exposed, revoke or rotate it first, then assess logs, usage, and affected Git history. Removing a value from the latest file is not sufficient. Keep history-cleanup backups private and rerun both working-tree and Git-history secret scans before publication.

See [the detailed security notes](docs/SECURITY.md) and [release-readiness gates](docs/RELEASE_READINESS.md). This policy does not imply that the software has been independently audited or certified for production.
