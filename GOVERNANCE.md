# SystemFabric Governance

This document describes the project's current working governance model. It is intended to make decision-making, contribution review, project stewardship, and future funding discussions understandable to contributors and supporters.

It is a project policy, not legal advice, a separate legal entity, a promise of funding, or a representation that SystemFabric is production-certified. It does not replace the software licenses, copyright notices, security policy, or contribution instructions.

## 1. Current Project Stewardship

SystemFabric is developed through Golden Obsidian LLC. The project is currently in an early, maintainer-led stage.

At this stage, Golden Obsidian LLC and the project founder/original developer act as the primary project steward and maintainer.

The maintainer is responsible for repository administration, accepting or declining contributions, merging changes, releases, project communications, security coordination, and use of project names and branding.

Community participation is welcome and valued, but participation in an issue or Discussion does not by itself grant repository permissions, maintainer status, decision-making authority, or rights to use project branding.

This is the current arrangement, not a claim that the project is already community-governed.

As the contributor community grows, the governance model may be reviewed and expanded. Any change to maintainer roles or decision-making authority should be documented publicly.

## 2. How Project Decisions Are Made

The project aims to make significant technical decisions understandable and open to constructive feedback.

* **Questions and exploration:** Use GitHub Discussions for questions, alternatives, architecture conversations, research ideas, and general feedback.
* **Specific work:** Use GitHub Issues to describe a reproducible defect, focused improvement, feature proposal, or tracked task.
* **Design-sensitive changes:** For changes affecting architecture, public APIs, data models, migrations, authorization, security boundaries, licensing, or compatibility, open an issue or Discussion before substantial implementation when practical.
* **Decision record:** Where a proposal materially affects the project, the maintainer should summarize the accepted direction and important trade-offs in the relevant issue, Discussion, or pull request.
* **Maintainer decision:** The maintainer makes the final repository decision at this stage, including whether to accept, defer, request changes to, or decline a proposal. Community feedback informs decisions but is not a binding vote.

There is no guaranteed response time. The project is currently maintained without a funded contributor or support team.

## 3. How Contributions Are Reviewed

The authoritative contribution workflow is in [CONTRIBUTING.md](CONTRIBUTING.md). Contributors should read it before opening a pull request.

In general, proposed contributions should:

* Have a clear and reasonably focused purpose.
* Preserve existing licensing, copyright, and third-party notices.
* Include or update tests appropriate to the change.
* Document relevant configuration, compatibility, migration, and operational impacts.
* State the exact validation commands run and identify tests that were skipped or mocked.
* Avoid credentials, private data, production dumps, and unrelated generated artifacts.

Maintainers may ask for clarification, tests, documentation, changes, or additional review.

A pull request may be declined when it is outside the project's direction, creates unacceptable security or maintenance risk, lacks necessary evidence, or cannot be reviewed adequately.

Only maintainers with repository permissions can merge changes.

A green CI run or successful pull-request review is evidence for the checks actually performed; it is not production certification.

### Contributions and Licensing

Original SystemFabric materials are published under GPL-2.0-or-later unless a file or component carries a different notice.

Third-party and vendored components retain their own applicable licenses and notices.

The contribution terms and attribution expectations are described in [CONTRIBUTING.md](CONTRIBUTING.md), [LICENSE](LICENSE), [COPYRIGHT](COPYRIGHT), and [NOTICE.md](NOTICE.md).

Contributors must have the right to submit the material they contribute and must identify relevant third-party material.

This governance document does not create a separate copyright assignment or additional contributor license agreement. Any future change to contribution licensing requirements should be clearly announced and documented before it is applied.

## 4. Maintainer Development

The project may add maintainers as the community and review workload grow.

Maintainer invitations should consider demonstrated technical judgment, sustained constructive participation, security awareness, communication, availability, and conflicts of interest.

There is no automatic path from making a contribution to becoming a maintainer.

Repository access should be granted deliberately and with the least privilege needed for the role.

Changes to maintainer responsibilities should be reflected in this document.

## 5. Security and Responsible Disclosure

Security concerns must be handled according to the project's [SECURITY.md](SECURITY.md) policy.

Do not publish exploitable vulnerability details, credentials, session tokens, private user data, or production secrets in public Issues, Discussions, or pull requests.

Use the repository's private vulnerability reporting flow when available, or the alternative private contact path described in the security policy.

Volunteer feedback, a code review, or a contribution to regression tests is not a substitute for a formal independent security assessment.

SystemFabric remains not production-certified until the required release evidence and approvals are complete.

See [release readiness](docs/RELEASE_READINESS.md) and [release evidence](docs/RELEASE-EVIDENCE.md).

## 6. Community Expectations

Participants are expected to communicate respectfully and constructively, focus criticism on ideas and implementation rather than individuals, credit other people's work, and respect privacy and confidentiality.

Harassment, discriminatory conduct, threats, doxxing, spam, and deliberate disruption are not acceptable.

The maintainer may moderate or remove content, restrict participation, or lock a conversation where reasonably necessary to protect the community and project.

Security reports and sensitive personal information must not be posted publicly.

## 7. Funding, Donations, and Sponsorship

### Current Status

SystemFabric is currently an unfunded project.

No official public donation, sponsorship, grant, or contributor-compensation program is established by this policy.

Do not send money to personal accounts or use donation links unless an official channel is published in the repository.

The project is not representing itself as a registered charity or tax-exempt organization.

No donation or contribution should be described as tax-deductible unless that status is independently confirmed and explicitly disclosed through an appropriate official channel.

### If Funding Is Established

Before inviting or accepting funding through an official project channel, the project steward should publish:

* The legal recipient or responsible organization.
* The official payment or sponsorship platform and any material fees.
* The intended project purposes and any restrictions.
* How funds will be administered and how conflicts of interest will be handled.
* How and when the community will receive a high-level summary of funds received and project expenditures, subject to privacy, security, and legal obligations.

Potential project uses may include:

* Development infrastructure.
* CI and test environments.
* Independent security assessments.
* Accessibility testing.
* Documentation and community services.
* Research and development.

These are possible future uses, not commitments that funding is available or that any particular expense has been approved.

Funding does not automatically grant ownership of the project, repository administration, maintainer status, intellectual-property rights, control of the roadmap, preferential security treatment, or an endorsement.

Any sponsored work or material funding-related influence on project priorities should be disclosed.

Donor or sponsor names should not be published without permission.

The project should not promise a particular result, delivery date, tax treatment, or financial return in exchange for a donation.

## 8. Transparency and Conflicts of Interest

Maintainers and contributors should disclose material conflicts of interest when those conflicts could reasonably affect a technical recommendation, security assessment, vendor selection, sponsored feature, or other project decision.

When practical, a person with a material conflict should not be the sole reviewer or decision-maker for the affected matter.

Significant funding relationships or sponsored work that affect project direction should be disclosed in the relevant public project record, without exposing private or legally protected information.

## 9. Changes to This Policy

This policy may evolve as SystemFabric develops and its community grows.

Proposed material changes should be discussed openly where practical, reviewed by the project steward, and made through a pull request so the history remains visible.

The current version in the default branch is the reference for the project's stated governance model.
