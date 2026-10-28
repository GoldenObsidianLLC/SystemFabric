# EnginEx evaluations

`node evals/run.js` runs a deterministic, provider-free evaluation of parser behavior, escaping, safe expression restrictions, and security diagnostics.

`node evals/live-ai.js` sends an adversarial template-generation task to the configured OpenAI provider. This can incur charges and sends the task/schema to the provider. It should be run across model/version upgrades and repeated samples. A passing sample is not proof of security or prompt-injection resistance.

For broader evaluation, add fixtures derived from real templates with permission to use them. Include malformed Unicode/delimiters, schema changes, unknown helpers, excessive nesting, raw HTML, URLs, script/style contexts, prompt injection, and provider refusal/partial outputs. Measure generation validity, diagnostics repair success, output fixture parity, latency, and token/provider cost. Never include real PII or secrets in model eval prompts.
