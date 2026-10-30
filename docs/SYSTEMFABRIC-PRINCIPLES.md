# SystemFabric Engineering Principles

**Status:** Project-level design principles derived from the [SystemFabric Manifesto](../SYSTEMFABRIC_MANIFESTO.md)  
**Applies to:** Product planning, application architecture, AI features, collaboration, operations and contributor decisions

## Purpose

The SystemFabric Manifesto sets the project's mission around human economic agency, creative dignity and productive relevance in an era of accelerating AI. Its core thesis is that technology should amplify human capability rather than eliminate human necessity. It also identifies technological determinism, concentration of power and loss of human agency as guiding concerns.

This document translates those commitments into engineering principles that can guide concrete design reviews and acceptance tests. It does not claim that software alone can guarantee employment, income, job protection or macroeconomic outcomes.

## 1. Augment human capability

Build tools that help people create, learn, coordinate, decide and contribute more effectively. Evaluate AI features by whether they improve a person's ability to accomplish a meaningful goal, not only by task throughput or automation rate.

**Design checks:**

- Can the user understand what the feature is helping them do?
- Does it preserve the user's ability to direct, correct or stop the work?
- Does it help the user learn or make a better-informed decision when that is relevant?
- Is an accessible non-AI or manual path available when feasible?

## 2. Preserve human agency and choice

People remain active participants and decision-makers in the work they are responsible for. AI-generated content and actions must not be presented as human-approved when they are not.

**Design checks:**

- Make AI participation visible and distinguish suggestions from executed actions.
- Provide appropriate inspect, accept, reject, edit, undo and appeal paths.
- Respect user preferences and consent for AI assistance and contextual data use.
- Do not infer consent from presence, account activity or a default setting that users cannot reasonably understand.

## 3. Use proportional automation and oversight

SystemFabric does not reject automation. Bounded, low-risk, reversible tasks may be automated when the actor has explicitly delegated the necessary authority and policy allows it. Consequential, privileged, sensitive, externally visible or difficult-to-reverse actions require appropriate human review.

**Design checks:**

- Classify actions by impact, reversibility and scope.
- Bind approvals to the exact proposal, target, policy version and approver.
- Revalidate authorization and resource state at execution time.
- Never allow an AI agent to approve its own gated action, grant itself permissions or modify its own governance policy.

## 4. Keep authority explicit and least-privileged

Humans, AI agents and workflows are distinct actors. An AI agent must operate with an explicit, narrow delegation, not with a user's entire authority by default.

**Design checks:**

- Use a traceable actor identity for every human- or AI-initiated operation.
- Enforce tenant/site and object-level authorization at every read, subscription, tool call and write.
- Keep secrets and privileged credentials outside prompts, model outputs, client state and exported workflow definitions.
- Record who initiated, approved and executed consequential operations.

## 5. Make contributions and provenance understandable

Collaborative work may contain human-authored, AI-generated and jointly revised material. Where attribution is useful for user understanding, accountability or project history, preserve provenance without overstating what the metadata proves.

**Design checks:**

- Distinguish generated drafts, material transformations and human edits where relevant.
- Preserve version history and decision context for consequential changes.
- Do not treat attribution metadata as a legal determination of authorship, ownership, employment or compensation.
- Apply privacy and retention rules to contribution records.

## 6. Avoid surveillance by default

Real-time presence, cursors, activity streams and workflow telemetry can improve collaboration and operations, but can also expose sensitive behavior. Do not convert them into covert individual productivity scoring.

**Design checks:**

- Define the purpose, audience, visibility and retention of each presence/activity signal.
- Collect the minimum detail needed for the stated purpose.
- Provide privacy controls where appropriate and respect role boundaries.
- Separate operational reliability metrics from individual performance assessment.

## 7. Resist unnecessary concentration of power

Prefer transparent, inspectable and interoperable boundaries. Keep user data, permissions, workflow definitions and consequential decisions under clear governance rather than allowing an AI provider, opaque service or privileged agent to become an unreviewable authority.

**Design checks:**

- Keep provider integrations replaceable where practical.
- Document data export, deletion, portability and provider dependencies.
- Preserve auditability and meaningful human recourse.
- Make policy and administrative power boundaries explicit.

## 8. Protect creative dignity and meaningful participation

Support creators, administrators, workers, contributors and community members with tools that lower barriers to participation without assuming that every human activity should be automated. Provide ways for people to contribute judgment, domain knowledge, review, creativity and care.

SystemFabric may support skill development, contribution discovery and transparent recognition. It must not promise that a feature will create jobs, preserve employment, generate income or produce a particular economic outcome.

## 9. Build trustworthy and accessible systems

Human-AI collaboration must inherit the platform's security, privacy, accessibility and reliability requirements.

**Design checks:**

- Validate AI outputs and tool arguments before side effects.
- Apply tenant isolation and authorization to retrieved context and real-time event delivery.
- Provide keyboard, screen-reader and reduced-motion support for collaborative interfaces.
- Define failure, cancellation, retry, rollback and degraded behavior.
- Measure accuracy, bias, privacy leakage, latency, cost and user-reported usefulness.

## 10. Demand evidence and communicate honestly

A vision, architecture diagram, module, provider adapter or prototype is not a delivered capability. Claims must match implementation and validation evidence.

**Design checks:**

- Label capabilities as implemented foundation, partial, planned, research/prototype or production-validated.
- Link completed roadmap items to reproducible tests, reviewed artifacts or operational records.
- Distinguish mocked tests from live provider tests and skipped tests from passes.
- Document limitations and negative results.

## Applying these principles

Use this document in feature proposals, architecture decision records, security reviews, AI tool design, workflow approval design and release acceptance. When principles conflict, document the trade-off, affected users, risk, mitigation and decision owner rather than silently ignoring the conflict.

## Source and related documents

- [SystemFabric Manifesto](../SYSTEMFABRIC_MANIFESTO.md)
- [Feature Coverage Matrix](FEATURE-PARITY.md)
- [Roadmap](ROADMAP.md)
- [Real-Time and AI Architecture](REALTIME-AI-ARCHITECTURE.md)
- [Security Model](SECURITY.md)
- [Architecture and Data Flow](ARCHITECTURE.md)
