// ================================================================
// FILE: src/tools/webCrawlTool.js
// PURPOSE: Registers the `web_crawl` tool — a bounded, polite crawler
// that fetches a start URL, extracts readable content, and optionally
// follows links (BFS) up to a depth/page limit.
//
// Config keys (see configManager DEFAULTS / ENV_MAP):
//   crawlerRespectRobots, crawlerMaxDepth, crawlerMaxPages,
//   crawlerSameDomainOnly, crawlerPerDomainDelay, crawlerConcurrency,
//   crawlerTimeout, crawlerMaxResponseSize, crawlerMaxRedirects
//
// Safety/caching/limits are supplied by the shared `runtime` built in
// webRuntime.js (SSRF policy, cache, logger, wall-clock timeout).
// ================================================================

import { registerTool } from './ToolRegistry.js';
import { crawl } from './web/crawler.js';
import { DEFAULT_USER_AGENT } from './web/httpClient.js';


// ─────────────────────────────────────────────────────────────
// registerWebCrawlTools(registry, config, runtime)
// `config`  : wrapper exposing get(key) (or a plain object).
// `runtime` : optional { cache, logger, ssrf, limits } from
//             createWebRuntime(). When omitted, safe defaults apply.
// ─────────────────────────────────────────────────────────────
export function registerWebCrawlTools(registry, config, runtime = null) {
  const get = (key) => (config && typeof config.get === 'function' ? config.get(key) : undefined);
  const getNum = (key, fallback) => {
    const value = Number(get(key));
    return Number.isFinite(value) ? value : fallback;
  };
  const getBool = (key, fallback) => {
    const value = get(key);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return value === undefined || value === null ? fallback : Boolean(value);
  };

  // Pull the shared services, falling back to inert defaults.
  const cache = runtime?.cache || null;
  const logger = runtime?.logger || null;
  const ssrf = runtime?.ssrf || { enabled: true, allowPrivate: false };
  const limits = runtime?.limits || { maxResponseBytes: 2_000_000, maxPages: 10, maxDepth: 5, totalTimeoutMs: 60_000 };

  registerTool(registry, 'web_crawl', {
    description:
      'Fetch a web page and extract its readable content. Optionally follow links ' +
      '(breadth-first) up to a depth/page limit to gather related pages. Honors ' +
      'robots.txt and throttles requests. Use for reading docs, articles, or sites.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The starting URL to crawl (must be http/https).',
        },
        maxDepth: {
          type: 'number',
          description: 'How many link-hops to follow from the start URL. 0 = just the page. Default: 1.',
        },
        maxPages: {
          type: 'number',
          description: 'Maximum number of pages to fetch in total. Default: 10.',
        },
        sameDomainOnly: {
          type: 'boolean',
          description: 'Only follow links on the same host as the start URL. Default: true.',
        },
        format: {
          type: 'string',
          enum: ['text', 'markdown'],
          description: 'Output format for page content. Default: text.',
        },
        includeContent: {
          type: 'boolean',
          description: 'Include extracted page text in the result. Default: true.',
        },
      },
      required: ['url'],
    },
  }, async ({ url, maxDepth, maxPages, sameDomainOnly, format = 'text', includeContent = true }) => {
    if (!url || !String(url).trim()) {
      return '❌ web_crawl requires a non-empty "url".';
    }

    // Merge caller args over configured defaults.
    const options = {
      maxDepth: Number.isFinite(maxDepth) ? maxDepth : getNum('crawlerMaxDepth', 1),
      maxPages: Number.isFinite(maxPages) ? maxPages : getNum('crawlerMaxPages', 10),
      sameDomainOnly: typeof sameDomainOnly === 'boolean'
        ? sameDomainOnly
        : getBool('crawlerSameDomainOnly', true),
      respectRobots: getBool('crawlerRespectRobots', true),
      perDomainDelay: getNum('crawlerPerDomainDelay', 1000),
      concurrency: getNum('crawlerConcurrency', 3),
      timeout: getNum('crawlerTimeout', 15000),
      maxResponseSize: getNum('crawlerMaxResponseSize', limits.maxResponseBytes),
      maxRedirects: getNum('crawlerMaxRedirects', 5),
      maxContentChars: getNum('crawlerMaxContentChars', 8000),
      format: format === 'markdown' ? 'markdown' : 'text',
      userAgent: get('crawlerUserAgent') || DEFAULT_USER_AGENT,
      // Shared safety/caching/limits from the runtime.
      totalTimeoutMs: limits.totalTimeoutMs,
      ssrf,
      cache,
      logger,
    };

    // Clamp to sane bounds so a bad arg can't start a runaway crawl.
    // The runtime limits act as hard ceilings over per-call args.
    options.maxDepth = clamp(options.maxDepth, 0, Math.min(5, limits.maxDepth));
    options.maxPages = clamp(options.maxPages, 1, Math.min(50, limits.maxPages));
    options.concurrency = clamp(options.concurrency, 1, 8);
    options.maxResponseSize = clamp(options.maxResponseSize, 1024, limits.maxResponseBytes);

    let result;
    try {
      result = await crawl(url, options);
    } catch (error) {
      if (logger) logger.record({ type: 'crawl', url, ok: false, error: error.message });
      return `❌ web_crawl failed: ${error.message}`;
    }

    return formatResult(result, { includeContent, format: options.format });
  });
}


// ─────────────────────────────────────────────────────────────
// formatResult(result, { includeContent, format })
// Renders the crawl output as a readable, token-conscious string.
// ─────────────────────────────────────────────────────────────
function formatResult(result, { includeContent, format }) {
  const { pages, errors, summary } = result;

  if (pages.length === 0 && errors.length === 0) {
    return `🕸️  web_crawl found nothing at ${result.startUrl}.`;
  }

  const lines = [];
  lines.push(`🕸️  Crawled ${summary.pagesFetched} page(s) from ${summary.startUrl}`);
  lines.push(
    `   depth≤${summary.maxDepthReached} · ${summary.totalWords} words` +
    (summary.truncatedPages ? ` · ${summary.truncatedPages} truncated` : '') +
    (summary.cacheHits ? ` · ${summary.cacheHits} cached` : '') +
    (summary.durationMs ? ` · ${(summary.durationMs / 1000).toFixed(1)}s` : '')
  );
  if (summary.timedOut) {
    lines.push('   ⏱️  Stopped early: wall-clock time limit reached.');
  }
  lines.push('');

  pages.forEach((page, i) => {
    lines.push(`${i + 1}. ${page.title || '(untitled)'}`);
    lines.push(`   ${page.url}`);
    lines.push(`   depth ${page.depth} · ${page.wordCount} words · ${page.linkCount} links`);

    if (page.description) {
      lines.push(`   ${truncate(page.description, 200)}`);
    }

    if (includeContent && page.content) {
      lines.push('');
      lines.push(indent(truncate(page.content, 4000), '   '));
    }

    lines.push('');
  });

  if (errors.length) {
    lines.push('⚠️  Skipped:');
    for (const err of errors.slice(0, 10)) {
      lines.push(`  • ${err.url} — ${err.error}`);
    }
    if (errors.length > 10) lines.push(`  ... and ${errors.length - 10} more`);
  }

  return lines.join('\n').trim();
}


function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function indent(text, prefix) {
  return text.split('\n').map((line) => prefix + line).join('\n');
}
