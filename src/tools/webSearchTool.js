// ================================================================
// FILE: src/tools/webSearchTool.js
// PURPOSE: Register the `web_search` tool.
//
// Behavior:
//   1. Reads the configured search provider + key from config.
//   2. Runs the primary provider (e.g. Brave) if a key is present.
//   3. Falls back to keyless DuckDuckGo when:
//        - the provider needs a key but none is configured, OR
//        - the primary provider fails (rate limit / network / 5xx).
//   4. Always returns a STRING (never throws) so the agent loop keeps
//      going and can react to the failure.
//
// Output contract: a human-readable list of
//   title / url / snippet  results (normalized across providers).
// ================================================================

import { registerTool } from './ToolRegistry.js';
import { getProvider, SearchError } from './web/searchProviders.js';
import { DEFAULT_USER_AGENT } from './web/httpClient.js';

const DEFAULT_RESULTS = 5;
const DEFAULT_SEARCH_TIMEOUT = 15000;

// Small helper so config may be either a raw getter or a plain object.
function readConfig(config, key) {
  if (!config) return undefined;
  if (typeof config.get === 'function') return config.get(key);
  return config[key];
}


// ─────────────────────────────────────────────────────────────
// registerWebSearchTools(registry, config, runtime)
// `runtime` : optional { cache, logger, ssrf, limits } from
//             createWebRuntime(). Enables result caching + logging.
// ─────────────────────────────────────────────────────────────
export function registerWebSearchTools(registry, config, runtime = null) {
  const cache = runtime?.cache || null;
  const logger = runtime?.logger || null;

  // ━━━━━━━━━━━━━━━━ TOOL: web_search ━━━━━━━━━━━━━━━━
  registerTool(registry, 'web_search', {
    description: 'Search the public web for up-to-date information (docs, errors, libraries, news). Returns a ranked list of results with title, url and snippet. Use this when you need information that is not in the local repository. To read a full page, follow up with web_crawl on a result url.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query (e.g., "node.js fetch retry backoff example").',
        },
        maxResults: {
          type: 'number',
          description: `How many results to return (default: ${DEFAULT_RESULTS}, max: 20).`,
        },
        provider: {
          type: 'string',
          description: 'Optional override for this call: "brave" | "tavily" | "serpapi" | "google" | "duckduckgo".',
        },
      },
      required: ['query'],
    },
  }, async ({ query, maxResults = DEFAULT_RESULTS, provider }) => {

    if (!query || !String(query).trim()) {
      return '❌ web_search requires a non-empty "query".';
    }

    const cleanQuery = String(query).trim();
    const limit = Math.max(1, Math.min(Number(maxResults) || DEFAULT_RESULTS, 20));

    // Build the run options from config (with sensible defaults).
    const options = {
      apiKey: readConfig(config, 'searchApiKey') || '',
      timeout: Number(readConfig(config, 'searchTimeout')) || DEFAULT_SEARCH_TIMEOUT,
      userAgent: readConfig(config, 'crawlerUserAgent') || DEFAULT_USER_AGENT,
      limit,
    };

    // Which provider should we try first?
    const configuredName = provider || readConfig(config, 'searchProvider') || 'duckduckgo';
    const primary = getProvider(configuredName);

    // ── Cache: identical query + provider + limit is free within the TTL. ──
    const cacheKey = JSON.stringify({ query: cleanQuery, provider: primary.name, limit });
    if (cache && cache.enabled) {
      const cached = cache.get('search', cacheKey);
      if (cached) {
        if (logger) {
          logger.record({ type: 'search', query: cleanQuery, provider: primary.name, ok: true, fromCache: true });
        }
        return formatResults(cleanQuery, `${cached.providerLabel} (cached)`, cached.results, []);
      }
    }

    const timer = logger ? logger.startTimer() : null;
    const attempts = [];

    // ── Attempt 1: the configured provider (skip if it needs a key we lack) ──
    if (primary.requiresKey && !options.apiKey) {
      attempts.push({
        skipped: true,
        label: primary.label,
        reason: 'no API key configured',
      });
    } else {
      const result = await tryProvider(primary, cleanQuery, options);
      if (result.ok) {
        storeSearch(cache, cacheKey, primary.label, result.results);
        logSearch(logger, timer, cleanQuery, primary.name, true, null);
        return formatResults(cleanQuery, primary.label, result.results, attempts);
      }
      attempts.push({ label: primary.label, reason: result.message });
    }

    // ── Attempt 2: fall back to keyless DuckDuckGo (unless it WAS the primary) ──
    if (primary.name !== 'duckduckgo') {
      const fallback = getProvider('duckduckgo');
      const result = await tryProvider(fallback, cleanQuery, options);
      if (result.ok) {
        storeSearch(cache, cacheKey, `${fallback.label} (fallback)`, result.results);
        logSearch(logger, timer, cleanQuery, fallback.name, true, null);
        return formatResults(cleanQuery, `${fallback.label} (fallback)`, result.results, attempts);
      }
      attempts.push({ label: fallback.label, reason: result.message });
    }

    // ── Everything failed → structured error string ──
    logSearch(logger, timer, cleanQuery, primary.name, false, attempts.map((a) => a.reason).join('; '));
    return formatFailure(cleanQuery, attempts);
  });
}


// ─────────────────────────────────────────────────────────────
// storeSearch(cache, key, providerLabel, results)
// Persists a successful search (results + the label to redisplay).
// ─────────────────────────────────────────────────────────────
function storeSearch(cache, key, providerLabel, results) {
  if (!cache || !cache.enabled) return;
  cache.set('search', key, { providerLabel, results });
}


// ─────────────────────────────────────────────────────────────
// logSearch(logger, timer, query, provider, ok, error)
// Best-effort search log entry with duration.
// ─────────────────────────────────────────────────────────────
function logSearch(logger, timer, query, provider, ok, error) {
  if (!logger) return;
  logger.record({
    type: 'search',
    query,
    provider,
    ok,
    error: error || undefined,
    durationMs: timer ? timer() : undefined,
  });
}


// ─────────────────────────────────────────────────────────────
// tryProvider(provider, query, options)
// Runs one provider and never throws.
// Returns { ok: true, results } or { ok: false, message }.
// ─────────────────────────────────────────────────────────────
async function tryProvider(provider, query, options) {
  try {
    const results = await provider.search(query, options);
    if (!results || results.length === 0) {
      return { ok: false, message: 'no results returned' };
    }
    return { ok: true, results };
  } catch (error) {
    const message = error instanceof SearchError
      ? `${error.code}: ${error.message}`
      : error.message;
    return { ok: false, message };
  }
}


// ─────────────────────────────────────────────────────────────
// formatResults(query, providerLabel, results, attempts)
// Renders the normalized results as a readable block.
// ─────────────────────────────────────────────────────────────
function formatResults(query, providerLabel, results, attempts) {
  const lines = results.map((r, i) => {
    const parts = [
      `${i + 1}. ${r.title}`,
      `   ${r.url}`,
    ];
    if (r.snippet) parts.push(`   ${truncate(r.snippet, 300)}`);
    return parts.join('\n');
  });

  let out = `🔎 Web results for "${query}" via ${providerLabel}:\n\n${lines.join('\n\n')}`;

  // Note any providers we skipped/failed along the way.
  const notes = attempts
    .filter((a) => a.reason)
    .map((a) => `  • ${a.label}: ${a.reason}`)
    .join('\n');

  if (notes) {
    out += `\n\nℹ️  Provider notes:\n${notes}`;
  }

  return out;
}


// ─────────────────────────────────────────────────────────────
// formatFailure(query, attempts)
// Structured error string returned when every provider failed.
// ─────────────────────────────────────────────────────────────
function formatFailure(query, attempts) {
  const detail = attempts.length
    ? attempts.map((a) => `  • ${a.label}: ${a.reason}`).join('\n')
    : '  • No provider was available.';

  return [
    `❌ web_search failed for "${query}".`,
    '',
    'Attempts:',
    detail,
    '',
    'Suggestions:',
    '  • Retry in a moment (the provider may be rate limiting).',
    '  • Configure a search API key: qtpi config (searchProvider + searchApiKey).',
    '  • Or proceed without web search and rely on the local repository.',
  ].join('\n');
}


function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
