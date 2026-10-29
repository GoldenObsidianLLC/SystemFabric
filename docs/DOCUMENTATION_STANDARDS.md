# Documentation Standards

These standards adapt established README-design patterns to SystemFabric's actual code and release process. The goal is discoverability and trustworthy guidance, not decorative volume.

## Root README

- Lead with the product name and one plain-language sentence explaining what it is.
- Show only relevant badges whose targets exist; dynamic CI must link to the real workflow.
- Provide a table of contents and quick links before long detail.
- Prioritize capabilities, prerequisites, a copy/paste quick start, validation commands, architecture, and links to deeper docs.
- Use tables for comparisons and Mermaid diagrams for architecture only when they clarify real code boundaries.
- Keep license, contributor, security, and release-status information visible.
- Do not add placeholder screenshots, sample logos from other projects, stale statistics, unsupported benchmarks, or fabricated demo links.

## Deeper docs

- One page should answer one main question: architecture, development, testing, security, readiness, or roadmap.
- Start with purpose and scope, then provide steps or a reference table.
- Include command prerequisites and expected effects; state if a command contacts external services or mutates test databases.
- Separate implemented behavior from planned work and production evidence requirements.
- Keep source-code paths and command names synchronized with the repository.

## Writing style and visual treatment

- Prefer concise, descriptive headings, lists with parallel grammar, accessible link text, and code fences with language identifiers.
- Use anchor links for long pages and a “Back to top” link only when useful.
- Use screenshots/GIFs for real user workflows; add alt text and keep assets current.
- Avoid excessive shields, decorative emoji, very large tables, duplicate content, and marketing superlatives that the evidence cannot support.
- Trim trailing whitespace and review rendered Markdown after editing.

## Accuracy gate before publishing

1. Verify all linked paths and URLs.
2. Run every code command advertised as a tested quick start.
3. Confirm badges resolve and represent actual checks.
4. Confirm feature statements against code and tests.
5. Review the changelog, license, attribution, third-party notices, and security policy.
6. Re-run current-tree and Git-history secret scans; inspect workflow artifacts for sensitive content.
7. Have a human reviewer read the rendered pages.
