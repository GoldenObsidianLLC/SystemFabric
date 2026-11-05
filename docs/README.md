# VirgoScorpio Hub Documentation

## Current status and repository assurance

- [VirgoScorpio Hub 0.5.1 project status report — 1 November 2026](reports/2026-11-01-VirgoScorpio-Hub-0.5.1-Project-Status-Report.md) — full engineering, security, release-readiness, governance and funding snapshot. Historical candidate evidence; not production approval.
- [Repository coherence and continuity review — 1 November 2026](REPOSITORY-COHERENCE-AND-CONTINUITY-REVIEW-2026-11-01.md) — repository inventory, documentation drift, CI/readiness gaps, branch reconciliation, safe corrections and backlog.
- [Local Docker resource migration report — 5 November 2026](reports/2026-11-05-LOCAL-DOCKER-RESOURCE-MIGRATION.md) — checksummed cold backups and isolated Compose restore progress; PostgreSQL role/database migration and application validation remain pending.

The project remains **NOT_PRODUCTION_CERTIFIED**. PRs #59 and #61–#67 completed the identity cutover, encrypted AI queue foundation, transaction/version refactor, authentication route/cookie and session-service seams, EnginEx 7.0.0 renderer security upgrade, commerce/membership route extraction, and authenticated AI task read-route extraction. VirgoScorpio Hub 0.6.2 is the current `main` line at `54b62e233e519aa0afa6c4170578def9c02e15fc`. PRs [#68](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/68), [#69](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/69), [#70](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/70), and [#71](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/pull/71) are all merged. Post-merge mainline workflow [run #292](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42120302005) passed all six hosted jobs on the exact main commit: Node.js 22.23.4 and 24.22.1, PostgreSQL/Memgraph integration, browser/editor smoke, CodeQL, and consolidated CI evidence. The rerun-state correction also passed mainline run [#289](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/actions/runs/42112860410). Formal readiness remains **NO-GO**: 7 PASS, 2 PARTIAL, 1 BLOCKED and 14 MISSING_EVIDENCE (`readyForProduction: false`). The blocked formal PostgreSQL/Memgraph evidence contract remains distinct from run-bound CI evidence; do not treat successful CI as production certification. No tag, GitHub Release, package publication, or production deployment is authorized. Read [the current 0.6.2 Release Gate Report](reports/2026-11-05-VirgoScorpio-Hub-0.6.2-Release-Gate-Report.md) for the full evidence and blockers, plus the [4 November 2026 0.6.1 baseline report](reports/2026-11-04-VirgoScorpio-Hub-0.6.1-Release-Gate-Report.md). See [Release readiness](RELEASE_READINESS.md), [CodeQL triage](security/CODEQL-TRIAGE-2026-11-01.md), [EnginEx migration](ENGINEX-7-MIGRATION.md), and the [4 November codebase optimization review](CODEBASE-OPTIMIZATION-REVIEW-2026-11-04.md).

This directory contains task-oriented documentation. The root [README](../README.md) is the project overview and quickest entry point; the pages below contain detail so that the README can stay scannable.

## Start here

| If you need to… | Read |
|---|---|
| Review the breaking project identity change and migration requirements | [Change record](../change.md) |
| Make your first contribution from a fresh clone | [Contributor Quickstart](CONTRIBUTOR-QUICKSTART.md) |
| Understand the platform layout, API composition, renderer boundary, authentication, and commerce route seams | [Architecture](ARCHITECTURE.md) |
| Migrate templates from EnginEx 6.x to 7.0.0 after legacy JavaScript execution removal | [EnginEx 7.0.0 Migration Guide](ENGINEX-7-MIGRATION.md) |
| Review the exact-SHA production release gate and remaining evidence blockers | [0.6.2 Release Gate Report — 5 November 2026](reports/2026-11-05-VirgoScorpio-Hub-0.6.2-Release-Gate-Report.md) |
| Review the previous mainline production release gate | [0.6.1 Release Gate Report — 4 November 2026](reports/2026-11-04-VirgoScorpio-Hub-0.6.1-Release-Gate-Report.md) |
| Review repository-wide reuse patterns, refactoring changes, and optimization priorities | [Codebase Optimization Review — 4 November 2026](CODEBASE-OPTIMIZATION-REVIEW-2026-11-04.md) |
| Understand the project mission and human-AI symbiosis vision | [VirgoScorpio Hub Manifesto](../VIRGOSCORPIO-HUB-MANIFESTO.md) |
| Apply the manifesto to product and engineering decisions | [Engineering Principles](VIRGOSCORPIO-HUB-PRINCIPLES.md) |
| Understand the proposed real-time, collaboration and AI architecture | [Real-Time and AI Architecture](REALTIME-AI-ARCHITECTURE.md) |
| Review the implemented developer-preview presence foundation and its limits | [Real-Time Foundation 1](REALTIME-FOUNDATION-F1.md) |
| Operate and troubleshoot the real-time preview without overstating its guarantees | [Real-Time Operations Runbook](REALTIME-OPERATIONS.md) |
| Configure trace correlation, the secured local OTLP collector profile, trust boundaries and safe attributes | [Observability and Trace Correlation](OBSERVABILITY.md) |
| Define and validate the production OTLP backend/security/governance/ownership evidence before deployment | [Production Observability Deployment Contract](OBSERVABILITY-DEPLOYMENT.md) |
| Review the CRDT/OT evaluation and collaborative editing recommendation | [Collaborative Editing Spike](COLLABORATIVE-EDITING-SPIKE.md) |
| Review existing AI provider adapters and integration boundaries | [AI Integration](AI-INTEGRATION.md) |
| Review recorded architecture trade-offs | [Architecture Decisions](ARCHITECTURE-DECISIONS.md) |
| Compare current feature coverage with planned capabilities | [Feature Coverage Matrix](FEATURE-PARITY.md) |
| Set up a local checkout | [Development](DEVELOPMENT.md) |
| Run tests or interpret validation | [Testing](TESTING.md) |
| Report a security issue or understand risk boundaries | [Security](SECURITY.md) and root [SECURITY.md](../SECURITY.md) |
| Understand project decisions, contribution stewardship, and funding transparency | [Governance](../GOVERNANCE.md) |
| Review the proposed zero-reserve operating and capital controls (**draft; not adopted**) | [Zero-Reserve Operating and Capital Resolution Draft](governance/ZERO-RESERVE-OPERATING-AND-CAPITAL-RESOLUTION-DRAFT.md) |
| Community behavior, reporting, and enforcement. | [Code of Conduct](../CODE_OF_CONDUCT.md) |
| How project contributions and collaborators are credited. | [Contributor Recognition](../CONTRIBUTOR_RECOGNITION.md) |
| Explore research topics or collaborate on technical investigations | [Research & Collaboration](../RESEARCH_COLLABORATION.md) |
| Decide whether a release can ship | [Release readiness](RELEASE_READINESS.md) |
| Plan work without making unsupported promises | [Roadmap](ROADMAP.md) |
| Update docs consistently | [Documentation standards](DOCUMENTATION_STANDARDS.md) |

## Documentation principles

- State the tested Node version, dependencies, command, and expected outcome when documenting a procedure.
- Mark requirements separately from optional integrations.
- Distinguish code availability from verified behavior, and tested behavior from production certification.
- Prefer copy/paste commands that work from the repository root.
- Never include live secrets, unredacted logs, customer data, or production identifiers.
- Keep feature tables, badges, architecture diagrams, screenshots, and examples synchronized with the current code.
- Keep proposed architecture and planned features visibly separate from implemented and validated capabilities.
- Apply the Human-AI agency principles to AI-enabled features, real-time collaboration, data use, attribution and approval design.

## Evidence and freshness

CI and local checks are snapshots. A release owner should rerun relevant checks against the exact release commit and record the evidence in the release process. For the last known certification state and remaining evidence, see [Release readiness](RELEASE_READINESS.md).
