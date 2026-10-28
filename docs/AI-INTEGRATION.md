# SystemFabric AI Integration

## Purpose

AI is an integrated, optional capability for content creation and operations. It is not required to render pages, access the CMS, or serve published content. The AI service provides a consistent task API across supported providers and returns structured proposals that are validated before they reach the caller.

## Provider adapters

| Adapter | Environment | Status in 0.5.0 | Notes |
|---|---|---|---|
| `mock` | `AI_PROVIDER=mock` | Implemented for deterministic tests | No network call; never use it to claim a real AI result |
| OpenAI Responses | `AI_PROVIDER=openai-responses`, `OPENAI_API_KEY`, `OPENAI_MODEL` | Implemented | Uses Responses API and structured output when configured |
| OpenAI-compatible | `AI_PROVIDER=openai-compatible`, `AI_BASE_URL`, `AI_MODEL`, optional `AI_API_KEY` | Implemented | Useful for gateways and local servers; model output is still validated locally |
| Anthropic Messages | `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Implemented | JSON is requested in instructions, then parsed/validated locally |
| Google Gemini Interactions | `AI_PROVIDER=gemini`, `GEMINI_API_KEY`, `GEMINI_MODEL` | Implemented, request contract unit-tested | Uses current Interactions endpoint, schema-based JSON output, and `store:false`; domain validation remains authoritative |

For OpenAI-compatible gateways and local model hosts, `OPENAI_COMPATIBLE_STRICT_JSON_SCHEMA` defaults to `false` because support varies by endpoint; enable it only after verifying the selected server/model supports strict JSON Schema.

Use secret management in deployed environments. External-provider calls are blocked by default. Set `AI_ALLOW_EXTERNAL_CONTENT=true` only after reviewing the provider, data-processing terms, and which submitted text may leave your environment. With this gate enabled, prompts and content sent to an external provider are processed by that provider. Never put provider keys in browser JavaScript, CMS page documents, widget properties, logs, MCP prompts, or version-controlled configuration files.

## Supported tasks

### 1. Generate a page draft

`POST /api/v1/ai/page-draft`

```json
{
  "prompt": "Create a modern home page for a boutique architecture studio with a hero, services, project highlights and a contact CTA.",
  "siteContext": "Brand voice: calm and architectural. Do not invent client names or project awards."
}
```

Returns a `document` conforming to SystemFabric Page Document v1 plus `provenance` (`provider`, `model`, `generatedAt`) and `status: draft-proposal`. The response is not saved and not published.

### 2. Assist with content

`POST /api/v1/ai/content-assist`

```json
{
  "operation": "make-clearer",
  "tone": "clear and professional",
  "text": "Original content to improve..."
}
```

Allowed operations: `rewrite`, `proofread`, `shorten`, `expand`, `make-clearer`, `change-tone`.

### 3. SEO suggestion

`POST /api/v1/ai/seo`

```json
{ "title": "Architecture Studio", "content": "Text from the page that has been authorized for this task." }
```

Returns `title`, `description`, and `keywords` as suggestions. Review facts, character limits, target language, and search intent before saving.

### 4. Translate content

`POST /api/v1/ai/translate`

```json
{ "targetLanguage": "fr-CA", "text": "Text that has been approved for external AI processing." }
```

Translation is a proposal and must preserve placeholders, legal notices, and brand terms according to project-specific rules.

### 5. Validate and preview

- `POST /api/v1/pages/validate` validates the document against the domain contract.
- `POST /api/v1/preview` returns safe server-rendered HTML. The response is no-store and carries a restrictive Content Security Policy.
- `POST /api/v1/pages/drafts` writes an explicitly reviewed draft when PostgreSQL and a site context are configured. `reviewed: true` is required for AI-generated proposals; publication is a separate capability-checked workflow.

Protected API routes use database-backed sessions or a server-side bearer session token when identity is configured. Cookie-authenticated unsafe methods require CSRF validation. The static `SYSTEMFABRIC_API_TOKEN` route is available only in non-production local development; production startup is guarded.

## Provider-neutral contract

Providers implement:

```js
provider.generate({
  system,
  input,
  schemaName,
  schema,
  maxOutputTokens
})
```

They return text. The AI service parses the JSON, validates and normalizes the document or task-specific response, records non-sensitive audit metadata, and returns an explicit status. Provider-native JSON schema features are useful but are not the validation boundary.

## MCP integration

Start the stdio server with `npm run start:mcp` after `npm install`. Available tools:

- `systemfabric_status`
- `systemfabric_list_widgets`
- `systemfabric_validate_page_document`
- `systemfabric_generate_page_draft`
- `systemfabric_render_preview`

The server intentionally omits publication, deletion, user administration, plugin installation, direct SQL, and arbitrary code execution tools. Tools used by an AI agent are API entry points and must enforce the same caller authorization as direct user requests. Do not expose stdio MCP through a public TCP endpoint. If a remote transport is introduced, add authentication, tenant context, scopes, request budgets, logs that omit secrets, and explicit action approvals first.

## AI workflow lifecycle

1. Collect a typed task request.
2. Verify caller/site access before retrieving any private context.
3. Apply data minimization and provider policy. Do not send external content unless the site policy allows it.
4. Separate trusted instructions from untrusted page text and imported content.
5. Invoke the selected provider with bounded input and output budgets.
6. Parse and validate the result; reject malformed data.
7. Store neither the prompt nor full completion in logs by default.
8. Return the result as a draft proposal.
9. Require a human review before persisting or publishing; publication will require a separate permission-aware domain operation.
10. Record provider/model/task/status/latency and token/character usage metadata where available.

## Safety and quality controls

- Model output is untrusted even if a provider claims structured output.
- Do not let a prompt select a provider, model, URL, SQL query, filesystem path, plugin, or tool permission.
- The model must not decide whether a user can access a site or publish a document.
- Retrieved content is context, not trusted instructions.
- AI-generated links, asset references, text lengths, widget types, node count, tree depth, and document versions are validated by domain code.
- Scripts, event handlers, arbitrary HTML blobs, and arbitrary JavaScript are not representable in the initial page-document contract.
- Destructive or externally visible actions must use action-specific approval bound to the exact target and arguments.
- Rate limits, output token limits, prompt size limits, and provider timeouts apply to each call.
- Retry only safe/idempotent provider requests; never retry a write action with unknown commit state.
- Provider refusal, timeout, or malformed output is surfaced as a safe error and never as partially generated content.

## Cost and privacy controls

A production AI gateway should enforce per-site daily/monthly budgets, per-user limits, model allow-lists, maximum tokens, request timeouts, provider failover rules, optional redaction, retention settings, and approved data-processing regions. Budget exhaustion should disable or degrade AI features without disabling ordinary rendering.

The current code records character count and latency; accurate token usage and persistent AI audit records need to be wired to provider usage metadata and PostgreSQL before production. OpenAI Responses and Gemini Interactions requests set `store:false` to opt out of response/interaction storage for later retrieval. This setting is not a guarantee of zero provider-side logging, abuse monitoring, or retention. Anthropic and third-party OpenAI-compatible gateways follow their own contracts and terms; review their current data retention controls before sending sensitive content.

## Evaluations

Every AI task should have fixtures for ordinary inputs, malformed inputs, injection-like input, long inputs, ambiguous requirements, unsupported widgets, and provider outage. Page generation evaluation should measure:

- Schema/domain validity rate.
- Unknown-widget rate (target 0%).
- unsafe URL / forbidden markup rejection.
- factual-claim review requirements.
- accessibility coverage for headings/alt text.
- human acceptance/edit distance.
- latency and estimated cost by provider/model.

Do not use a language model as the only evaluator for security boundaries. Deterministic validators and permission tests remain required.

## External API references

These contracts are provider-owned and may evolve. Verify current request schemas and model availability when upgrading an adapter:

- [OpenAI Responses API overview](https://developers.openai.com/api/reference/responses/overview)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [OWASP LLM Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
- [Gemini models](https://ai.google.dev/gemini-api/docs/models)
- [Anthropic model documentation](https://docs.anthropic.com/en/docs/about-claude/models/overview)


## AI in the 0.5.0 CMS workflow

AI tasks in this release are integrated as proposal-producing capabilities for page draft generation, content assist, SEO suggestions and translation. Generated page documents pass SystemFabric's independent runtime validation before a draft may be persisted, and the CMS publication workflow remains separate. Human review is required; provider-side structured output never replaces local validation.

The MCP server exposes only bounded status, widget catalog, page schema validation, draft proposal and preview tools. It does not expose publishing, role management, direct SQL, arbitrary shell access or plugin activation. Tool output is untrusted input when consumed by another agent.

`AI_ALLOW_EXTERNAL_CONTENT=false` blocks external provider content submission by default. Enabling it can send user-provided prompts/content to a third-party processor. Provider-side `store:false` settings, where available, are request-level storage opt-outs and do not imply zero server-side logging or retention. Prompt logs remain disabled by default; audit records should log operation/provider/result metadata rather than full content.

Future AI milestones include tenant-specific provider allowlists, per-site budgets/quotas, classification and redaction, approved prompt templates, evaluation/regression suites, provenance UI, prompt-injection red-team tests, model/version pinning policy, and administrator-facing retention settings. AI must never confer permissions, install/activate plugins, or publish without an explicitly authorized workflow action.


## 0.5.0 AI governance

SystemFabric includes site-level AI policy records for provider allowlists, enabling/disabling AI, external-content opt-in, maximum data classification, human-review requirement, and daily request/input-character budgets. Provider calls use both global configuration and site policy where database-backed site context is present. AI generation remains proposal-only: it cannot publish a page, grant a role, activate a plugin, or bypass the page-document schema.

The local tests verify core policy paths, but concurrent quota enforcement, provider billing reconciliation, all data-classification enforcement paths, and prompt-injection resistance still require live integration tests and review. `store: false` on a provider request is not a guarantee of zero provider-side logging or retention.
