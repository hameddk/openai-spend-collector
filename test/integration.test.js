import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  runCollector,
  flattenCompletionsUsage,
  flattenCosts,
  mergeUsageAndCost,
  OpenAiSpendError,
  OpenAiSpendConfigError,
  OpenAiSpendAuthError,
  OpenAiSpendRateLimitError,
  OpenAiSpendApiError,
} from '../src/index.js';
import { makeScriptedFetch, makeUsagePayload, makeCostsPayload, utcSec } from './_helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

describe('error class hierarchy', () => {
  it('all extend OpenAiSpendError and Error', () => {
    assert.ok(new OpenAiSpendConfigError('x') instanceof OpenAiSpendError);
    assert.ok(new OpenAiSpendAuthError('x') instanceof OpenAiSpendError);
    assert.ok(new OpenAiSpendRateLimitError('x') instanceof OpenAiSpendError);
    assert.ok(new OpenAiSpendApiError('x') instanceof OpenAiSpendError);
    assert.ok(new OpenAiSpendError('x') instanceof Error);
  });
});

describe('config validation', () => {
  it('errorType=config when args missing', async () => {
    const r = await runCollector();
    assert.equal(r.errorType, 'config');
  });

  it('errorType=config when apiKey missing', async () => {
    const r = await runCollector({ from: '2026-04-01', to: '2026-04-02' });
    assert.equal(r.errorType, 'config');
  });

  it('errorType=config on bad date format', async () => {
    const r = await runCollector({ apiKey: 'sk-test', from: '04/01/2026', to: '2026-04-02' });
    assert.equal(r.errorType, 'config');
  });

  it('errorType=config when from > to', async () => {
    const r = await runCollector({ apiKey: 'sk-test', from: '2026-04-10', to: '2026-04-01' });
    assert.equal(r.errorType, 'config');
  });
});

describe('flattenCompletionsUsage', () => {
  it('flattens fixture into per-(user, project, model) rows', () => {
    const rows = flattenCompletionsUsage(fixture('usage-completions-3day.json'));
    assert.equal(rows.length, 3);
    const aliceDay1 = rows.find((r) => r.user === 'user_alice' && r.date === '2028-04-01');
    assert.ok(aliceDay1);
    assert.equal(aliceDay1.tokens_input, 100000);
    assert.equal(aliceDay1.tokens_output, 40000);
  });

  it('accepts both `results` and `result` array names per OpenAI docs', () => {
    const rows = flattenCompletionsUsage({
      data: [
        {
          start_time: 1700000000,
          result: [{ user_id: 'u1', project_id: 'p1', model: 'm1', input_tokens: 10, output_tokens: 5 }],
        },
      ],
    });
    assert.equal(rows.length, 1);
  });

  it('handles missing token fields as zero', () => {
    const rows = flattenCompletionsUsage({
      data: [{ start_time: 1700000000, results: [{ user_id: 'u1' }] }],
    });
    assert.equal(rows[0].tokens_input, 0);
    assert.equal(rows[0].tokens_output, 0);
  });
});

describe('flattenCosts', () => {
  it('parses object-form amounts {value, currency}', () => {
    const rows = flattenCosts(fixture('costs-3day.json'));
    assert.equal(rows.length, 3);
    assert.equal(rows[0].costUsd, 8.5);
    assert.equal(rows[1].costUsd, 17.25);
    assert.equal(rows[2].costUsd, 1.2);
    assert.equal(rows[2].line_item, 'image_generation');
  });

  it('parses scalar-form amount fallback', () => {
    const rows = flattenCosts({
      data: [
        {
          start_time: 1700000000,
          results: [{ project_id: 'p1', amount: 5.5 }],
        },
      ],
    });
    assert.equal(rows[0].costUsd, 5.5);
  });

  it('skips rows with non-finite amounts', () => {
    const rows = flattenCosts({
      data: [
        {
          start_time: 1700000000,
          results: [
            { project_id: 'p1', amount: { value: 'NaN' } },
            { project_id: 'p1', amount: { value: 3 } },
          ],
        },
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].costUsd, 3);
  });
});

describe('mergeUsageAndCost', () => {
  it('distributes cost proportional to (input + output) tokens within (date, project)', () => {
    const usage = flattenCompletionsUsage(fixture('usage-completions-3day.json'));
    const costs = flattenCosts(fixture('costs-3day.json'));
    const merged = mergeUsageAndCost(usage, costs);

    // Day 1: alice 140k tokens, bob 40k. Total 180k. Cost $8.50.
    // alice: 8.5 * 140/180 = 6.611...
    // bob:   8.5 * 40/180  = 1.888...
    const day1Alice = merged.find((m) => m.date === '2028-04-01' && m.user === 'user_alice');
    const day1Bob = merged.find((m) => m.date === '2028-04-01' && m.user === 'user_bob');
    assert.ok(Math.abs(day1Alice.cost_usd - 8.5 * (140000 / 180000)) < 1e-9);
    assert.ok(Math.abs(day1Bob.cost_usd - 8.5 * (40000 / 180000)) < 1e-9);
    // Sum equals input cost.
    assert.ok(Math.abs(day1Alice.cost_usd + day1Bob.cost_usd - 8.5) < 1e-9);
  });

  it('emits aggregate row for cost-only buckets (e.g. image_generation day)', () => {
    const usage = flattenCompletionsUsage(fixture('usage-completions-3day.json'));
    const costs = flattenCosts(fixture('costs-3day.json'));
    const merged = mergeUsageAndCost(usage, costs);

    const day3 = merged.filter((m) => m.date === '2028-04-03');
    assert.equal(day3.length, 1);
    assert.equal(day3[0].user, null);
    assert.equal(day3[0].model, 'image_generation');
    assert.equal(day3[0].cost_usd, 1.2);
  });
});

describe('runCollector — happy path', () => {
  it('fetches both endpoints and emits merged rows', async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: fixture('usage-completions-3day.json') },
      { status: 200, body: fixture('costs-3day.json') },
    ]);
    const r = await runCollector({
      apiKey: 'sk-test',
      from: '2028-04-01',
      to: '2028-04-03',
      fetch,
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /usage\/completions/);
    assert.match(calls[1].url, /\/costs/);
    assert.equal(r.meta.via, 'costs+usage_completions');
    assert.equal(r.meta.pages_fetched, 2);
  });

  it('passes OpenAI-Organization header when organizationId provided', async () => {
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: makeUsagePayload([]) },
      { status: 200, body: makeCostsPayload([]) },
    ]);
    await runCollector({
      apiKey: 'sk-test',
      organizationId: 'org-fake',
      from: '2028-04-01',
      to: '2028-04-03',
      fetch,
    });
    for (const c of calls) {
      assert.equal(c.options.headers['OpenAI-Organization'], 'org-fake');
    }
  });

  it('emits warning when costs endpoint fails but usage succeeds', async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: fixture('usage-completions-3day.json') },
      { status: 500, body: 'internal' },
    ]);
    const r = await runCollector({
      apiKey: 'sk-test',
      from: '2028-04-01',
      to: '2028-04-03',
      fetch,
    });
    assert.equal(r.ok, true);
    assert.equal(r.meta.warnings.length, 1);
    assert.match(r.meta.warnings[0], /costs failed/);
  });
});

describe('runCollector — error mapping', () => {
  it('401 → errorType=auth with admin key hint', async () => {
    const { fetch } = makeScriptedFetch([{ status: 401, body: { error: 'invalid' } }]);
    const r = await runCollector({
      apiKey: 'sk-test',
      from: '2028-04-01',
      to: '2028-04-02',
      fetch,
    });
    assert.equal(r.errorType, 'auth');
    assert.match(r.error, /Admin API key/);
  });

  it('429 → errorType=rate_limit', async () => {
    const { fetch } = makeScriptedFetch([{ status: 429, body: 'rate' }]);
    const r = await runCollector({
      apiKey: 'sk-test',
      from: '2028-04-01',
      to: '2028-04-02',
      fetch,
    });
    assert.equal(r.errorType, 'rate_limit');
  });

  it('costs 401 → errorType=auth (auth is fatal even when usage succeeded)', async () => {
    const { fetch } = makeScriptedFetch([
      { status: 200, body: fixture('usage-completions-3day.json') },
      { status: 401, body: { error: 'invalid' } },
    ]);
    const r = await runCollector({
      apiKey: 'sk-test',
      from: '2028-04-01',
      to: '2028-04-03',
      fetch,
    });
    assert.equal(r.errorType, 'auth');
  });

  it('network error → errorType=network', async () => {
    const { fetch } = makeScriptedFetch([{ throws: new Error('ECONNREFUSED') }]);
    const r = await runCollector({
      apiKey: 'sk-test',
      from: '2028-04-01',
      to: '2028-04-02',
      fetch,
    });
    assert.equal(r.errorType, 'network');
  });

  it('non-JSON → errorType=parse', async () => {
    const { fetch } = makeScriptedFetch([{ status: 200, body: '<html>x</html>' }]);
    const r = await runCollector({
      apiKey: 'sk-test',
      from: '2028-04-01',
      to: '2028-04-02',
      fetch,
    });
    assert.equal(r.errorType, 'parse');
  });
});
