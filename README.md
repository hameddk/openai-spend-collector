# @hameddk/openai-spend-collector

Pull **real spend** and **token usage** from OpenAI's organization
Costs and Usage APIs. Joins per-project cost data with per-user token
counts into a single normalized row stream.

- Calls `/v1/organization/costs` for USD spend (no pricing-table guesses)
- Calls `/v1/organization/usage/completions` for token counts per user/model
- Cursor-based pagination; tested across 90+ day ranges
- Caller supplies the Admin API key — no DB, no filesystem, no business logic
- Zero dependencies, ESM, Node ≥ 18

> Status: 0.1.0 — early. Public API is stable for the documented surface.

## Why

Most OpenAI usage tooling either reads token counts and *guesses* cost from
a pricing table, or reads bulk cost without per-user attribution. This
collector calls **both** Admin endpoints and merges them so you get real USD
spend broken down by user and model.

## Install

```bash
npm install @hameddk/openai-spend-collector
```

## Quick start

```js
import { runCollector } from '@hameddk/openai-spend-collector';

const result = await runCollector({
  apiKey: process.env.OPENAI_ADMIN_KEY,
  organizationId: 'org-…',          // optional
  from: '2026-04-01',
  to:   '2026-04-30',
});

if (!result.ok) {
  console.error(`[${result.errorType}] ${result.error}`);
  process.exit(1);
}

for (const row of result.rows) {
  console.log(`${row.date}  ${row.identity}  ${row.tool}  $${row.cost_usd?.toFixed(4)}`);
}
```

## API

```js
runCollector({
  apiKey: string,             // required — Admin API key
  from: 'YYYY-MM-DD',         // required — UTC inclusive
  to:   'YYYY-MM-DD',         // required — UTC inclusive
  organizationId?: string,    // optional — sets OpenAI-Organization header
  baseUrl?: string,           // testing only
  fetch?: typeof fetch,       // testing only
})
```

### Success result

```ts
{
  ok: true,
  rows: Array<{
    date: 'YYYY-MM-DD',
    identity: string | null,        // user_id, or null for project-aggregate rows
    identityType: 'user_id' | 'aggregate',
    tool: string,                   // model, or line_item ('image_generation', etc.)
    tokens_input: number,
    tokens_output: number,
    cost_usd: number | null,        // null only when costs endpoint failed (warning emitted)
    session_minutes: 0,
    project: string | null,         // project_id passthrough
    raw: { usage?: ..., cost?: ... }
  }>,
  meta: {
    via: 'costs+usage_completions',
    pages_fetched: number,
    warnings: string[],
  }
}
```

### Error result

```ts
{
  ok: false,
  error: string,
  errorType: 'auth' | 'rate_limit' | 'not_found' | 'network' | 'parse' | 'config',
}
```

## Cost attribution heuristic

`/v1/organization/costs` returns USD totals **per project** (and per
`line_item`). `/v1/organization/usage/completions` returns token counts
**per user, project, and model**.

To produce per-user cost rows, the collector distributes each
`(date, project)` cost across that bucket's usage rows proportional to
`tokens_input + tokens_output`. The sum of distributed costs equals the
original cost row exactly.

`line_item`-only buckets (e.g. `image_generation`) with no token usage
in `/v1/organization/usage/completions` emit a single aggregate row with
`identity: null`, `tokens_input: 0`, and the line_item as `tool`.

If you need different attribution, apply your own logic to the returned
rows — the raw `costs` and `usage` payloads are preserved on `row.raw`.

## v0.1.0 scope and v0.2.0 backlog

The completions endpoint covers Chat Completions + Responses API usage,
which is the bulk of most OpenAI bills. Other usage surfaces — Images,
Audio, Embeddings, Vector Stores, Code Interpreter Sessions, Moderations
— are **not** queried in v0.1.0. Their **cost** is still captured by
`/v1/organization/costs` (which sums all line items), so total spend is
correct; only the per-user/per-model breakdown is missing for those
surfaces.

v0.2.0 will add optional collection of those surfaces. Track:
[backlog issue placeholder].

## Authentication

Requires an OpenAI **Admin API key**, created from
**Settings → Organization → Admin keys**. Standard API keys (`sk-…` for
inference) do not have access to organization usage or cost endpoints —
they return 401, which this collector surfaces as `errorType: 'auth'`.

## Pagination

Both endpoints use a `next_page` cursor. The collector follows it
transparently. Tested with 90-day ranges spanning 4+ pages per endpoint —
see `test/pagination.test.js`.

## Errors

```js
import {
  OpenAiSpendError,           // base
  OpenAiSpendConfigError,     // bad args
  OpenAiSpendAuthError,       // 401/403
  OpenAiSpendRateLimitError,  // 429
  OpenAiSpendApiError,        // other HTTP / parse failures
} from '@hameddk/openai-spend-collector';
```

## Testing hooks

For testing only:

```js
runCollector({
  ...,
  baseUrl: 'http://localhost:8080',
  fetch: customFetch,
})
```

## What this library does **not** do

- Doesn't write to a database — return value is rows; persist them yourself.
- Doesn't translate user IDs or project IDs to display names — your adapter does.
- Doesn't fall back to local pricing tables — `cost_usd` is real or `null`.
- Doesn't synthesize "team aggregate split across N developers" rows when
  only project-level data exists.

## License

MIT © 2026 Hamed Sattari
