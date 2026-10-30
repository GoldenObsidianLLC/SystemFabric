# SystemFabric Research & Collaboration

## Purpose

SystemFabric is an early-stage, open-source modular Node.js platform developed through Golden Obsidian LLC.

The project brings together application services for content workflows, identity, commerce, community, AI integrations, and extensible application functionality.

We welcome developers, application security professionals, researchers, infrastructure engineers, database specialists, and other interested contributors who would like to examine its architecture, evaluate its engineering approaches, identify weaknesses, and help improve its reliability.

This is an invitation to collaborate and investigate—not a claim that the project has already solved these research problems or established new industry standards.

**Project status: NOT_PRODUCTION_CERTIFIED.**

## Research and Engineering Areas

### 1. PostgreSQL and Memgraph Consistency and Recovery

SystemFabric uses PostgreSQL for transactional and relational workflows and Memgraph for graph projections.

Research questions include:

* How should transactional updates and graph projections remain consistent?
* How should outbox delivery, retries, and idempotent processing be evaluated?
* How can projection drift be detected and corrected?
* What replay, rebuild, and recovery procedures are appropriate?
* What consistency guarantees can reasonably be documented and tested?

Potential contributions include reproducible experiments, architecture reviews, failure simulations, test cases, and documented recommendations.

### 2. Multi-Tenant and Site Isolation

Tenant and site isolation are important security boundaries.

Research and review opportunities include:

* Reviewing tenant context propagation across API routes.
* Evaluating conflicting tenant selectors in headers, query parameters, request bodies, and route parameters.
* Examining authorization behavior in background jobs and asynchronous workflows.
* Identifying cross-tenant data exposure risks.
* Expanding isolation tests and independent security review.

Potential contributions include test suites, threat models, reproducible findings, and remediation proposals.

Security findings should be reported through the project's [Security Policy](SECURITY.md), not disclosed publicly before remediation.

### 3. Plugin Execution Isolation

SystemFabric contains plugin-related validation and execution components. The security of an actual execution sandbox must be evaluated in its intended runtime.

Research questions include:

* What container or process-isolation controls are necessary?
* How should CPU, memory, filesystem, and execution-time limits be enforced?
* How should network access and outbound traffic be restricted?
* How should immutable images and artifact provenance be verified?
* What tests can demonstrate that isolation boundaries hold under attempted abuse?

Potential contributions include container experiments, threat models, security tests, and deployment-specific recommendations.

### 4. Reliability, Recovery, and Operational Testing

The project needs stronger evidence for behavior under production-like operating conditions.

Areas of interest include:

* Concurrent writes and transaction behavior.
* Outbox retries and failure recovery.
* Database migration and upgrade paths.
* Backup and restoration procedures.
* Load testing and resource-boundary testing.
* Observability and operational failure handling.

Research should produce repeatable procedures and evidence rather than relying only on successful unit tests.

### 5. External Provider and Workflow Validation

SystemFabric includes integration paths involving services such as Stripe, AI providers, email, object storage, and malware scanning.

Potential work includes:

* Provider sandbox testing.
* Webhook verification and replay protection.
* Idempotency and ambiguous transport outcome testing.
* Failure and reconciliation testing.
* Integration acceptance criteria and reproducible test environments.

Mock-backed tests are useful for local behavior, but do not by themselves establish that an external provider works correctly.

## How to Collaborate

There are several ways to participate:

* Review architecture and identify design weaknesses.
* Propose research questions or alternative approaches.
* Develop reproducible test cases and experiments.
* Review security boundaries and authorization behavior.
* Improve documentation and technical explanations.
* Contribute code, tests, tooling, or deployment examples.
* Share findings, limitations, and recommendations.

A useful research contribution should explain the question being investigated, the environment and assumptions, the methodology, the observed results, and any limitations.

Negative results are valuable. Demonstrating that an approach is unsuitable can help the project make better engineering decisions.

## Research Integrity and Expectations

SystemFabric values reproducibility, technical accuracy, constructive criticism, and transparent reporting.

Contributors should:

* Distinguish measured results from assumptions.
* Avoid publishing sensitive information or credentials.
* Use synthetic or authorized test data.
* Document environmental requirements and limitations.
* Avoid making production-readiness claims based solely on isolated tests.
* Coordinate before running tests against shared or external infrastructure.

Research participation does not automatically establish maintainer status, repository permissions, project ownership, or endorsement of a contributor's conclusions.

See [GOVERNANCE.md](GOVERNANCE.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [CONTRIBUTOR_RECOGNITION.md](CONTRIBUTOR_RECOGNITION.md).

## Funding and Compensation

SystemFabric is currently an unfunded open-source project.

There is no established paid research program, contributor compensation program, official donation channel, or formal sponsorship or grant program.

Participation is voluntary. No one should undertake work with an expectation of payment, reimbursement, employment, or future financial benefit.

Golden Obsidian LLC may explore appropriate sponsorship, grant, research, or infrastructure-support opportunities in the future. Any established funding arrangement will be documented transparently in accordance with the project's governance policy.

Please do not send money through unofficial channels or assume that a funding opportunity has been approved.

## Getting Started

The best starting points are:

* [GitHub Discussions](https://github.com/GoldenObsidianLLC/SystemFabric/discussions) — research questions, ideas, and technical conversations.
* [GitHub Issues](https://github.com/GoldenObsidianLLC/SystemFabric/issues) — scoped tasks, bugs, and proposed improvements.
* [Architecture](docs/ARCHITECTURE.md) — the current application and data-flow overview.
* [Roadmap](docs/ROADMAP.md) — planned engineering and reliability work.
* [Release Readiness](docs/RELEASE_READINESS.md) — outstanding evidence and certification requirements.
* [Security Policy](SECURITY.md) — responsible vulnerability reporting.

We appreciate everyone willing to examine the project carefully, ask difficult questions, share expertise, and help improve the quality of the work.

**The goal is to build a stronger, more reliable, and more thoroughly evaluated open-source platform through honest engineering and collaboration.**
