// ================================================================
// FILE: src/tools/web/searchProviders.js
// PURPOSE: Provider abstraction for web_search.
//
// Every provider takes (query, options) and resolves to a NORMALIZED
// array of results:  [{ title, url, snippet }]
//
// Supported backends:
//   - brave       (real API, requires key)  ← recommended primary
//   - tavily      (real API, requires key)
//   - serpapi     (real API, requires key)
//   - google      (Google CSE, requires key + engine id)
//   - duckduckgo  (HTML endpoint, NO key — zero-config fallback)
//
// Providers throw `SearchError` on failure; the tool layer converts
// that into a friendly structured string.
// ================================================================

import * as cheerio from 'cheerio';
import { fetchWithRetry, DEFAULT_USER_AGENT } from './httpClient.js';


// ─────────────────────────────────────────────────────────────
// SearchError
// A tagged error so the tool layer can distinguish "missing key"
// from "rate limited" from "network down" when writing its message.
// ─────────────────────────────────────────────────────────────
export class SearchError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR', status = null } = {}) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
    this.status = status;
  }
}


// ─────────────────────────────────────────────────────────────
// Normalization helpers
// ─────────────────────────────────────────────────────────────

// Collapse whitespace and trim, so snippets are always tidy.
function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

// Turn an HTML fragment (some APIs embed <strong> etc.) into plain text.
function stripHtml(value) {
  if (!value) return '';
  // cheerio gives us a robust text extractor; fall back to regex.
  try {
    return cleanText(cheerio.load(String(value)).text());
  } catch {
    return cleanText(String(value).replace(/<[^>]*>/g, ''));
  }
}

// Unwrap DuckDuckGo's /l/?uddg=... redirect links into the real URL.
function unwrapDuckDuckGoUrl(href) {
  if (!href) return '';
  try {
    const normalized = href.startsWith('//') ? `https:${href}` : href;
    const parsed = new URL(normalized);
    const target = parsed.searchParams.get('uddg');
    if (target) return decodeURIComponent(target);
    return normalized;
  } catch {
    return href;
  }
}

// Build a canonical { title, url, snippet } record, dropping empty urls.
function normalizeResult({ title, url, snippet }) {
  const cleanUrl = cleanText(url);
  if (!cleanUrl) return null;
  return {
    title: cleanText(title) || cleanUrl,
    url: cleanUrl,
    snippet: stripHtml(snippet),
  };
}

// Apply the normalization to a provider's raw list + enforce the limit.
function normalizeList(rawResults, limit) {
  const out = [];
  for (const raw of rawResults) {
    const normalized = normalizeResult(raw);
    if (normalized) out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}


// ─────────────────────────────────────────────────────────────
// PROVIDER: Brave Search  (https://brave.com/search/api/)
// GET https://api.search.brave.com/res/v1/web/search
// ─────────────────────────────────────────────────────────────
async function braveSearch(query, { apiKey, timeout, userAgent, limit }) {
  if (!apiKey) {
    throw new SearchError('Brave Search requires an API key.', { code: 'MISSING_KEY' });
  }

  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(limit, 20)));

  const { ok, response, error, status } = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey,
    },
  }, { timeout, userAgent });

  if (!ok) {
    if (status === 401 || status === 403) {
      throw new SearchError('Brave rejected the API key (unauthorized).', { code: 'UNAUTHORIZED', status });
    }
    if (status === 429) {
      throw new SearchError('Brave rate limit exceeded.', { code: 'RATE_LIMITED', status });
    }
    throw new SearchError(`Brave request failed: ${error}`, { code: 'REQUEST_FAILED', status });
  }

  const data = await response.json();
  const results = data?.web?.results || [];
  return normalizeList(
    results.map((r) => ({ title: r.title, url: r.url, snippet: r.description })),
    limit
  );
}


// ─────────────────────────────────────────────────────────────
// PROVIDER: Tavily  (https://tavily.com)
// POST https://api.tavily.com/search
// ─────────────────────────────────────────────────────────────
async function tavilySearch(query, { apiKey, timeout, userAgent, limit }) {
  if (!apiKey) {
    throw new SearchError('Tavily requires an API key.', { code: 'MISSING_KEY' });
  }

  const { ok, response, error, status } = await fetchWithRetry('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: Math.min(limit, 20),
      search_depth: 'basic',
    }),
  }, { timeout, userAgent });

  if (!ok) {
    if (status === 401 || status === 403) {
      throw new SearchError('Tavily rejected the API key (unauthorized).', { code: 'UNAUTHORIZED', status });
    }
    if (status === 429) {
      throw new SearchError('Tavily rate limit exceeded.', { code: 'RATE_LIMITED', status });
    }
    throw new SearchError(`Tavily request failed: ${error}`, { code: 'REQUEST_FAILED', status });
  }

  const data = await response.json();
  const results = data?.results || [];
  return normalizeList(
    results.map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
    limit
  );
}


// ─────────────────────────────────────────────────────────────
// PROVIDER: SerpAPI  (https://serpapi.com)
// GET https://serpapi.com/search.json?engine=google
// ─────────────────────────────────────────────────────────────
async function serpapiSearch(query, { apiKey, timeout, userAgent, limit }) {
  if (!apiKey) {
    throw new SearchError('SerpAPI requires an API key.', { code: 'MISSING_KEY' });
  }

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.min(limit, 20)));
  url.searchParams.set('api_key', apiKey);

  const { ok, response, error, status } = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  }, { timeout, userAgent });

  if (!ok) {
    if (status === 401 || status === 403) {
      throw new SearchError('SerpAPI rejected the API key (unauthorized).', { code: 'UNAUTHORIZED', status });
    }
    if (status === 429) {
      throw new SearchError('SerpAPI rate limit exceeded.', { code: 'RATE_LIMITED', status });
    }
    throw new SearchError(`SerpAPI request failed: ${error}`, { code: 'REQUEST_FAILED', status });
  }

  const data = await response.json();
  if (data?.error) {
    throw new SearchError(`SerpAPI error: ${data.error}`, { code: 'PROVIDER_ERROR' });
  }
  const results = data?.organic_results || [];
  return normalizeList(
    results.map((r) => ({ title: r.title, url: r.link, snippet: r.snippet })),
    limit
  );
}


// ─────────────────────────────────────────────────────────────
// PROVIDER: Google Programmable Search (Custom Search JSON API)
// GET https://www.googleapis.com/customsearch/v1
// Needs BOTH an API key and a search engine id (cx).
// Accept apiKey in the form "API_KEY:CX_ID" to keep config simple.
// ─────────────────────────────────────────────────────────────
async function googleSearch(query, { apiKey, timeout, userAgent, limit }) {
  if (!apiKey) {
    throw new SearchError('Google CSE requires an API key (formatted "KEY:CX").', { code: 'MISSING_KEY' });
  }

  const [key, cx] = String(apiKey).split(':');
  if (!key || !cx) {
    throw new SearchError('Google CSE key must be formatted as "API_KEY:CX_ID".', { code: 'MISSING_KEY' });
  }

  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', key);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.min(limit, 10)));

  const { ok, response, error, status } = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  }, { timeout, userAgent });

  if (!ok) {
    if (status === 400 || status === 403) {
      throw new SearchError('Google CSE rejected the key or engine id.', { code: 'UNAUTHORIZED', status });
    }
    if (status === 429) {
      throw new SearchError('Google CSE rate limit exceeded.', { code: 'RATE_LIMITED', status });
    }
    throw new SearchError(`Google CSE request failed: ${error}`, { code: 'REQUEST_FAILED', status });
  }

  const data = await response.json();
  const results = data?.items || [];
  return normalizeList(
    results.map((r) => ({ title: r.title, url: r.link, snippet: r.snippet })),
    limit
  );
}


// ─────────────────────────────────────────────────────────────
// PROVIDER: DuckDuckGo (no key)
// Tries the HTML endpoint first, then the "lite" endpoint as a
// secondary fallback. This is what makes web_search work with
// zero configuration.
// ─────────────────────────────────────────────────────────────
async function duckduckgoSearch(query, { timeout, userAgent = DEFAULT_USER_AGENT, limit }) {
  const attempts = [
    { name: 'html', url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` },
    { name: 'lite', url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}` },
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      const { ok, response, error, status } = await fetchWithRetry(attempt.url, {
        method: 'GET',
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      }, { timeout, userAgent, retries: 2 });

      if (!ok) {
        lastError = new SearchError(
          `DuckDuckGo (${attempt.name}) request failed: ${error}`,
          { code: status === 429 ? 'RATE_LIMITED' : 'REQUEST_FAILED', status }
        );
        continue;
      }

      const html = await response.text();
      const results = attempt.name === 'html'
        ? parseDuckDuckGoHtml(html, limit)
        : parseDuckDuckGoLite(html, limit);

      if (results.length > 0) return results;

      lastError = new SearchError(
        `DuckDuckGo (${attempt.name}) returned no parseable results.`,
        { code: 'NO_RESULTS' }
      );
    } catch (err) {
      lastError = new SearchError(`DuckDuckGo (${attempt.name}) failed: ${err.message}`, { code: 'REQUEST_FAILED' });
    }
  }

  throw lastError || new SearchError('DuckDuckGo search failed.', { code: 'REQUEST_FAILED' });
}

// Parse the classic html.duckduckgo.com result page.
function parseDuckDuckGoHtml(html, limit) {
  const $ = cheerio.load(html);
  const raw = [];

  $('.result').each((_, el) => {
    const anchor = $(el).find('.result__a').first();
    const title = anchor.text();
    const url = unwrapDuckDuckGoUrl(anchor.attr('href'));
    const snippet = $(el).find('.result__snippet').first().text();
    raw.push({ title, url, snippet });
  });

  return normalizeList(raw, limit);
}

// Parse the lite.duckduckgo.com result page (simple HTML table layout).
function parseDuckDuckGoLite(html, limit) {
  const $ = cheerio.load(html);
  const raw = [];

  $('a.result-link').each((_, el) => {
    const anchor = $(el);
    const title = anchor.text();
    const url = unwrapDuckDuckGoUrl(anchor.attr('href'));
    const snippet = anchor.closest('tr').next('tr').find('.result-snippet').text();
    raw.push({ title, url, snippet });
  });

  return normalizeList(raw, limit);
}


// ─────────────────────────────────────────────────────────────
// PROVIDER_REGISTRY
// Maps the config value `searchProvider` to its implementation.
// Each entry knows whether it needs an API key.
// ─────────────────────────────────────────────────────────────
export const PROVIDER_REGISTRY = {
  brave:      { search: braveSearch,      requiresKey: true,  label: 'Brave Search' },
  tavily:     { search: tavilySearch,     requiresKey: true,  label: 'Tavily' },
  serpapi:    { search: serpapiSearch,    requiresKey: true,  label: 'SerpAPI' },
  google:     { search: googleSearch,     requiresKey: true,  label: 'Google CSE' },
  duckduckgo: { search: duckduckgoSearch, requiresKey: false, label: 'DuckDuckGo' },
};


// ─────────────────────────────────────────────────────────────
// getProvider(name)
// Returns a provider entry, defaulting to DuckDuckGo for unknown
// names so the tool never hard-fails on a typo'd config value.
// ─────────────────────────────────────────────────────────────
export function getProvider(name) {
  const key = String(name || '').toLowerCase().trim();
  if (PROVIDER_REGISTRY[key]) return { name: key, ...PROVIDER_REGISTRY[key] };
  return { name: 'duckduckgo', ...PROVIDER_REGISTRY.duckduckgo };
}
