// ================================================================
// FILE: examples/web-tools-example.mjs
// PURPOSE: End-to-end demo of the web_search -> web_crawl flow that
//          the QTPi agent performs internally.
//
// Usage:
//   node examples/web-tools-example.mjs "node.js fetch retry backoff"
//
// It registers both tools on a registry (sharing one web runtime),
// runs a search, extracts the first result URL, then crawls it.
// ================================================================

import { createRegistry, executeTool } from '../src/tools/ToolRegistry.js';
import { registerWebSearchTools } from '../src/tools/webSearchTool.js';
import { registerWebCrawlTools } from '../src/tools/webCrawlTool.js';
import { createWebRuntime } from '../src/tools/web/webRuntime.js';
import { getConfig } from '../src/config/configManager.js';

const query = process.argv.slice(2).join(' ').trim() || 'node.js fetch retry backoff example';

// 1. One shared runtime: cache + logger + SSRF policy + limits.
const config = { get: (key) => getConfig(key) };
const runtime = createWebRuntime(config);

// 2. A registry with both tools registered.
const registry = createRegistry();
registerWebSearchTools(registry, config, runtime);
registerWebCrawlTools(registry, config, runtime);

// 3. Search.
console.log(`\n=== web_search("${query}") ===\n`);
const searchOutput = await executeTool(registry, 'web_search', { query, maxResults: 5 });
console.log(searchOutput);

// 4. Pick the first result URL from the (text) output.
const firstUrl = extractFirstUrl(searchOutput);
if (!firstUrl) {
  console.log('\nNo result URL found — stopping before crawl.\n');
  process.exit(0);
}

// 5. Crawl just that page (maxDepth 0 = no link following).
console.log(`\n=== web_crawl("${firstUrl}", maxDepth=0) ===\n`);
const crawlOutput = await executeTool(registry, 'web_crawl', {
  url: firstUrl,
  maxDepth: 0,
  maxPages: 1,
});
console.log(crawlOutput);
console.log('');


// ─────────────────────────────────────────────────────────────
// extractFirstUrl(text)
// Finds the first http(s) URL in the tool's text output.
// ─────────────────────────────────────────────────────────────
function extractFirstUrl(text) {
  const match = text.match(/https?:\/\/[^\s)]+/);
  return match ? match[0] : null;
}
