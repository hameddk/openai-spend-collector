/**
 * Shared test utilities. Not a test file.
 */

export function makeScriptedFetch(script) {
  const queue = [...script];
  const calls = [];
  async function fetchImpl(url, options) {
    calls.push({ url, options });
    const next = queue.shift();
    if (!next) {
      throw new Error(`scripted fetch exhausted at call #${calls.length} (${url})`);
    }
    if (typeof next === 'function') return next({ url, options });
    if (next.throws) throw next.throws;
    const bodyText = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
    return makeResponse(next.status ?? 200, bodyText, next.headers);
  }
  return { fetch: fetchImpl, calls, queue };
}

function makeResponse(status, bodyText, extraHeaders) {
  const map = new Map(Object.entries(extraHeaders || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => map.get(String(n).toLowerCase()) ?? null },
    async text() {
      return bodyText;
    },
  };
}

export function utcSec(isoDate) {
  return Math.floor(Date.parse(`${isoDate}T00:00:00.000Z`) / 1000);
}

export function makeUsagePayload(buckets, nextPage = null) {
  return {
    data: buckets.map((b) => ({
      start_time: utcSec(b.date),
      end_time: utcSec(b.date) + 86400,
      results: (b.results || []).map((r) => ({
        user_id: r.user ?? null,
        project_id: r.project ?? null,
        model: r.model ?? null,
        input_tokens: r.in ?? 0,
        output_tokens: r.out ?? 0,
      })),
    })),
    next_page: nextPage,
  };
}

export function makeCostsPayload(buckets, nextPage = null) {
  return {
    data: buckets.map((b) => ({
      start_time: utcSec(b.date),
      end_time: utcSec(b.date) + 86400,
      results: (b.results || []).map((r) => ({
        project_id: r.project ?? null,
        line_item: r.line_item ?? null,
        amount: { value: r.amount, currency: 'usd' },
      })),
    })),
    next_page: nextPage,
  };
}
