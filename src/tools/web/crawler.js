// ================================================================
// FILE: src/tools/web/crawler.js
// PURPOSE: Polite, bounded BFS web crawler used by the web_crawl tool.
//
// Design goals:
//   - Never run away: hard caps on pages, depth, and response size.
//   - Be polite: per-domain delay, concurrency cap, robots.txt.
//   - Be resilient: one bad page never aborts the whole crawl.
//
// Pipeline per page: fetch → robots check → parse/extract → enqueue links.
// ================================================================

import {
  fetchWithRetry,
  readBodyWithLimit,
  sleep,
  DEFAULT_USER_AGENT,
} from './httpClient.js';
import { extract, toAbsoluteUrl } from './extractor.js';
import { canFetch } from './robots.js';
import { checkUrlSync } from './ssrfGuard.js';


// ─────────────────────────────────────────────────────────────
// crawl(startUrl, options)
//
// options:
//   maxDepth          number  link-hops from the start URL (default 1)
//   maxPages          number  hard cap on pages fetched (default 10)
//   sameDomainOnly    bool    stay on the start host (default true)
//   respectRobots     bool    honor robots.txt (default true)
//   perDomainDelay    number  ms between hits to the same host (default 1000)
//   concurrency       number  max in-flight fetches (default 3)
//   timeout           number  per-request timeout ms (default 15000)
//   maxResponseSize   number  bytes per page (default 2_000_000)
//   maxRedirects      number  redirect chain limit (default 5)
//   maxContentChars   number  truncate extracted text per page (default 8000)
//   format            string  'text' | 'markdown' (default 'text')
//   userAgent         string
//   totalTimeoutMs    number  wall-clock budget for the WHOLE crawl (default 60000)
//   ssrf              object  { enabled, allowPrivate } guard for enqueued links
//   cache             object  createWebCache() instance (optional)
//   logger            object  createWebLogger() instance (optional)
//   onPage            fn      progress callback ({ url, index, total })
//
// Returns:
//   {
//     startUrl, pages: [...], errors: [...], summary: {...}
//   }
// ─────────────────────────────────────────────────────────────
export async function crawl(startUrl, options = {}) {
  const {
    maxDepth = 1,
    maxPages = 10,
    sameDomainOnly = true,
    respectRobots = true,
    perDomainDelay = 1000,
    concurrency = 3,
    timeout = 15000,
    maxResponseSize = 2_000_000,
    maxRedirects = 5,
    maxContentChars = 8000,
    format = 'text',
    userAgent = DEFAULT_USER_AGENT,
    totalTimeoutMs = 60_000,
    ssrf = { enabled: true, allowPrivate: false },
    cache = null,
    logger = null,
    onPage = null,
  } = options;

  const start = normalizeUrl(startUrl);
  if (!start) {
    return {
      startUrl,
      pages: [],
      errors: [{ url: startUrl, error: 'Invalid start URL' }],
      summary: emptySummary(startUrl),
    };
  }

  // SSRF: reject an internal/non-http(s) start URL up front so the user
  // gets a clear reason instead of a generic fetch failure.
  if (ssrf && ssrf.enabled && !ssrf.allowPrivate) {
    const guard = checkUrlSync(start);
    if (!guard.ok) {
      if (logger) {
        logger.record({ type: 'crawl', url: start, ok: false, blocked: true, reason: guard.reason });
      }
      return {
        startUrl: start,
        pages: [],
        errors: [{ url: start, error: `Blocked by SSRF protection: ${guard.reason}` }],
        summary: emptySummary(start),
      };
    }
  }

  const startHost = new URL(start).hostname;

  // Wall-clock deadline for the entire crawl. Workers check this before
  // claiming new pages so a slow site can't stall the agent indefinitely.
  const deadline = Date.now() + Math.max(0, Number(totalTimeoutMs) || 0);
  const timedOut = () => Date.now() > deadline;

  // BFS queue holds { url, depth }.
  const queue = [{ url: start, depth: 0 }];
  const visited = new Set([start]);
  const pages = [];
  const errors = [];

  // Per-domain throttle bookkeeping: host -> timestamp of last request.
  const lastHitAt = new Map();

  // ── Worker pool: `concurrency` workers drain the queue in parallel. ──
  let active = 0;
  let queueIndex = 0;
  let stoppedEarly = false;

  await new Promise((resolve) => {
    // Count completed pages plus in-flight requests so the cap can't
    // be overshot by up to `concurrency - 1` pages.
    const claimed = () => pages.length + errors.length + active;

    // The crawl is finished once no worker is in flight AND we either
    // drained the queue, hit the maxPages cap, or ran out of time.
    const isDone = () =>
      active === 0 &&
      (queueIndex >= queue.length || claimed() >= maxPages || timedOut());

    const pump = () => {
      if (isDone()) {
        if (timedOut() && (queueIndex < queue.length || active > 0)) stoppedEarly = true;
        return resolve();
      }

      while (
        active < concurrency &&
        queueIndex < queue.length &&
        claimed() < maxPages &&
        !timedOut()
      ) {
        const item = queue[queueIndex++];
        active++;

        processPage(item)
          .catch((err) => {
            errors.push({ url: item.url, error: err.message });
          })
          .finally(() => {
            active--;
            pump();
          });
      }
    };

    pump();
  });

  const summary = {
    startUrl: start,
    pagesFetched: pages.length,
    pagesFailed: errors.length,
    totalWords: pages.reduce((sum, p) => sum + (p.wordCount || 0), 0),
    maxDepthReached: pages.reduce((max, p) => Math.max(max, p.depth), 0),
    truncatedPages: pages.filter((p) => p.truncated).length,
    durationMs: Date.now() - (deadline - Math.max(0, Number(totalTimeoutMs) || 0)),
    timedOut: stoppedEarly,
    cacheHits: pages.filter((p) => p.fromCache).length,
  };

  if (logger) {
    logger.record({
      type: 'crawl',
      url: start,
      ok: errors.length === 0,
      pagesFetched: summary.pagesFetched,
      pagesFailed: summary.pagesFailed,
      durationMs: summary.durationMs,
      timedOut: summary.timedOut,
      cacheHits: summary.cacheHits,
    });
  }

  return { startUrl: start, pages, errors, summary };


  // ───────────────────────────────────────────────────────────
  // processPage({ url, depth })
  // Fetch one page, extract it, and enqueue its links.
  // ───────────────────────────────────────────────────────────
  async function processPage({ url, depth }) {
    const host = safeHost(url);
    // Always a callable: when no logger is configured we still call
    // pageTimer() at several log sites, so default to a no-op timer.
    const pageTimer = logger ? logger.startTimer() : () => 0;

    // ── Cache: a recently crawled URL can be returned without a fetch. ──
    const cacheKey = cache && cache.enabled
      ? JSON.stringify({ url, format, maxContentChars })
      : null;
    if (cache && cache.enabled) {
      const cached = cache.get('crawl', cacheKey);
      if (cached) {
        const page = { ...cached, depth, fromCache: true };
        pages.push(page);
        if (onPage) onPage({ url: page.url, index: pages.length, total: maxPages });
        if (logger) {
          logger.record({
            type: 'crawl-page', url, ok: true, status: 'cache',
            durationMs: pageTimer(), depth, fromCache: true,
          });
        }
        enqueueLinks(cached.links || [], depth);
        return;
      }
    }

    // ── robots.txt gate ──
    if (respectRobots) {
      const { allowed, crawlDelay } = await canFetch(url, { timeout, userAgent });
      if (!allowed) {
        errors.push({ url, error: 'Blocked by robots.txt' });
        logPage({ url, depth, ok: false, status: 'robots', durationMs: pageTimer() });
        return;
      }
      // Honor a Crawl-delay directive if it's stricter than our default.
      if (crawlDelay && crawlDelay > perDomainDelay) {
        lastHitAt.set(host, Date.now() + (crawlDelay - perDomainDelay));
      }
    }

    // ── Per-domain throttle ──
    await throttle(host);

    // ── Fetch (with manual redirect following to honor maxRedirects) ──
    const fetched = await fetchFollowingRedirects(url, { timeout, userAgent, maxRedirects });
    if (!fetched.ok) {
      errors.push({ url, error: fetched.error });
      logPage({ url, depth, ok: false, status: fetched.status, error: fetched.error, durationMs: pageTimer() });
      return;
    }

    // ── Read body with a size guard (defense in depth: also cap here) ──
    const byteCap = Math.min(Number(maxResponseSize) || 2_000_000, maxResponseSize);
    const { text: html, truncated: bodyTruncated } = await readBodyWithLimit(
      fetched.response,
      byteCap
    );

    // ── Extract content + links ──
    const extracted = extract(html, { url: fetched.finalUrl, format });

    // Truncate content per Step 2 limits.
    let content = extracted.content;
    let contentTruncated = false;
    if (content.length > maxContentChars) {
      content = content.slice(0, maxContentChars);
      contentTruncated = true;
    }

    const page = {
      url: fetched.finalUrl,
      requestedUrl: url,
      depth,
      status: fetched.status,
      title: extracted.title,
      description: extracted.description,
      content,
      wordCount: extracted.wordCount,
      linkCount: extracted.links.length,
      truncated: bodyTruncated || contentTruncated,
      fromCache: false,
    };

    pages.push(page);
    if (onPage) onPage({ url: page.url, index: pages.length, total: maxPages });

    // Store in cache (without the per-crawl `depth`) for reuse.
    if (cache && cache.enabled) {
      const { depth: _omit, fromCache: _omit2, ...cacheable } = page;
      cache.set('crawl', cacheKey, { ...cacheable, links: extracted.links });
    }

    logPage({
      url: fetched.finalUrl, requestedUrl: url, depth,
      ok: true, status: fetched.status, durationMs: pageTimer(),
      truncated: page.truncated, wordCount: page.wordCount,
    });

    // ── Enqueue outbound links (BFS) ──
    enqueueLinks(extracted.links, depth);
  }


  // ───────────────────────────────────────────────────────────
  // enqueueLinks(links, depth)
  // Adds safe, unseen, in-scope links to the BFS queue. Applies the
  // same SSRF policy to discovered links so a page can't lure the
  // crawler onto an internal host.
  // ───────────────────────────────────────────────────────────
  function enqueueLinks(links, depth) {
    if (depth >= maxDepth) return;

    for (const link of links) {
      const normalized = normalizeUrl(link.url);
      if (!normalized || visited.has(normalized)) continue;

      if (sameDomainOnly && safeHost(normalized) !== startHost) continue;

      // SSRF check on discovered links (skip DNS to stay offline-fast;
      // the fetch layer re-checks with DNS anyway).
      if (ssrf && ssrf.enabled && !ssrf.allowPrivate) {
        const check = checkUrlSync(normalized);
        if (!check.ok) continue;
      }

      visited.add(normalized);
      queue.push({ url: normalized, depth: depth + 1 });
    }
  }


  // ───────────────────────────────────────────────────────────
  // logPage(fields)
  // Best-effort per-page log entry.
  // ───────────────────────────────────────────────────────────
  function logPage(fields) {
    if (!logger) return;
    logger.record({ type: 'crawl-page', ...fields });
  }


  // ───────────────────────────────────────────────────────────
  // throttle(host)
  // Ensures at least `perDomainDelay` ms between hits to one host.
  // ───────────────────────────────────────────────────────────
  async function throttle(host) {
    const now = Date.now();
    const last = lastHitAt.get(host) || 0;
    const wait = last - now;
    if (wait > 0) await sleep(wait);
    lastHitAt.set(host, Date.now() + perDomainDelay);
  }
}


// ─────────────────────────────────────────────────────────────
// fetchFollowingRedirects(url, { timeout, userAgent, maxRedirects })
// Follows redirects manually so we can enforce a redirect limit and
// report the final URL. Returns { ok, response, finalUrl, status, error }.
// ─────────────────────────────────────────────────────────────
async function fetchFollowingRedirects(url, { timeout, userAgent, maxRedirects }) {
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const result = await fetchWithRetry(
      current,
      { method: 'GET', redirect: 'manual', headers: { 'Accept': 'text/html,application/xhtml+xml' } },
      { timeout, userAgent, retries: 1 }
    );

    if (!result.ok) {
      return { ok: false, error: result.error || `HTTP ${result.status}`, status: result.status };
    }

    const status = result.status;
    const location = result.response.headers.get('location');

    // Not a redirect → we're done.
    if (status < 300 || status >= 400 || !location) {
      return { ok: true, response: result.response, finalUrl: current, status };
    }

    // Resolve the next hop.
    const next = toAbsoluteUrl(location, current);
    if (!next) {
      return { ok: false, error: `Invalid redirect location: ${location}`, status };
    }
    current = next;
  }

  return { ok: false, error: `Too many redirects (> ${maxRedirects})` };
}


// ─────────────────────────────────────────────────────────────
// normalizeUrl(url)
// Trims fragments, drops non-http(s) schemes, returns null if invalid.
// ─────────────────────────────────────────────────────────────
export function normalizeUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url).trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}


function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}


function emptySummary(startUrl) {
  return {
    startUrl,
    pagesFetched: 0,
    pagesFailed: 0,
    totalWords: 0,
    maxDepthReached: 0,
    truncatedPages: 0,
    durationMs: 0,
    timedOut: false,
    cacheHits: 0,
  };
}
