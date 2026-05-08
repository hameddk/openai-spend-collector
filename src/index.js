/**
 * @hameddk/openai-spend-collector — pull real spend + token usage from
 * OpenAI's organization Costs and Usage APIs.
 *
 * Pure data-fetcher. Caller supplies the Admin API key.
 * No DB, no filesystem, no business logic.
 */

const DEFAULT_BASE = 'https://api.openai.com';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OpenAiSpendError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'OpenAiSpendError';
    if (cause) this.cause = cause;
  }
}

export class OpenAiSpendConfigError extends OpenAiSpendError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'OpenAiSpendConfigError';
  }
}

export class OpenAiSpendAuthError extends OpenAiSpendError {
  constructor(message, { status, body, cause } = {}) {
    super(message, { cause });
    this.name = 'OpenAiSpendAuthError';
    this.status = status;
    this.body = body;
  }
}

export class OpenAiSpendRateLimitError extends OpenAiSpendError {
  constructor(message, { retryAfter, body, cause } = {}) {
    super(message, { cause });
    this.name = 'OpenAiSpendRateLimitError';
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

export class OpenAiSpendApiError extends OpenAiSpendError {
  constructor(message, { status, body, cause } = {}) {
    super(message, { cause });
    this.name = 'OpenAiSpendApiError';
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_KEY_HINT =
  'OpenAI Admin API key required (Settings → Organization → Admin keys). Standard API keys cannot read organization usage or costs.';

function isoDateOnly(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s));
}

function startOfUtcDayUnix(isoDate) {
  return Math.floor(Date.parse(`${isoDate}T00:00:00.000Z`) / 1000);
}

function endOfUtcDayUnixExclusive(isoDate) {
  const ts = Date.parse(`${isoDate}T00:00:00.000Z`) + 86400 * 1000;
  return Math.floor(ts / 1000);
}

function inclusiveDaySpan(fromStr, toStr) {
  const a = Date.parse(`${fromStr}T00:00:00.000Z`);
  const b = Date.parse(`${toStr}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.floor((b - a) / 86400000) + 1);
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function utcDateFromUnixSec(sec) {
  return new Date(Number(sec) * 1000).toISOString().slice(0, 10);
}

function classifyHttpError(status, body, endpoint) {
  if (status === 401 || status === 403) {
    return new OpenAiSpendAuthError(
      `OpenAI auth failed (${status}) calling ${endpoint}. ${ADMIN_KEY_HINT}`,
      { status, body }
    );
  }
  if (status === 429) {
    return new OpenAiSpendRateLimitError(`OpenAI rate limited (${status}) calling ${endpoint}`, {
      retryAfter: null,
      body,
    });
  }
  return new OpenAiSpendApiError(`OpenAI API error ${status} calling ${endpoint}`, {
    status,
    body,
  });
}

// ---------------------------------------------------------------------------
// Core fetchers (paginated)
// ---------------------------------------------------------------------------

async function fetchAllPages(url, headers, fetchImpl, endpointLabel) {
  const merged = { data: [] };
  const base = new URL(url.toString());
  let cursor = null;
  let pages = 0;

  for (;;) {
    const u = new URL(base.toString());
    if (cursor) u.searchParams.set('page', cursor);

    let res;
    try {
      res = await fetchImpl(u.toString(), { method: 'GET', headers });
    } catch (cause) {
      throw new OpenAiSpendApiError(`Network error calling ${endpointLabel}: ${cause.message}`, {
        cause,
      });
    }

    pages++;
    const text = await safeReadText(res);

    if (!res.ok) {
      throw classifyHttpError(res.status, text, endpointLabel);
    }

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (cause) {
      throw new OpenAiSpendApiError(`${endpointLabel} returned non-JSON (${res.status})`, {
        status: res.status,
        body: text,
        cause,
      });
    }

    if (Array.isArray(payload.data)) merged.data.push(...payload.data);
    cursor = payload.next_page || null;
    if (!cursor) break;
  }

  return { payload: merged, pages };
}

function buildCompletionsUsageUrl(baseUrl, from, to) {
  const startTime = startOfUtcDayUnix(from);
  const endTime = endOfUtcDayUnixExclusive(to);
  const spanDays = inclusiveDaySpan(from, to);
  const limit = Math.min(31, Math.max(1, spanDays));

  const url = new URL(`${baseUrl}/v1/organization/usage/completions`);
  url.searchParams.set('start_time', String(startTime));
  url.searchParams.set('end_time', String(endTime));
  url.searchParams.set('bucket_width', '1d');
  url.searchParams.set('limit', String(limit));
  url.searchParams.append('group_by', 'user_id');
  url.searchParams.append('group_by', 'project_id');
  url.searchParams.append('group_by', 'model');
  return url;
}

function buildCostsUrl(baseUrl, from, to) {
  const startTime = startOfUtcDayUnix(from);
  const endTime = endOfUtcDayUnixExclusive(to);
  const spanDays = inclusiveDaySpan(from, to);
  const limit = Math.min(31, Math.max(1, spanDays));

  const url = new URL(`${baseUrl}/v1/organization/costs`);
  url.searchParams.set('start_time', String(startTime));
  url.searchParams.set('end_time', String(endTime));
  url.searchParams.set('bucket_width', '1d');
  url.searchParams.set('limit', String(limit));
  url.searchParams.append('group_by', 'project_id');
  return url;
}

// ---------------------------------------------------------------------------
// Row extraction
// ---------------------------------------------------------------------------

/** Pull `results` array from a bucket, accepting either `results` or `result`. */
function bucketResults(bucket) {
  if (Array.isArray(bucket?.results)) return bucket.results;
  if (Array.isArray(bucket?.result)) return bucket.result;
  return [];
}

/**
 * Convert usage/completions buckets to flat rows.
 * @returns {Array<{date: string, user: string|null, project: string|null, model: string|null, tokens_input: number, tokens_output: number, raw: object}>}
 */
export function flattenCompletionsUsage(payload) {
  const out = [];
  const buckets = Array.isArray(payload?.data) ? payload.data : [];
  for (const bucket of buckets) {
    const startSec = bucket?.start_time;
    if (startSec == null) continue;
    const date = utcDateFromUnixSec(startSec);
    for (const r of bucketResults(bucket)) {
      out.push({
        date,
        user: r?.user_id ?? null,
        project: r?.project_id ?? null,
        model: r?.model ?? null,
        tokens_input: Number(r?.input_tokens ?? r?.n_context_tokens ?? 0) || 0,
        tokens_output: Number(r?.output_tokens ?? r?.n_generated_tokens ?? 0) || 0,
        raw: r,
      });
    }
  }
  return out;
}

/**
 * Convert costs buckets to flat rows.
 * The OpenAI costs endpoint returns `amount: { value: number, currency: 'usd' }`.
 * @returns {Array<{date: string, project: string|null, line_item: string|null, costUsd: number, raw: object}>}
 */
export function flattenCosts(payload) {
  const out = [];
  const buckets = Array.isArray(payload?.data) ? payload.data : [];
  for (const bucket of buckets) {
    const startSec = bucket?.start_time;
    if (startSec == null) continue;
    const date = utcDateFromUnixSec(startSec);
    for (const r of bucketResults(bucket)) {
      const amount = r?.amount;
      let value = null;
      if (amount && typeof amount === 'object') {
        value = Number(amount.value);
      } else if (amount != null) {
        value = Number(amount);
      }
      if (!Number.isFinite(value)) continue;
      out.push({
        date,
        project: r?.project_id ?? null,
        line_item: r?.line_item ?? null,
        costUsd: value,
        raw: r,
      });
    }
  }
  return out;
}

/**
 * Merge usage rows (per user+project+model) with cost rows (per project).
 *
 * For each (date, project) bucket, distribute cost across that bucket's
 * usage rows proportional to total tokens. Cost-only buckets with no usage
 * data emit a single aggregate row.
 */
export function mergeUsageAndCost(usageRows, costRows) {
  const byBucket = new Map();
  for (const u of usageRows) {
    const key = `${u.date}|${u.project ?? ''}`;
    const arr = byBucket.get(key) ?? [];
    arr.push(u);
    byBucket.set(key, arr);
  }

  const merged = usageRows.map((u) => ({
    date: u.date,
    user: u.user,
    project: u.project,
    model: u.model,
    tokens_input: u.tokens_input,
    tokens_output: u.tokens_output,
    cost_usd: null,
    raw: { usage: u.raw },
  }));

  for (const c of costRows) {
    const key = `${c.date}|${c.project ?? ''}`;
    const wsRows = byBucket.get(key) ?? [];
    const totalTokens = wsRows.reduce((s, r) => s + r.tokens_input + r.tokens_output, 0);

    if (totalTokens === 0 || wsRows.length === 0) {
      merged.push({
        date: c.date,
        user: null,
        project: c.project,
        model: c.line_item || 'aggregate',
        tokens_input: 0,
        tokens_output: 0,
        cost_usd: c.costUsd,
        raw: { cost: c.raw },
      });
      continue;
    }

    for (const r of wsRows) {
      const idx = merged.findIndex(
        (m) =>
          m.date === r.date &&
          m.project === r.project &&
          m.user === r.user &&
          m.model === r.model
      );
      if (idx < 0) continue;
      const share = (r.tokens_input + r.tokens_output) / totalTokens;
      const portion = c.costUsd * share;
      merged[idx].cost_usd = (merged[idx].cost_usd ?? 0) + portion;
      merged[idx].raw.cost = c.raw;
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CollectorRow
 * @property {string} date
 * @property {string|null} identity         User ID, or null for project-aggregate rows.
 * @property {'user_id'|'aggregate'} identityType
 * @property {string|null} tool             Model name (or `line_item` for aggregate rows).
 * @property {number} tokens_input
 * @property {number} tokens_output
 * @property {number|null} cost_usd
 * @property {number} session_minutes       Always 0 for this collector.
 * @property {object} raw
 */

/**
 * @typedef {Object} RunArgs
 * @property {string} apiKey
 * @property {string} from                  ISO YYYY-MM-DD (UTC, inclusive).
 * @property {string} to                    ISO YYYY-MM-DD (UTC, inclusive).
 * @property {string} [organizationId]      Optional `OpenAI-Organization` header.
 * @property {string} [baseUrl]             Override OpenAI host (testing only).
 * @property {typeof fetch} [fetch]         Override fetch (testing only).
 */

/**
 * Run the collector for a date range.
 *
 * @param {RunArgs} args
 */
export async function runCollector(args) {
  try {
    if (!args || typeof args !== 'object') {
      throw new OpenAiSpendConfigError('runCollector: args object is required');
    }
    if (!args.apiKey || typeof args.apiKey !== 'string') {
      throw new OpenAiSpendConfigError('apiKey is required');
    }
    if (!isoDateOnly(args.from)) {
      throw new OpenAiSpendConfigError('from must be ISO YYYY-MM-DD');
    }
    if (!isoDateOnly(args.to)) {
      throw new OpenAiSpendConfigError('to must be ISO YYYY-MM-DD');
    }
    if (args.from > args.to) {
      throw new OpenAiSpendConfigError(`from (${args.from}) must be <= to (${args.to})`);
    }
  } catch (err) {
    if (err instanceof OpenAiSpendConfigError) {
      return { ok: false, error: err.message, errorType: 'config' };
    }
    throw err;
  }

  const fetchImpl = args.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      error: 'fetch is not a function (and globalThis.fetch is unavailable)',
      errorType: 'config',
    };
  }

  const baseUrl = (args.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${args.apiKey.trim()}`,
    Accept: 'application/json',
  };
  if (args.organizationId) headers['OpenAI-Organization'] = args.organizationId;

  const warnings = [];
  let totalPages = 0;

  let usagePayload;
  try {
    const url = buildCompletionsUsageUrl(baseUrl, args.from, args.to);
    const r = await fetchAllPages(url, headers, fetchImpl, 'usage/completions');
    usagePayload = r.payload;
    totalPages += r.pages;
  } catch (err) {
    return mapErrorToResult(err);
  }

  let costPayload;
  try {
    const url = buildCostsUrl(baseUrl, args.from, args.to);
    const r = await fetchAllPages(url, headers, fetchImpl, 'costs');
    costPayload = r.payload;
    totalPages += r.pages;
  } catch (err) {
    if (err instanceof OpenAiSpendAuthError) {
      return mapErrorToResult(err);
    }
    warnings.push(`costs failed: ${err.message}; rows will have cost_usd: null`);
    costPayload = { data: [] };
  }

  const usageRows = flattenCompletionsUsage(usagePayload);
  const costRows = flattenCosts(costPayload);
  const merged = mergeUsageAndCost(usageRows, costRows);

  const rows = merged.map((m) => ({
    date: m.date,
    identity: m.user,
    identityType: m.user ? 'user_id' : 'aggregate',
    tool: m.model,
    tokens_input: m.tokens_input,
    tokens_output: m.tokens_output,
    cost_usd: m.cost_usd,
    session_minutes: 0,
    raw: m.raw,
    project: m.project,
  }));

  return {
    ok: true,
    rows,
    meta: {
      via: 'costs+usage_completions',
      pages_fetched: totalPages,
      warnings,
    },
  };
}

function mapErrorToResult(err) {
  if (err instanceof OpenAiSpendAuthError) {
    return { ok: false, error: err.message, errorType: 'auth' };
  }
  if (err instanceof OpenAiSpendRateLimitError) {
    return { ok: false, error: err.message, errorType: 'rate_limit' };
  }
  if (err instanceof OpenAiSpendApiError) {
    if (err.status === 404) return { ok: false, error: err.message, errorType: 'not_found' };
    if (/^Network error/.test(err.message)) {
      return { ok: false, error: err.message, errorType: 'network' };
    }
    return { ok: false, error: err.message, errorType: 'parse' };
  }
  return { ok: false, error: err.message || String(err), errorType: 'network' };
}
