# VirgoScorpio Hub Documentation

## Current status and repository assurance

- [VirgoScorpio Hub 0.5.1 project status report — 1 November 2026](reports/2026-11-01-VirgoScorpio-Hub-0.5.1-Project-Status-Report.md) — full engineering, security, release-readiness, governance and funding snapshot. Historical candidate evidence; not production approval.
- [Repository coherence and continuity review — 1 November 2026](REPOSITORY-COHERENCE-AND-CONTINUITY-REVIEW-2026-11-01.md) — repository inventory, documentation drift, CI/readiness gaps, branch reconciliation, safe corrections and backlog.

The project remains **NOT_PRODUCTION_CERTIFIED**. PR #59 completed the VirgoScorpio Hub identity cutover; PR #61 subsequently merged the reusable helper and encrypted AI queue foundation into `main` at `a8ca0af` (4 November 2026). This does not certify a release. The 1 November status reports below remain historical snapshots, not current-commit readiness evidence. As checked against `main` on 4 November 2026, GitHub Code Scanning reports five open findings inherited by `a8ca0af`: four High-severity clear-text-sensitive-data alerts in `apps/api/src/server.js` and one Medium unsafe-code-construction alert in vendored `vendor/enginex/engine-legacy.js`. They have not been dismissed or waived. See [Release readiness](RELEASE_READINESS.md) for the production NO-GO gates and the [4 November codebase optimization review](CODEBASE-OPTIMIZATION-REVIEW-2026-11-04.md) for findings and priorities.

This directory contains task-oriented documentation. The root [README](../README.md) is the project overview and quickest entry point; the pages below contain detail so that the README can stay scannable.

## Start here

| If you need to… | Read |
|---|---|
| Review the breaking project identity change and migration requirements | [Change record](../change.md) |
| Make your first contribution from a fresh clone | [Contributor Quickstart](CONTRIBUTOR-QUICKSTART.md) |
| Understand the platform layout and data flow | [Architecture](ARCHITECTURE.md) |
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
