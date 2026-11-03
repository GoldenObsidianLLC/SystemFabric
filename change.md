# Change Record — VirgoScorpio Hub identity migration

**Date:** 2026-11-03
**Scope:** Repository-wide, intentionally breaking identity migration.

## What changed

The project has adopted **VirgoScorpio Hub** as its canonical name. The former project identity was retired because unrelated businesses already use that name, creating avoidable confusion in repository discovery, product attribution, documentation, and technical integrations.

The change is intentionally comprehensive rather than alias-based:

- Repository slug, clone URLs, workflow badges, documentation links, workspace labels, and project-facing copy use **VirgoScorpio Hub**.
- Files whose names contained the former project identity have been renamed to the VIRGOSCORPIO-HUB-* convention.
- The npm package identity is now virgoscorpio-hub.
- Project-owned environment variables use the VIRGOSCORPIO_HUB_ prefix.
- Project-owned API error identifiers, request headers, runtime properties, telemetry/service labels, metric names, Redis key/channel prefixes, local resource names, and SBOM artifact names use the new identity.
- Browser session, CSRF, and MFA cookie names now use the vsh_ prefix; all existing browser sessions must be invalidated and users must sign in again.
- Provider idempotency keys now use the vsh_ prefix. Drain or reconcile every pending checkout, refund, and membership-provider operation before cutover; do not replay an unresolved old provider operation with a newly generated key.
- Legacy short-form project prefixes in client storage, CSS, and runtime keys have been replaced with VSH-based prefixes; the development-container marker is VIRGOSCORPIO_HUB_DEVCONTAINER.
- The old short-form product monogram has been replaced with VSH.
- No compatibility aliases for the retired identifiers are provided.

## Breaking and compatibility impact

This is a coordinated breaking change. Consumers must update their configuration and integrations before using this version:

1. Replace every former project-prefixed environment variable with its VIRGOSCORPIO_HUB_ equivalent. Unknown legacy variables are not read.
2. Update clients that inspect project-owned error codes or send the site-selection request header. The new header is x-virgoscorpio-hub-site-id; project error codes use the ERR_VIRGOSCORPIO_HUB_ prefix.
3. Update integrations that depend on the previous runtime property, Redis key/channel prefixes, Prometheus metric names, OpenTelemetry service labels, or generated artifact filenames.
4. Update Docker Compose/dev-container resources, database role/database names, S3 bucket names, local hostnames, scripts, and CI/CD secrets/configuration to the new values.
5. Update clone URLs and any pinned repository links to https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub.

## Database and deployment boundary

The migration is not an in-place upgrade path for databases created under the previous identity. Migration SQL and the migration ledger identity have changed, so an existing database must not be pointed at this version and allowed to replay the renamed migration set.

Before adopting this version:

- Take and independently verify backups of any data that must be retained.
- Provision a new, empty database and new project-owned storage resources using the new identifiers.
- Apply the complete migration set to that empty database.
- Move required application data only through a separately reviewed, tested data-transfer procedure.
- Reconfigure deployment secrets, CI variables, Redis namespaces, object-storage buckets, observability dashboards/alerts, and external API clients.
- Validate the new environment before directing any traffic to it.

There is deliberately no fallback lookup, alias, schema-specific legacy detection, or silent dual-read/dual-write behavior. Before applying migrations, the runner performs a generic public-schema emptiness check and refuses to initialize a non-empty database when the new migration ledger has no entries. This prevents an accidental replay of the new migration set against an existing database without embedding legacy identifiers in the new code.

## Verification requirements

The rename is not considered complete until all of the following pass:

- Repository-wide case-insensitive search finds no retired project-name strings, former file-name fragments, or old product monogram references in tracked text files.
- All renamed files and documentation links resolve.
- Package manifest, lockfile, SBOM package URL, release manifest, and evidence validators agree on virgoscorpio-hub.
- JavaScript syntax, unit/security tests, artifact checks, live database integration, browser/accessibility tests, and hosted CI pass.
- A clean database can apply every migration in order, and a second migration run is idempotent.
- Dev-container and Compose configurations resolve and use valid DNS, HTTP-header, package, database, and object-storage identifiers.

**Release status is unchanged:** this identity migration does not confer production certification or close any outstanding governance, tenant-isolation, security, or release-approval gate.
