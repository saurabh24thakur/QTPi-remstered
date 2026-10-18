// ================================================================
// FILE: test/web-tools.test.js
// PURPOSE: Offline, deterministic tests for the web tools:
//   web_search (src/tools/webSearchTool.js)
//   web_crawl  (src/tools/webCrawlTool.js)
//   + their shared helpers under src/tools/web/
//
// Run with:  npm test        (node --test)
//            node --test test/web-tools.test.js
//
// These tests never hit the network. Live coverage lives in
// examples/web-tools-example.mjs and `qtpi ask` (see docs/WEB_TOOLS.md).
// ================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkUrlSync,
  checkHostname,
  assertUrlSafe,
  ipv4ToBigInt,
  parseIPv6,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIp,
  SSRF_CODES,
  clearDnsCache,
} from '../src/tools/web/ssrfGuard.js';

import { parseRobots, isAllowed, clearRobotsCache } from '../src/tools/web/robots.js';

import { extract, toAbsoluteUrl } from '../src/tools/web/extractor.js';

import { isRetryableStatus, computeBackoff } from '../src/tools/web/httpClient.js';

import { createWebCache } from '../src/tools/web/cache.js';

import { createWebLogger } from '../src/tools/web/webLogger.js';

import { createWebRuntime } from '../src/tools/web/webRuntime.js';

import { createRegistry, registerTool, executeTool } from '../src/tools/ToolRegistry.js';
import { registerWebSearchTools } from '../src/tools/webSearchTool.js';
import { registerWebCrawlTools } from '../src/tools/webCrawlTool.js';
import { getProvider } from '../src/tools/web/searchProviders.js';
import { crawl } from '../src/tools/web/crawler.js';


// ─────────────────────────────────────────────────────────────
// Step 3 + Step 4: SSRF guard (security-critical, pure logic)
// ─────────────────────────────────────────────────────────────
describe('ssrfGuard', () => {
  test('ipv4ToBigInt parses valid dotted-quad and rejects garbage', () => {
    assert.equal(ipv4ToBigInt('10.0.0.1'), 0x0a000001n);
    assert.equal(ipv4ToBigInt('255.255.255.255'), 0xffffffffn);
    assert.equal(ipv4ToBigInt('1.2.3'), null);
    assert.equal(ipv4ToBigInt('1.2.3.256'), null);
    assert.equal(ipv4ToBigInt('a.b.c.d'), null);
  });

  test('parseIPv6 expands compression and embedded IPv4', () => {
    assert.equal(parseIPv6('::1'), 1n);
    assert.equal(parseIPv6('::'), 0n);
    // ::ffff:1.2.3.4 → high 96 bits 0xffff, low 32 = 0x01020304
    assert.equal(parseIPv6('::ffff:1.2.3.4'), (0xffffn << 32n) | 0x01020304n);
    assert.equal(parseIPv6('not-an-ip'), null);
    assert.equal(parseIPv6('1:2:3:4:5:6:7:8:9'), null);
  });

  test('isPrivateIPv4 covers the reserved ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.9.9', '169.254.169.254']) {
      assert.equal(isPrivateIPv4(ip), true, `${ip} should be private`);
    }
    assert.equal(isPrivateIPv4('8.8.8.8'), false);
    assert.equal(isPrivateIPv4('1.1.1.1'), false);
  });

  test('isPrivateIPv6 covers loopback, ULA and v4-mapped', () => {
    assert.equal(isPrivateIPv6('::1'), true);
    assert.equal(isPrivateIPv6('::'), true);
    assert.equal(isPrivateIPv6('fc00::1'), true);
    assert.equal(isPrivateIPv6('fe80::1'), true);
    assert.equal(isPrivateIPv6('::ffff:127.0.0.1'), true); // v4-mapped loopback
    assert.equal(isPrivateIPv6('2001:4860:4860::8888'), false); // public DNS
  });

  test('isPrivateIp dispatches by family and ignores non-IPs', () => {
    assert.equal(isPrivateIp('127.0.0.1'), true);
    assert.equal(isPrivateIp('::1'), true);
    assert.equal(isPrivateIp('8.8.8.8'), false);
    assert.equal(isPrivateIp('example.com'), false);
  });

  test('checkHostname rejects reserved names and single-label hosts', () => {
    assert.equal(checkHostname('localhost').ok, false);
    assert.equal(checkHostname('foo.internal').ok, false);
    assert.equal(checkHostname('intranet').ok, false);
    assert.equal(checkHostname('example.com').ok, true);
  });

  test('checkUrlSync blocks bad schemes, private IPs and reserved hosts', () => {
    const blocked = [
      ['file:///etc/passwd', SSRF_CODES.BAD_SCHEME],
      ['ftp://example.com/x', SSRF_CODES.BAD_SCHEME],
      ['http://127.0.0.1', SSRF_CODES.PRIVATE_IP],
      ['http://10.0.0.5/admin', SSRF_CODES.PRIVATE_IP],
      ['http://192.168.1.1', SSRF_CODES.PRIVATE_IP],
      ['http://169.254.169.254/latest/meta-data/', SSRF_CODES.PRIVATE_IP],
      ['http://[::1]', SSRF_CODES.PRIVATE_IP],
      ['http://localhost', SSRF_CODES.BLOCKED_HOST],
      ['http://foo.internal', SSRF_CODES.BLOCKED_HOST],
      ['http://intranet', SSRF_CODES.BLOCKED_HOST],
    ];
    for (const [url, code] of blocked) {
      const res = checkUrlSync(url);
      assert.equal(res.ok, false, `${url} should be blocked`);
      assert.equal(res.code, code, `${url} → ${res.code} (expected ${code})`);
    }
    assert.equal(checkUrlSync('https://example.com/docs').ok, true);
  });

  test('assertUrlSafe blocks a public name that resolves to a private IP (DNS injection)', async () => {
    clearDnsCache();
    const lookup = async () => [{ address: '10.0.0.5', family: 4 }];
    const res = await assertUrlSafe('http://evil.example.com', { lookup });
    assert.equal(res.ok, false);
    assert.equal(res.code, SSRF_CODES.PRIVATE_IP);
  });

  test('assertUrlSafe allows a public name that resolves to a public IP', async () => {
    clearDnsCache();
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const res = await assertUrlSafe('http://good.example.org', { lookup });
    assert.equal(res.ok, true);
  });

  test('assertUrlSafe is a pass-through when allowPrivate is true', async () => {
    const res = await assertUrlSafe('http://127.0.0.1:9200/', { allowPrivate: true });
    assert.equal(res.ok, true);
  });

  test('assertUrlSafe reports DNS failure distinctly (not an attack)', async () => {
    clearDnsCache();
    const lookup = async () => { throw new Error('ENOTFOUND'); };
    const res = await assertUrlSafe('http://nope.example.net', { lookup });
    assert.equal(res.ok, false);
    assert.equal(res.code, SSRF_CODES.DNS_FAILED);
  });
});


// ─────────────────────────────────────────────────────────────
// Step 3: robots.txt parser
// ─────────────────────────────────────────────────────────────
describe('robots', () => {
  test('parseRobots keeps the matching group and reads Crawl-delay', () => {
    const text = ['User-agent: *', 'Disallow: /private', 'Allow: /private/public', 'Crawl-delay: 2'].join('\n');
    const { rules, crawlDelay } = parseRobots(text, 'QTPi/1.0');
    assert.equal(crawlDelay, 2000);
    assert.ok(rules.length >= 2);
    assert.equal(isAllowed('/private/x', rules), false);
    assert.equal(isAllowed('/private/public/a', rules), true); // longer Allow wins
    assert.equal(isAllowed('/anything', rules), true);
  });

  test('specific user-agent group overrides the wildcard group', () => {
    const text = ['User-agent: qtpi', 'Disallow: /blocked', '', 'User-agent: *', 'Disallow: /pi'].join('\n');
    const { rules } = parseRobots(text, 'QTPi/1.0');
    assert.equal(isAllowed('/blocked/page', rules), false); // from specific group
    assert.equal(isAllowed('/other', rules), true);
  });

  test('supports wildcard (*) and end-anchor ($)', () => {
    const { rules } = parseRobots(['User-agent: *', 'Disallow: /*.pdf$'].join('\n'), 'QTPi/1.0');
    assert.equal(isAllowed('/docs/guide.pdf', rules), false);
    assert.equal(isAllowed('/docs/guide.pdfx', rules), true);
  });

  test('empty Disallow means allow everything', () => {
    const { rules } = parseRobots(['User-agent: *', 'Disallow:'].join('\n'), 'QTPi/1.0');
    assert.equal(isAllowed('/anything', rules), true);
  });

  test('comments and blank lines are ignored', () => {
    const text = ['# a comment', 'User-agent: *   # inline', '', 'Disallow: /secret  # note'].join('\n');
    const { rules } = parseRobots(text, 'QTPi/1.0');
    assert.equal(isAllowed('/secret', rules), false);
  });
});


// ─────────────────────────────────────────────────────────────
// Step 3: HTML extractor
// ─────────────────────────────────────────────────────────────
describe('extractor', () => {
  const html = `<!doctype html><html><head>
    <title>Fallback Title</title>
    <meta property="og:title" content="Real Title">
    <meta name="description" content="A short description.">
    </head><body>
    <nav>NAV SHOULD BE STRIPPED</nav>
    <article>
      <h1>Heading</h1>
      <p>First paragraph with real content that is long enough to score.</p>
      <p>Second paragraph, also reasonably long so the article wins.</p>
      <a href="/relative/page">Relative Link</a>
      <a href="mailto:x@y.com">Email</a>
    </article>
    <footer>FOOTER SHOULD BE STRIPPED</footer>
    </body></html>`;

  test('extract pulls title/description and strips nav/footer', () => {
    const out = extract(html, { url: 'https://example.com/docs/', format: 'text' });
    assert.equal(out.title, 'Real Title'); // og:title preferred
    assert.equal(out.description, 'A short description.');
    assert.ok(out.content.includes('First paragraph'));
    assert.ok(!out.content.includes('NAV SHOULD BE STRIPPED'));
    assert.ok(!out.content.includes('FOOTER SHOULD BE STRIPPED'));
    assert.ok(out.wordCount > 0);
  });

  test('extract resolves links to absolute URLs and drops mailto', () => {
    const out = extract(html, { url: 'https://example.com/docs/', format: 'text' });
    const urls = out.links.map((l) => l.url);
    assert.ok(urls.includes('https://example.com/relative/page'));
    assert.ok(!urls.some((u) => u.startsWith('mailto:')));
  });

  test('extract supports markdown output', () => {
    const out = extract(html, { url: 'https://example.com/', format: 'markdown' });
    assert.ok(typeof out.content === 'string' && out.content.length > 0);
  });

  test('toAbsoluteUrl handles relative, invalid and non-http schemes', () => {
    assert.equal(toAbsoluteUrl('/a', 'https://x.com/b/c'), 'https://x.com/a');
    assert.equal(toAbsoluteUrl('https://y.com/z', 'https://x.com/'), 'https://y.com/z');
    assert.equal(toAbsoluteUrl('mailto:x@y.com', 'https://x.com/'), null);
    assert.equal(toAbsoluteUrl('#frag', 'https://x.com/'), null);
    assert.equal(toAbsoluteUrl('', 'https://x.com/'), null);
  });
});


// ─────────────────────────────────────────────────────────────
// Step 3: HTTP client helpers
// ─────────────────────────────────────────────────────────────
describe('httpClient', () => {
  test('isRetryableStatus retries 429 and 5xx only', () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(404), false);
    assert.equal(isRetryableStatus(200), false);
    assert.equal(isRetryableStatus(403), false);
  });

  test('computeBackoff stays within [500, 8000] ms', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const ms = computeBackoff(attempt);
      assert.ok(ms >= 500, `attempt ${attempt} → ${ms} < 500`);
      assert.ok(ms <= 8000, `attempt ${attempt} → ${ms} > 8000`);
    }
  });
});


// ─────────────────────────────────────────────────────────────
// Step 7: web cache
// ─────────────────────────────────────────────────────────────
describe('web cache', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test('disabled cache is a no-op', () => {
    const cache = createWebCache({ enabled: false });
    assert.equal(cache.enabled, false);
    cache.set('search', 'k', { v: 1 });
    assert.equal(cache.get('search', 'k'), null);
  });

  test('stores and retrieves within TTL', () => {
    const cache = createWebCache({ enabled: true, ttlMs: 1000 });
    cache.set('search', 'q1', { title: 'x' });
    assert.deepEqual(cache.get('search', 'q1'), { title: 'x' });
  });

  test('entries expire once the TTL passes', async () => {
    const cache = createWebCache({ enabled: true, ttlMs: 40 });
    cache.set('search', 'q1', { v: 1 });
    assert.deepEqual(cache.get('search', 'q1'), { v: 1 });
    await sleep(80);
    assert.equal(cache.get('search', 'q1'), null);
  });

  test('evicts oldest entries past maxEntries', () => {
    const cache = createWebCache({ enabled: true, ttlMs: 1000, maxEntries: 2 });
    cache.set('search', 'a', 1);
    cache.set('search', 'b', 2);
    cache.set('search', 'c', 3);
    assert.equal(cache.size, 2);
    assert.equal(cache.get('search', 'a'), null); // oldest evicted
  });

  test('remember() computes once then serves from cache', async () => {
    const cache = createWebCache({ enabled: true, ttlMs: 1000 });
    let calls = 0;
    const producer = async () => { calls++; return { n: calls }; };
    const first = await cache.remember('search', 'q', producer);
    const second = await cache.remember('search', 'q', producer);
    assert.equal(calls, 1);
    assert.deepEqual(first, second);
  });
});


// ─────────────────────────────────────────────────────────────
// Step 3 + Step 7: web logger (injectable clock)
// ─────────────────────────────────────────────────────────────
describe('web logger', () => {
  test('disabled logger records nothing', () => {
    const logger = createWebLogger({ enabled: false, toFile: false });
    logger.record({ type: 'search', ok: true });
    assert.equal(logger.recent().length, 0);
  });

  test('records events into a bounded ring buffer', () => {
    const logger = createWebLogger({ enabled: true, toFile: false, ringSize: 3 });
    for (let i = 0; i < 5; i++) logger.record({ type: 'search', query: `q${i}` });
    const recent = logger.recent();
    assert.equal(recent.length, 3);
    assert.equal(recent[recent.length - 1].query, 'q4'); // newest last
  });

  test('startTimer uses the injected clock', () => {
    let now = 1000;
    const logger = createWebLogger({ enabled: true, toFile: false, now: () => now });
    const timer = logger.startTimer();
    now = 1250;
    assert.equal(timer(), 250);
  });
});


// ─────────────────────────────────────────────────────────────
// Step 7: shared runtime (config → cache/logger/ssrf/limits)
// ─────────────────────────────────────────────────────────────
describe('webRuntime', () => {
  test('applies config values and safe defaults', () => {
    const values = {
      webCacheEnabled: true,
      webCacheTtlMs: 60000,
      webLogEnabled: true,
      webSsrfProtection: false,
      webAllowPrivateHosts: true,
      webMaxPages: 7,
      webMaxDepth: 2,
      webTotalTimeoutMs: 1234,
      webMaxResponseBytes: 4096,
    };
    const runtime = createWebRuntime({ get: (k) => values[k] });

    assert.equal(runtime.cache.enabled, true);
    assert.equal(runtime.logger.enabled, true);
    assert.equal(runtime.ssrf.enabled, false);
    assert.equal(runtime.ssrf.allowPrivate, true);
    assert.equal(runtime.limits.maxPages, 7);
    assert.equal(runtime.limits.maxDepth, 2);
    assert.equal(runtime.limits.totalTimeoutMs, 1234);
    assert.equal(runtime.limits.maxResponseBytes, 4096);
  });

  test('falls back to defaults when config is empty', () => {
    const runtime = createWebRuntime({ get: () => undefined });
    assert.equal(runtime.cache.enabled, false);
    assert.equal(runtime.ssrf.enabled, true);
    assert.equal(runtime.ssrf.allowPrivate, false);
    assert.equal(runtime.limits.maxPages, 10);
    assert.equal(runtime.limits.maxDepth, 5);
  });

  test('coerces string booleans ("true"/"false")', () => {
    const runtime = createWebRuntime({ get: (k) => ({ webSsrfProtection: 'false' }[k]) });
    assert.equal(runtime.ssrf.enabled, false);
  });
});


// ─────────────────────────────────────────────────────────────
// Step 6: tools via the registry — validation & "never throws"
// ─────────────────────────────────────────────────────────────
describe('tool registry (offline validation)', () => {
  function buildRegistry() {
    const registry = createRegistry();
    const config = { get: () => undefined };
    registerWebSearchTools(registry, config, null);
    registerWebCrawlTools(registry, config, null);
    return registry;
  }

  test('both tools are registered with definitions', () => {
    const registry = buildRegistry();
    assert.ok(registry.has('web_search'));
    assert.ok(registry.has('web_crawl'));
    assert.equal(registry.get('web_search').definition.name, 'web_search');
    assert.ok(registry.get('web_crawl').definition.parameters.required.includes('url'));
  });

  test('executeTool returns a string for an unknown tool', async () => {
    const registry = buildRegistry();
    const out = await executeTool(registry, 'nope', {});
    assert.equal(typeof out, 'string');
    assert.match(out, /Unknown tool/);
  });

  test('web_search rejects an empty query without throwing', async () => {
    const registry = buildRegistry();
    const out = await executeTool(registry, 'web_search', { query: '   ' });
    assert.equal(typeof out, 'string');
    assert.match(out, /non-empty "query"/);
  });

  test('web_crawl rejects a missing url without throwing', async () => {
    const registry = buildRegistry();
    const out = await executeTool(registry, 'web_crawl', {});
    assert.equal(typeof out, 'string');
    assert.match(out, /non-empty "url"/);
  });

  test('crawl() rejects a non-http start URL with a clear error', async () => {
    const result = await crawl('javascript:alert(1)', { respectRobots: false });
    assert.equal(result.pages.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /Invalid start URL/);
  });

  test('crawl() blocks an SSRF start URL before any network I/O', async () => {
    const result = await crawl('http://169.254.169.254/latest/meta-data/', {
      respectRobots: false,
      ssrf: { enabled: true, allowPrivate: false },
    });
    assert.equal(result.pages.length, 0);
    assert.match(result.errors[0].error, /SSRF/);
  });

  test('crawl() works with NO logger configured (regression: pageTimer)', async () => {
    // Previously `pageTimer` was null when no logger was supplied, yet it was
    // still invoked at several log sites → "pageTimer is not a function".
    // A crawl with logger: null must not surface that error.
    const result = await crawl('javascript:alert(1)', { respectRobots: false, logger: null });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /Invalid start URL/);
    assert.ok(
      !result.errors.some((e) => /pageTimer/.test(e.error)),
      'no pageTimer error should be reported'
    );
  });

  test('getProvider falls back to duckduckgo for unknown names', () => {
    assert.equal(getProvider('totally-fake').name, 'duckduckgo');
    assert.equal(getProvider('BRAVE').name, 'brave');
    assert.equal(getProvider(undefined).name, 'duckduckgo');
  });

  test('handler result is always a string even for odd args', async () => {
    const registry = createRegistry();
    registerTool(registry, 'echo', {
      description: 'echo',
      parameters: { type: 'object', properties: {} },
    }, async () => ({ some: 'object' }));
    const out = await executeTool(registry, 'echo', {});
    assert.equal(typeof out, 'string');
    assert.match(out, /"some": "object"/);
  });
});


// ─────────────────────────────────────────────────────────────
// Step 7: robots cache reset helper (keeps tests isolated)
// ─────────────────────────────────────────────────────────────
describe('cache reset helpers', () => {
  test('clearRobotsCache() and clearDnsCache() are callable', () => {
    clearRobotsCache();
    clearDnsCache();
    assert.ok(true);
  });
});
