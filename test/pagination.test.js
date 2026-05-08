import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runCollector } from '../src/index.js';
import { makeScriptedFetch, makeUsagePayload, makeCostsPayload } from './_helpers.js';

describe('pagination — multi-page cursor handling', () => {
  it('follows next_page cursor and concatenates data', async () => {
    const page1 = makeUsagePayload(
      [{ date: '2028-04-01', results: [{ user: 'u1', project: 'p1', model: 'm1', in: 100, out: 50 }] }],
      'cursor-2'
    );
    const page2 = makeUsagePayload(
      [{ date: '2028-04-02', results: [{ user: 'u1', project: 'p1', model: 'm1', in: 200, out: 100 }] }],
      null
    );
    const { fetch, calls } = makeScriptedFetch([
      { status: 200, body: page1 },
      { status: 200, body: page2 },
      { status: 200, body: makeCostsPayload([]) },
    ]);
    const r = await runCollector({
      apiKey: 'sk-test',
      from: '2028-04-01',
      to: '2028-04-02',
      fetch,
    });
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 2);
    assert.equal(r.meta.pages_fetched, 3);
    assert.match(calls[1].url, /page=cursor-2/);
  });

  it('handles 90+ day range with multiple pages on both endpoints', async () => {
    const days = [];
    const start = Date.parse('2028-04-01T00:00:00Z');
    for (let d = 0; d < 90; d++) {
      days.push(new Date(start + d * 86400000).toISOString().slice(0, 10));
    }

    const usagePages = [];
    for (let p = 0; p < 4; p++) {
      const slice = days.slice(p * 23, (p + 1) * 23);
      const last = p === 3;
      usagePages.push(
        makeUsagePayload(
          slice.map((date) => ({
            date,
            results: [{ user: 'u1', project: 'p1', model: 'gpt-4', in: 1000, out: 500 }],
          })),
          last ? null : `usage-cursor-${p + 1}`
        )
      );
    }

    const costPages = [];
    for (let p = 0; p < 4; p++) {
      const slice = days.slice(p * 23, (p + 1) * 23);
      const last = p === 3;
      costPages.push(
        makeCostsPayload(
          slice.map((date) => ({
            date,
            results: [{ project: 'p1', line_item: 'completions', amount: 2.0 }],
          })),
          last ? null : `cost-cursor-${p + 1}`
        )
      );
    }

    const { fetch } = makeScriptedFetch([
      ...usagePages.map((p) => ({ status: 200, body: p })),
      ...costPages.map((p) => ({ status: 200, body: p })),
    ]);

    const r = await runCollector({
      apiKey: 'sk-test',
      from: '2028-04-01',
      to: '2028-06-29',
      fetch,
    });
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 90);
    assert.equal(r.meta.pages_fetched, 8);

    const totalCost = r.rows.reduce((s, row) => s + (row.cost_usd ?? 0), 0);
    assert.ok(Math.abs(totalCost - 90 * 2.0) < 1e-6);
  });
});
