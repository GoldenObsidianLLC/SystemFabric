# CodeQL triage — 2026-11-01

**Baseline reviewed:** `1a903b8eab4304dd61b2489381b091d34f1ea546`
**Remediation branch:** `fix/codeql-high-alert-remediation`
**Latest reviewed commit:** `9a004ff38224882d7f9ccf61a9df7a7efec89a84`
**Hosted CI run:** [41338029772](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/41338029772)
**Status:** all five hosted CI jobs completed successfully on the latest reviewed commit. The latest branch scan retains five open alerts: #4–#7 (High) and #14 (Medium). No alert was bulk-dismissed.

The latest scan confirms that the targeted baseline alerts #3, #8–#13 and #15 are no longer open on this branch. This is a static-analysis result, not an independent security assessment or a claim that the entire product is secure.

## Remediation in this change

| Baseline alert | Rule / severity | Action taken | Latest disposition |
|---:|---|---|---|
| 3 | `js/bad-tag-filter` / High | Replaced a test-only regex substring assertion with a literal string check. The assertion was testing escaped output, not attempting to sanitize HTML. | Not open in the latest branch analysis; no dismissal was used. |
| 8 | `js/insufficient-password-hash` / High | Removed SHA-256 use from a constant-time equality helper. It now compares UTF-8 bytes directly with `timingSafeEqual` after a length guard; this helper verifies configured high-entropy bearer secrets and does not store passwords. | Not open in the latest branch analysis; API-token and metrics/bootstrap authentication tests passed. |
| 9–10 | `js/polynomial-redos` / High | Replaced unbounded template-token and short-comment detection regexes with monotonic `indexOf` delimiter scans. Added brace-heavy and long-comment regression coverage. | Not open in the latest branch analysis; hosted EnginEx suite passed 92/92. |
| 11 | `js/file-system-race` / High | Hardened development .env creation and updates using exclusive creation, `O_NOFOLLOW` where Node exposes it, descriptor-bound I/O, regular-file/link checks and owner-only POSIX permissions. | Not open in the latest branch analysis; hosted setup tests passed. Node's Windows fs API does not expose `O_NOFOLLOW`, so symlink traversal at open remains a platform-specific limitation. |
| 12–13 | `js/file-system-race` / High | Template and precompiled-manifest content is read through the same open file descriptor used for size/metadata checks, with a post-read signature check. Added deterministic path-replacement regression tests. | Not open in the latest branch analysis; hosted renderer/manifest suite passed. |
| 15 | `js/insecure-temporary-file` / High | Local media directories/files now use owner-only permissions (`0700`/`0600`) and exclusive file creation. Added permission and no-overwrite regression coverage. | Not open in the latest branch analysis; local and hosted media tests passed. Deployment file ownership and backups still require separate review. |

## Findings retained for human review

### Alerts 4–7 — cookie storage of sensitive data (High)

These alerts point at browser authentication protocol cookies, not password persistence. Session and MFA challenge values are high-entropy opaque bearer tokens that the browser must present; the identity store persists token digests rather than plaintext session tokens. Session/challenge cookies are HttpOnly and receive Secure in secure deployments, with SameSite and path/expiry restrictions. The separate CSRF cookie is intentionally script-readable for the double-submit defense and is not an authentication credential.

Source-level evidence gathered after the latest scan:

- `packages/auth/src/service.js` creates session and CSRF values with `randomBytes(32).toString('base64url')`. The corresponding `auth_sessions` insert persists `digest(token)` and `digest(csrf)`, not the browser-returned values.
- The MFA login path creates a 32-byte random challenge, persists only `digest(challengeToken)`, and sets a five-minute expiry. Challenge verification selects by the digest, requires an unconsumed and unexpired row, limits attempts, and marks the challenge consumed in the successful transaction.
- API session and MFA cookies are HttpOnly. The MFA challenge is also SameSite=Strict, restricted to `/api/v1/auth/mfa`, and limited to 300 seconds.
- Production API startup refuses to start unless `SESSION_COOKIE_SECURE=true`; that setting makes `secureCookies` true, and every session, MFA and CSRF auth cookie receives the Secure attribute.
- `vsh_csrf` is intentionally not HttpOnly so browser code can copy it into the `x-csrf-token` header. It cannot establish authentication by itself: cookie-authenticated writes require a matching same-origin Origin, the cookie/header double-submit match, and validation against the server-side CSRF digest.
- New regression tests verify that session, CSRF and MFA browser values are 256-bit random values, only digests are sent to persistence, the Secure option applies to auth cookies, and the MFA challenge cookie is HttpOnly, SameSite=Strict, path-limited and short-lived. The focused tests currently pass (22/22).

This is stronger evidence for the intended design, not a CodeQL false-positive determination. Bearer session tokens are necessarily available to the browser's cookie store in order to authenticate subsequent requests; protection depends on TLS, HttpOnly/Secure flags, scope/expiry, digest-at-rest, revocation and CSRF checks. A reviewer must still examine the cookie protocol, deployment topology (including TLS termination and proxy trust), browser threat model and token lifecycle. Do not dismiss these alerts solely because they are expected cookies; retain them until the security owner records an explicit, evidence-backed disposition.

### Alert 14 — legacy dynamic code construction (Medium)

The finding concerns the legacy EnginEx compatibility renderer's `new Function` execution of generated template code. The source and public documentation distinguish it from the safe default engine: legacy JavaScript blocks require the explicit `allowUnsafeCode: true` opt-in and templates must be trusted. The safe renderer rejects legacy blocks.

This finding is not being represented as a false positive. Keep the legacy path out of untrusted-template and production-preview claims. A product/maintainer decision is still required on whether to deprecate/remove this compatibility surface or retain it as a documented unsafe opt-in. Do not suppress the alert without that decision and an appropriate security boundary.

## Release-gate disposition

- The code changes above are not an independent security assessment.
- A successful CodeQL workflow run means analysis completed; it does not mean there are no alerts.
- Dependency/SBOM evidence has been refreshed for the latest CI run; the optional inventory variance, LGPL distribution obligations, provenance/attestation and maintainer review remain open.
- The independent tenant-isolation review remains open and must be performed by an independent reviewer.
- VirgoScorpio Hub remains `NOT_PRODUCTION_CERTIFIED`; no production release approval is implied.

No vendor, assessor, contractor, subscription, or paid service was engaged for this work.

## Revalidation on 2026-11-04

**Reviewed repository baseline:** `70335d74fd0ddaeb70eb76aee3a7ad0c5b40ae91` (PR #62 merge).

GitHub Code Scanning was queried on this baseline after PR #62. It still reported five open findings: #30–#33 (High, `js/clear-text-storage-of-sensitive-data`, four auth-cookie writes in `apps/api/src/server.js`) and #14 (Medium, `js/unsafe-code-construction`, the vendored EnginEx legacy renderer). The alerts were open on the exact baseline commit, not dismissed or waived.

The PR #63 / 0.5.3 change moved browser auth route handling into `apps/api/src/auth-routes.js` and the cookie parser/serializer/CSRF comparison into `apps/api/src/auth-cookies.js`. The serializer now rejects unsafe cookie names, non-base64url token values, invalid flags/expiry/SameSite settings, insecure `SameSite=None`, and unsafe paths. Existing session and MFA cookies remain opaque bearer tokens by design; this change does not encrypt or replace them, and it does not establish that the High findings are false positives or resolved.

The Medium EnginEx alert is unchanged. The application does not opt into legacy `<?njs ?>` execution; the safe renderer continues to reject it by default. The explicit legacy compatibility adapter remains unsafe and must not receive user-authored or AI-authored templates.

**Post-merge default-branch CodeQL result:** the required CodeQL workflow passed on the PR #63 head and the post-merge default-branch analysis completed for `dc4a82dafd7abe30da0c9e3b5ec87d9a21c467fd` at 2026-11-04T21:18:28Z. GitHub now reports alerts #30–#33 (`js/clear-text-storage-of-sensitive-data`, High) as `fixed`; each has `fixed_at` set to the analysis time and `dismissed_at` is empty. The open-alert query for `refs/heads/main` now returns only #14 (Medium `js/unsafe-code-construction`, `vendor/enginex/engine-legacy.js:569`). No alert was manually dismissed or suppressed.

The four High alert closures mean CodeQL no longer reports those data-flow findings after the authentication route/cookie extraction. They do not make the browser session token cease to be a bearer credential: session and MFA tokens are still intentionally transported in secure, HttpOnly cookies and only their digests are stored in PostgreSQL. Continue to review TLS termination, trusted proxy configuration, browser/session lifecycle and revocation, same-origin/CSRF controls, and deployment cookie flags. This is not an independent security assessment.

**Disposition:** retain #14 open pending a maintainer/security-owner decision on the unsafe legacy-template compatibility surface. The application does not opt into `<?njs ?>`, and the safe renderer rejects it by default. The legacy path remains unsafe and must not receive user-authored or AI-authored templates. The project remains `NOT_PRODUCTION_CERTIFIED`.
