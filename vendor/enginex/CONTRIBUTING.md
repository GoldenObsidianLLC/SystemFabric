# Contributing

## Development commands

- `npm test`: unit and security tests.
- `npm run check`: JavaScript syntax checks plus tests.
- `npm run evals`: deterministic AI-readiness evaluation fixtures (no provider call).
- `npm run bench:compare`: cross-runtime render benchmark; Twig is optional.

## Change requirements

- Preserve safe-mode's no-arbitrary-JavaScript rule.
- Add a regression test for parser, expression, path, cache, data, output, AI, schema, or MCP changes.
- Do not silently accept unsupported syntax or JSON Schema keywords.
- Do not add mandatory dependencies to the renderer core. AI/provider/MCP integrations must stay optional.
- Provider code must not log API keys, raw secrets, or full private inputs.
- Never add a model-controlled direct publish or file-write MCP tool.
- Update grammar, manifest, docs, changelog and evaluation fixtures whenever semantics change.
- Do not describe a proposed optimization as faster unless a repeatable benchmark supports it.

## Pull request checklist

- [ ] Unit and fuzz tests pass.
- [ ] New parser behavior has negative tests.
- [ ] Output escaping and path confinement reviewed.
- [ ] Node.js version matrix tested in CI.
- [ ] Documentation and grammar match the implementation.
- [ ] Performance claims include reproducible commands and checksums.
