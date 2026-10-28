# Security Policy

## Supported releases

The project targets the currently patched Node.js 22, 24 and 26 release lines. Security fixes should be applied to the current maintained release; backports to older lines are at maintainer discretion.

## Reporting a vulnerability

Do not file a public issue containing exploit details. Before distributing this project publicly, the maintainers must configure and monitor either a private repository security-advisory channel or a dedicated security contact. Until a monitored channel is configured, this file is not a promise of private intake or an incident-response SLA.

When reporting, include the affected version, Node.js version, reproducer, impact, assumptions about template/data trust, and any suggested mitigation. Avoid uploading real secrets or production data.

## Security boundaries

- Safe template expressions use a restricted grammar. The compiled synchronous backend emits code only from validated AST nodes and escaped literals, then uses `Function` to instantiate that compiler-generated code; raw template source is never inserted into executable source. Treat the AST compiler and manifest loader as part of the security boundary and review changes carefully.
- Legacy `<?njs ?>` compatibility mode executes arbitrary JavaScript and is unsafe for untrusted templates.
- Static HTML is not sanitized and can contain active content.
- `safeHtml()` is a trust assertion, not sanitization.
- Registered helpers execute application code; permissions and external effects belong to the host application.
- Generic HTML escaping does not encode JavaScript or CSS contexts. `htmlAttr(value)` is intended only for quoted HTML attribute values; `safeUrl(value)` applies a limited URL scheme policy and is not a sanitizer.
- AI-generated templates and precompiled AST manifests are untrusted inputs unless produced by the trusted build pipeline; validate manifest version, node types, dependency graph, size and paths before code generation. AI-generated templates need validation, preview, and human review.
- MCP and WebSocket preview tools can still consume CPU, memory, provider budget, or disclose whatever input a caller sends. The WebSocket adapter requires a host-supplied authorization function and transport/server hardening. WebTransport/WebRTC wrappers do not implement authentication or signaling.
- The included JSON Schema validator supports a documented subset, not the complete Draft 2020-12 specification.

## Release checklist

1. Run the test suite, deterministic fuzz corpus, and live provider evaluations where configured.
2. Test current patched Node.js 22, 24 and 26 releases.
3. Review all changes to parser, path resolution, escaping, helper permissions, provider payloads, MCP transport and publication code.
4. Scan the package and dependency lockfile; the core package has no mandatory third-party runtime dependencies.
5. Run dependency and SAST tooling in CI, plus an external security review before claims of independent audit.
6. Publish a changelog and migration notes for security-relevant changes.
7. Confirm the security reporting mechanism is monitored.
