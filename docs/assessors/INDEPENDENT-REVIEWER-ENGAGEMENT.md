# VirgoScorpio Hub 0.5.1 — Independent Assessor Engagement Brief

**Status:** procurement preparation only. No vendor has been contacted, retained, or approved. No independent review has been performed.

**Coordination:** [GitHub issue #14 — Independent tenant/site isolation and authorization review](https://github.com/GoldenObsidianLLC/VirgoScorpio-Hub/issues/14)

**Technical hand-off:** [TENANT-ISOLATION-ASSESSMENT-BRIEF.md](TENANT-ISOLATION-ASSESSMENT-BRIEF.md)

**Current source baseline when this procurement brief was prepared:** `05a4d050696b5d06d66a5b3dce184935037ee3d6`. This is not a pre-approved assessment pin. The selected assessor and project owner must confirm the exact clean `main` SHA at engagement start and record it in the final report.

## 1. Engagement sought

Engage an external, independent application-security assessor to perform a manual, source-assisted (white-box/grey-box) tenant-isolation and authorization review of VirgoScorpio Hub 0.5.1.

This is not a generic vulnerability scan, a compliance checklist, or a short unauthenticated perimeter test. The highest-value questions concern broken object-level authorization (BOLA/IDOR), tenant-context confusion, role/capability escalation, and tenant data or side effects leaking through asynchronous and realtime paths.

### Mandatory review coverage

- HTTP/API routes, authentication/session lifecycle, tenant/site resolution, role/capability guards, admin/developer operations, and object-level authorization.
- PostgreSQL query/data-access scoping, including direct object references, list/search/count aggregation, export, download, update and delete paths.
- Two or more synthetic tenants with different memberships and privilege levels; adversarial cross-tenant read/write attempts and assertions that denied requests have no side effects.
- Outbox, event replay, workers, delayed jobs, graph projections/rebuilds, Redis/cache partitioning and reconciliation.
- SSE/WebSocket presence, collaborative document channels/operations, reconnect, revocation and reauthorization.
- Library metadata and object bytes, versions, public/private links, temporary URLs and storage callbacks.
- Findings triage, practical remediation guidance and independent retesting of Critical/High findings.

The reviewer must discover and inventory the complete in-scope route/capability/data-access surface. The existing community-feed test is only a starting regression test.

### Required deliverables

1. Signed independent report naming the assessor, qualifications, independence/conflict statement, dates, exact reviewed commit, environment and methodology.
2. Route-to-capability/data-access inventory and coverage matrix, with tested, not-run and not-applicable items distinguished.
3. Adversarial test results for cross-tenant operations and no-side-effect assertions, including asynchronous/realtime paths where implemented.
4. Findings with severity, impact, safe reproduction references, remediation owner/issue, remediation commit and retest result.
5. Sanitized machine-readable evidence conforming to [the assessor evidence template](../templates/tenant-isolation-review.evidence.template.json) and the [release evidence contract](../RELEASE-EVIDENCE.md).
6. A clear conclusion and residual-risk statement. Critical/High findings must be fixed and retested or explicitly escalated for risk acceptance by an authorized owner.

The canonical passing evidence path is `artifacts/evidence/tenant-isolation-review.json`. A proposal, quote, scope meeting, test plan or assessor packet is not evidence that the gate passed.

## 2. Suggested vendor shortlist

This is a research shortlist, not an endorsement or a statement that a firm is available, affordable, conflict-free, or willing to take the engagement. Confirm all details directly during procurement. Official pages were reviewed on 2026-10-31.

| Candidate | Why invite a proposal | Official contact route | Fit to validate in the proposal |
|---|---|---|---|
| **Cure53** | Its published services include black-box penetration tests, white-box testing and code audits for web applications and online services, including JavaScript. Its published Ente platform assessment describes white-box reviews of authentication, authorization and ACLs, in addition to feature and infrastructure testing. | [Cure53 services and business contact](https://cure53.de/) — `hello@cure53.de` | Ask for a named senior assessor/team with multi-tenant SaaS experience and specific PostgreSQL, background-job and realtime/collaboration experience. |
| **NCC Group** | Its application-security offering includes application penetration testing, code review and software-architecture review. Its application-assessment description explicitly discusses business-logic and technical flaws, authorization/access control, web apps and APIs. | [Application security](https://www.nccgroup.com/technical-assurance/application-security/), [application penetration testing](https://www.nccgroup.com/technical-assurance/application-security/application-penetration-testing-security-assessments/), [contact](https://www.nccgroup.com/contact-us/) | Ask whether the proposed team will perform hands-on source-assisted tenant-boundary testing across Postgres, outbox/workers, caches, Redis and realtime connections, not only standard web/API scanning. |
| **Bishop Fox** | Its application penetration-testing service describes attack-surface mapping, testing of authentication/authorization and APIs, manual assessment, secure-code review, detailed findings and remediation retesting. | [Application penetration testing](https://bishopfox.com/services/penetration-testing-services/application-penetration-testing) — use the page's “Get Started” contact route. | Ask for a named assessor with tenant isolation/BOLA experience and confirmation that source-assisted route and data-flow review is included. |

### Recommended sourcing approach

Request equivalent written proposals from Cure53 and NCC Group first, with Bishop Fox as a third comparison. They are the closest matches found for a manual application-security engagement with source-assisted review. Choose based on the named team's directly relevant multi-tenant authorization experience, method, independence, deliverables, retesting terms and total cost—not brand recognition alone.

No pricing is assumed here. Ask each firm for a fixed-scope proposal and an optional extension rate for additional route families or retesting. Do not treat a generic automated scan or a promotional price for a narrower product as equivalent to this independent assessment.

## 3. Vendor qualification and scoring

### Non-negotiable gates

A candidate must:

- Be independent from VirgoScorpio Hub's implementation team and disclose any prior work, financial interest, personal relationship or other conflict involving the project, repository, owner or contributors.
- Name the individual(s) who will conduct the work and provide relevant examples of manual web/API authorization and multi-tenant application assessments.
- Agree to a source-assisted assessment and an explicit route/capability coverage inventory.
- Test only against an isolated, owner-authorized non-production environment populated with synthetic data.
- Protect source access, test credentials, findings and exploit details; agree on secure storage, access, retention and deletion.
- Deliver a signed report and sanitized evidence suitable for the repository's acceptance process, plus retesting of Critical/High fixes.
- Accept written rules of engagement, authorized targets, test windows, prohibited actions and emergency stop contacts.

Reject a proposal that provides only automated scanning, omits authorization/business-logic testing, refuses to identify the accountable assessor, cannot evidence independence, or excludes findings validation/retest without clearly pricing it as an option.

### Comparative scorecard

Score each proposal from 1 (weak) to 5 (excellent), multiply by the weighting, and retain the written rationale.

| Criterion | Weight |
|---|---:|
| Direct experience with multi-tenant SaaS, BOLA/IDOR, authorization and privilege boundaries | 30% |
| Manual source-assisted testing and quality of route/data-flow coverage | 25% |
| Experience with asynchronous workers/events, PostgreSQL, caching and realtime systems | 15% |
| Independence, confidentiality and safe evidence/reporting practices | 15% |
| Critical/High remediation validation and retest quality | 10% |
| Communication, availability and practical delivery plan | 5% |
| **Total** | **100%** |

Also compare the total price, assumptions, exclusions, schedule, payment terms, retest window and any travel or infrastructure costs separately. Do not use the weighted score to override a failed non-negotiable gate.

## 4. Request-for-proposal questions

Ask each candidate to answer these points in writing:

1. Who will personally lead and execute the review? Provide relevant qualifications and two or three sanitized examples of comparable work, especially multi-tenant authorization/BOLA or ACL reviews.
2. Will the review include source access and manual tracing from routes through authorization, database queries, object storage, events, workers, cache keys, graph projections, SSE/WebSocket and external callbacks?
3. How will you enumerate routes and prove coverage? How will you test tenant A/B with different roles and assert no disclosure or side effect after denied access?
4. How will you test revocation, stale sessions, role changes, replay, cross-instance messages, background work and tenant context propagation?
5. Which parts will be automated, which will be manually validated, and what is explicitly out of scope?
6. What environment, accounts, roles, architecture materials, test fixtures and staff availability do you require from us?
7. What are the proposed person-days, phases, calendar window, fixed fee, optional extension rate and retest terms?
8. What exact report and machine-readable artifacts will be supplied? Can the sanitized evidence map to our formal evidence contract?
9. How are findings communicated securely and promptly? What are the rules for Critical/High notification and emergency escalation?
10. What conflict checks, NDA, insurance, data handling/retention and deletion commitments apply?

## 5. Proposed rules of engagement

- The project owner authorizes only the specific non-production URLs, APIs, source revision and test infrastructure named in the signed statement of work.
- Use synthetic tenants, users, files and records. Do not access production/customer data or use live payment credentials.
- No destructive testing, denial-of-service/load exhaustion, persistence, social engineering, phishing, external scanning or third-party target testing unless separately authorized in writing.
- No testing outside agreed dates/windows or approved source revision. Record the exact commit, configuration and service versions.
- Provide a private emergency contact and immediate notification path for suspected Critical findings or accidental exposure.
- Share exploit details, request/response captures and sensitive evidence only through the agreed access-controlled channel. Public issue comments and repository artifacts must be sanitized.
- Agree retention and secure deletion of source checkouts, secrets, test data and raw evidence at engagement end.
- The assessor must state independence and limitations. The implementation team may help explain architecture and remediate findings but cannot self-approve the independent gate.

## 6. Initial outreach template

**Subject:** Proposal request — independent multi-tenant application security assessment (VirgoScorpio Hub 0.5.1)

Hello,

Golden Obsidian LLC is seeking an independent application-security assessor for VirgoScorpio Hub 0.5.1, a Node.js/PostgreSQL application with multi-site tenancy, background/outbox processing, graph projections, Redis-backed realtime collaboration, and object-library storage.

We are looking for a manual, source-assisted review focused on tenant/site isolation and authorization: route/capability coverage, BOLA/IDOR, privilege boundaries, cross-tenant data access and side effects, and tenant context propagation through workers, events, caches, graph projections and SSE/WebSocket collaboration.

The engagement is intended for an isolated non-production environment with synthetic data. Required deliverables include a signed report tied to an exact commit, a route/capability coverage matrix, adversarial two-tenant test results, prioritized findings, and independent retesting of Critical/High remediations. We have a detailed assessor brief and evidence format ready to share.

Could you provide:
- the proposed lead assessor and directly relevant multi-tenant authorization experience;
- confirmation of source-assisted/manual coverage across the areas above;
- a proposed methodology, scope, assumptions and exclusions;
- estimated effort, schedule, fixed-fee quote and optional retest terms; and
- your NDA, independence/conflict and secure evidence-handling process?

We have not authorized testing yet. No access or activity should begin until a statement of work and written rules of engagement are approved by the project owner.

Regards,

Golden Obsidian LLC

## 7. Procurement decision record

| Field | Current state |
|---|---|
| Budget owner / approved budget | Not recorded |
| Approving procurement owner | Not recorded |
| Firms invited | None — research shortlist only |
| Proposals received | None |
| Selected assessor | None |
| Independence/conflict checks | Not performed |
| Statement of work / rules of engagement | Not approved |
| Assessment performed | No |
| Formal gate status | **OPEN — MISSING EVIDENCE** |

### Immediate action

The project owner should approve a spend ceiling and authorize outreach to the shortlisted firms. Once that authority exists, send the same RFP to each candidate, compare written proposals using the scorecard, complete conflict checks, and select the named assessor. Do not close issue #14 or create a passing evidence file until the review and required retesting are complete.

VirgoScorpio Hub 0.5.1 remains **NOT_PRODUCTION_CERTIFIED / NO-GO**.
