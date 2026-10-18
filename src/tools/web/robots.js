// ================================================================
// FILE: src/tools/web/robots.js
// PURPOSE: Minimal, dependency-free robots.txt support for the crawler.
//
// Implements the parts of the Robots Exclusion Protocol that matter
// for a polite crawler:
//   - fetch /robots.txt once per origin (cached)
//   - parse User-agent groups, Allow / Disallow rules, Crawl-delay
//   - longest-match wins (Allow beats Disallow on equal length)
//   - wildcard (*) and end-anchor ($) support in paths
//
// We deliberately keep this small instead of pulling in a package.
// ================================================================

import { fetchWithRetry, DEFAULT_USER_AGENT } from './httpClient.js';

// Cache: origin -> { rules, crawlDelay, fetchedAt, ok }
const robotsCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // re-fetch robots.txt every 10 min


// ─────────────────────────────────────────────────────────────
// getRobotsFor(origin, { timeout, userAgent })
// Fetches and parses robots.txt for an origin (e.g. "https://x.com").
// Never throws — on failure returns a permissive empty rule set so
// the crawl can continue (fail-open, which is the common convention).
// ─────────────────────────────────────────────────────────────
export async function getRobotsFor(origin, { timeout = 10000, userAgent = DEFAULT_USER_AGENT } = {}) {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  const entry = {
    rules: [],
    crawlDelay: null,
    fetchedAt: Date.now(),
    ok: false,
  };

  try {
    const { ok, response } = await fetchWithRetry(
      `${origin}/robots.txt`,
      { method: 'GET', headers: { 'Accept': 'text/plain' } },
      { timeout, userAgent, retries: 1 }
    );

    if (ok) {
      const text = await response.text();
      const parsed = parseRobots(text, userAgent);
      entry.rules = parsed.rules;
      entry.crawlDelay = parsed.crawlDelay;
      entry.ok = true;
    }
  } catch {
    // Fail-open: treat as "no restrictions".
  }

  robotsCache.set(origin, entry);
  return entry;
}


// ─────────────────────────────────────────────────────────────
// parseRobots(text, userAgent)
// Returns { rules: [{ allow, pattern }], crawlDelay }.
// Only the group(s) matching our user-agent (or "*") are kept.
// ─────────────────────────────────────────────────────────────
export function parseRobots(text, userAgent = DEFAULT_USER_AGENT) {
  const lines = String(text || '').split(/\r?\n/);

  // Our token to match against User-agent lines (e.g. "qtpi").
  const ourToken = userAgent.split('/')[0].split(' ')[0].toLowerCase();

  const groups = [];        // [{ agents: [], rules: [], crawlDelay }]
  let current = null;
  let lastWasAgent = false;

  for (const rawLine of lines) {
    // Strip comments and surrounding whitespace.
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // A new User-agent line after rules starts a new group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    if (!current) continue;
    lastWasAgent = false;

    if (field === 'disallow') {
      current.rules.push({ allow: false, pattern: value });
    } else if (field === 'allow') {
      current.rules.push({ allow: true, pattern: value });
    } else if (field === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = delay * 1000;
    }
  }

  // Prefer the most specific matching group; fall back to "*".
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && ourToken.includes(a)));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const chosen = specific.length ? specific : wildcard;

  const rules = [];
  let crawlDelay = null;
  for (const g of chosen) {
    rules.push(...g.rules);
    if (g.crawlDelay != null) crawlDelay = g.crawlDelay;
  }

  return { rules, crawlDelay };
}


// ─────────────────────────────────────────────────────────────
// isAllowed(pathname, rules)
// Longest-match wins; on a tie, Allow beats Disallow.
// Empty Disallow ("Disallow:") means "allow everything".
// ─────────────────────────────────────────────────────────────
export function isAllowed(pathname, rules) {
  if (!rules || rules.length === 0) return true;

  let best = null; // { allow, length }

  for (const rule of rules) {
    // "Disallow:" with no path → allow all.
    if (!rule.allow && rule.pattern === '') continue;

    if (matchesPattern(pathname, rule.pattern)) {
      const length = rule.pattern.replace(/[*$]/g, '').length;
      if (!best || length > best.length || (length === best.length && rule.allow)) {
        best = { allow: rule.allow, length };
      }
    }
  }

  return best ? best.allow : true;
}


// ─────────────────────────────────────────────────────────────
// matchesPattern(pathname, pattern)
// Supports '*' (any chars) and a trailing '$' (end anchor).
// ─────────────────────────────────────────────────────────────
function matchesPattern(pathname, pattern) {
  if (pattern === '') return false;

  const anchored = pattern.endsWith('$');
  const core = anchored ? pattern.slice(0, -1) : pattern;

  // Escape regex specials except '*', then translate '*' → '.*'.
  const escaped = core.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp('^' + escaped + (anchored ? '$' : ''));

  return regex.test(pathname);
}


// ─────────────────────────────────────────────────────────────
// canFetch(url, { timeout, userAgent })
// Convenience: returns { allowed, crawlDelay } for a full URL.
// ─────────────────────────────────────────────────────────────
export async function canFetch(url, options = {}) {
  try {
    const parsed = new URL(url);
    const robots = await getRobotsFor(parsed.origin, options);
    return {
      allowed: isAllowed(parsed.pathname + parsed.search, robots.rules),
      crawlDelay: robots.crawlDelay,
    };
  } catch {
    return { allowed: true, crawlDelay: null };
  }
}


// Exposed for tests / cache resets.
export function clearRobotsCache() {
  robotsCache.clear();
}
