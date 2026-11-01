# CodeQL triage — 2026-11-01

**Baseline reviewed:** `1a903b8eab4304dd61b2489381b091d34f1ea546`
**Remediation branch:** `fix/codeql-high-alert-remediation`
**Status:** engineering changes and tests prepared; the branch's hosted CodeQL result is required before alert closure is claimed.

This record distinguishes code changes from alert disposition. It does not claim that CodeQL alerts are closed until a fresh analysis of the resulting commit confirms that outcome.

## Remediation in this change

| Baseline alert | Rule / severity | Action taken | Required confirmation |
|---:|---|---|---|
| 3 | `js/bad-tag-filter` / High | Replaced a test-only regex substring assertion with a literal string check. The assertion was testing escaped output, not attempting to sanitize HTML. | Confirm alert disappears in new analysis. |
| 8 | `js/insufficient-password-hash` / High | Removed SHA-256 use from a constant-time equality helper. It now compares UTF-8 bytes directly with `timingSafeEqual` after a length guard; this helper verifies configured high-entropy bearer secrets and does not store passwords. | Confirm alert disappears; preserve API-token and metrics/bootstrap authentication tests. |
| 9–10 | `js/polynomial-redos` / High | Replaced unbounded template-token and short-comment detection regexes with monotonic `indexOf` delimiter scans. Added brace-heavy and long-comment regression coverage. | Confirm alerts disappear and vendor EnginEx suite passes. |
| 11 | `js/file-system-race` / High | Removed the existence-check-then-copy sequence in development setup. Uses exclusive creation, rejects non-regular or multiply-linked `.env` files, opens once, verifies the opened file identity, and reads/writes through that descriptor. Added path-swap regression test. | Confirm alert disappears on the branch scan and setup tests pass on supported hosts. |
| 12–13 | `js/file-system-race` / High | Template and precompiled-manifest content is read through the same open file descriptor used for size/metadata checks, with a post-read signature check. Added deterministic path-replacement tests on platforms that permit renaming an open file. | Confirm alerts disappear and renderer/manifest tests pass. |
| 15 | `js/insecure-temporary-file` / High | Local media directories/files now use owner-only permissions (`0700`/`0600`) and exclusive file creation. Added a permission and no-overwrite test; test media is rooted in an isolated project test directory rather than an OS temporary directory. | Confirm alert disappears on the branch scan; verify deployment file ownership and backup process separately. |

## Findings retained for human review

### Alerts 4–7 — cookie storage of sensitive data (High)

These alerts point at browser authentication protocol cookies, not password persistence. The session and MFA challenge values are high-entropy opaque bearer tokens that the browser must present; the identity store persists token digests rather than plaintext session tokens. Session/challenge cookies are HttpOnly and receive Secure in secure deployments, with SameSite and path/expiry restrictions. The separate CSRF cookie is intentionally script-readable for the double-submit defense and is not an authentication credential.

This is an intentional protocol boundary, not proof that the risk is zero. A reviewer must verify token entropy, TLS/secure-cookie deployment, cookie scope, expiry, session revocation and CSRF checks. Do not dismiss these alerts solely because they are expected cookies; retain them until the security owner records an explicit, evidence-backed disposition.

### Alert 14 — legacy dynamic code construction (Medium)

The finding concerns the legacy EnginEx compatibility renderer's `new Function` execution of generated template code. The source and public documentation explicitly distinguish it from the safe default engine: legacy JavaScript blocks require the explicit `allowUnsafeCode: true` opt-in and templates must be trusted. The safe renderer rejects legacy blocks.

This finding is not being represented as a false positive. Keep the legacy path out of untrusted-template and production-preview claims. A product/maintainer decision is still required on whether to deprecate/remove this compatibility surface or retain it as a documented unsafe opt-in. Do not suppress the alert without that decision and an appropriate security boundary.

## Release-gate disposition

- The code changes above are not an independent security assessment.
- A successful CodeQL workflow run means analysis completed; it does not mean there are no alerts.
- The dependency/SBOM/provenance gate remains open until both runtime SBOMs and their retained generation logs are reconciled, license notices are reviewed, and a maintainer signs the dependency tree.
- The independent tenant-isolation review remains open and must be performed by an independent reviewer.
- SystemFabric remains `NOT_PRODUCTION_CERTIFIED`; no production release approval is implied.

No vendor, assessor, contractor, subscription, or paid service was engaged for this work.
