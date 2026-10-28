# EnginEx Threat Model

## Assets

Template source, rendered HTML, template data, trusted application helpers, API credentials, filesystem contents beneath the template root, provider spend, and production publishing integrity.

## Trust boundaries

1. Template source -> restricted parser -> AST compiler-generated JavaScript / interpreter.
2. Build-produced AST manifest -> version, path, node, size and dependency validation -> compiler-generated renderer. Treat the builder and code generator as trusted computing base.
3. Application data -> data snapshot/schema validation or opaque prepared snapshot -> renderer.
4. Model output -> strict local parsing/validation -> preview -> human review -> optional publication.
5. MCP/WebSocket/WebTransport/WebRTC client -> tool/message validation and host authorization.
6. Registered helper -> host capabilities (filesystem, network, databases, secrets).

## Primary threats and controls

| Threat | Controls | Residual risk |
|---|---|---|
| Arbitrary code execution from expressions | Restricted grammar; compiler translates only supported AST nodes, string literals are escaped, raw source is not copied into code; direct registered helper calls only | Compiler/codegen bug, malformed manifest accepted by validation, or malicious helper; codegen needs independent review and fuzzing |
| Prototype pollution/property escape | Blocked meta-properties and own-data property reads | Runtime/parser regression |
| XSS from interpolated values | HTML escaping by default, branded raw output, `safeUrl`, `jsonScript` | HTML contexts other than supported text/quoted attributes; dangerous static HTML |
| Traversal and symlink escape | Canonical path checks, root confinement, target checks for publication | TOCTOU on mutable deployment directories; incorrect host configuration |
| CPU/memory exhaustion | Limits on source, AST, data, loops, output and render time | Synchronous helper can block the event loop; algorithmic complexity can still matter |
| Prompt injection | AI outputs validated as untrusted; helper allowlist; tools have narrow permissions; no MCP publish/write tools | A model may still produce malicious static HTML or persuasion text; human review remains needed |
| Data leakage to providers | Provider adapter is opt-in; only request inputs are sent | Caller may include PII/secrets in prompts or sample data |
| Unauthorized publishing | Disabled by default; dual permissions plus host approval callback | Host callback and file permissions are part of the trusted computing base |
| MCP/WebSocket/transport abuse | Tool schemas, request element/size bounds, WebSocket authorization callback, message/rate/output limits, WebRTC/WebTransport message caps | Remote transport needs deployment-level authentication, rate limiting, tenant isolation, origin controls, audit logs and TLS; WebRTC signaling is host-owned |
| Schema validator bypass / misinterpretation | Unsupported keywords fail explicitly; documented subset | Validator is not complete JSON Schema Draft 2020-12; host should use full validator when needed |

## Out of scope

The engine does not sandbox malicious HTML from an untrusted author, isolate malicious host helper functions, sanitize rich HTML, provide a WebTransport server or WebRTC signaling, authenticate arbitrary remote transports, or prove correctness of model-generated templates. Those require application-level policies and deployment controls.
