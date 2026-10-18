# 🌐 Web Tools: `web_search` & `web_crawl`

QTPi ships two agent tools that give the model access to the **live web**:

| Tool | What it does | When the agent uses it |
|------|--------------|------------------------|
| `web_search` | Returns a ranked list of results (`title`, `url`, `snippet`) for a query. | When it needs information that is **not** in the local repository (docs, error messages, library APIs, release notes). |
| `web_crawl` | Fetches a page and extracts readable content; can optionally follow links (BFS) to gather related pages. | When a search snippet isn't enough and the agent needs to **read a full page** (e.g. a result URL from `web_search`). |

Typical flow: **`web_search` → pick a URL → `web_crawl` that URL**.

Both tools are registered in `src/index.js` and share a single runtime
(`createWebRuntime`) so they use **one cache, one logger, one SSRF policy, one set of limits**.

---

## 1. `web_search`

### Parameters

| Name | Type | Required | Default | Description |
|------|------|:--------:|---------|-------------|
| `query` | string | ✅ | — | The search query, e.g. `"node.js fetch retry backoff example"`. |
| `maxResults` | number | ❌ | `5` | How many results to return. Clamped to `1–20`. |
| `provider` | string | ❌ | configured | Per-call override: `brave` \| `tavily` \| `serpapi` \| `google` \| `duckduckgo`. |

### Return shape

`web_search` **always returns a human/LLM-readable string** (it never throws,
so the agent loop keeps going and can react to failures).

Success:

```
🔎 Web results for "node fetch retry" via Brave Search:

1. Retry with backoff in Node.js
   https://example.com/retry-backoff
   A short snippet of the result…

2. …

ℹ️  Provider notes:
  • Brave Search: RATE_LIMITED: Brave rate limit exceeded.
```

Failure (every provider failed):

```
❌ web_search failed for "…".

Attempts:
  • Brave Search: no API key configured
  • DuckDuckGo (html): REQUEST_FAILED: …

Suggestions:
  • Retry in a moment (the provider may be rate limiting).
  • Configure a search API key: qtpi config (searchProvider + searchApiKey).
  • Or proceed without web search and rely on the local repository.
```

Internally, providers normalize to `{ title, url, snippet }[]` and the tool
formats them. Under the hood:

1. Try the **configured provider** (skipped if it needs a key you don't have).
2. Fall back to **keyless DuckDuckGo** if the primary fails.
3. Return a structured error string if all attempts fail.

---

## 2. `web_crawl`

### Parameters

| Name | Type | Required | Default | Description |
|------|------|:--------:|---------|-------------|
| `url` | string | ✅ | — | Starting URL (must be `http`/`https`). |
| `maxDepth` | number | ❌ | `1` | Link-hops to follow from the start URL. `0` = just that page. Clamped to `≤ min(5, webMaxDepth)`. |
| `maxPages` | number | ❌ | `10` | Max pages fetched in total. Clamped to `≤ min(50, webMaxPages)`. |
| `sameDomainOnly` | boolean | ❌ | `true` | Stay on the start URL's host. |
| `format` | string | ❌ | `text` | `text` or `markdown` output. |
| `includeContent` | boolean | ❌ | `true` | Include extracted page text in the result. |

### Return shape

Also a **string** (never throws). Example:

```
🕸️  Crawled 4 page(s) from https://example.com/docs
   depth≤2 · 3120 words · 1 truncated · 2 cached · 1.8s

1. Getting Started
   https://example.com/docs/getting-started
   depth 0 · 640 words · 12 links
   A short description…

   <indented page text>

2. …

⚠️  Skipped:
  • https://example.com/broken — HTTP 404
```

If nothing is found:

```
🕸️  web_crawl found nothing at https://example.com.
```

The underlying `crawl()` returns a structured object for programmatic use:

```js
{
  startUrl: string,
  pages: [{
    url, title, description, content,
    depth, wordCount, linkCount, truncated, fromCache
  }],
  errors: [{ url, error }],
  summary: {
    startUrl, pagesFetched, totalWords, maxDepthReached,
    truncatedPages, durationMs, timedOut, cacheHits
  }
}
```

---

## 3. Configuration

Configure interactively (recommended):

```bash
qtpi config
```

…or via env vars (env **always wins**, useful for CI / one-off runs):

```bash
QTPI_SEARCH_PROVIDER=brave QTPI_SEARCH_API_KEY=xxx qtpi wakeup
```

### Web search keys

| Config key | Env var | Default | Notes |
|------------|---------|---------|-------|
| `searchProvider` | `QTPI_SEARCH_PROVIDER` | `duckduckgo` | `duckduckgo` \| `brave` \| `tavily` \| `serpapi` \| `google`. |
| `searchApiKey` | `QTPI_SEARCH_API_KEY` | `''` | Required for paid providers. For `google`, format `API_KEY:CX_ID`. |
| `searchTimeout` | `QTPI_SEARCH_TIMEOUT` | `15000` | ms per search request. |

### Web crawler keys

| Config key | Env var | Default | Notes |
|------------|---------|---------|-------|
| `crawlerUserAgent` | `QTPI_CRAWLER_USER_AGENT` | `QTPi/1.0 (+https://qtpi.dev)` | Sent on every fetch. |
| `crawlerTimeout` | `QTPI_CRAWLER_TIMEOUT` | `15000` | ms per request. |
| `crawlerMaxPages` | `QTPI_CRAWLER_MAX_PAGES` | `5` | Default page cap per crawl. |
| `crawlerRespectRobots` | `QTPI_CRAWLER_RESPECT_ROBOTS` | `true` | Honor `robots.txt`. |
| `crawlerMaxDepth` | `QTPI_CRAWLER_MAX_DEPTH` | `1` | Default link-hop depth. |
| `crawlerSameDomainOnly` | `QTPI_CRAWLER_SAME_DOMAIN_ONLY` | `true` | Keep crawl on the start host. |
| `crawlerPerDomainDelay` | `QTPI_CRAWLER_PER_DOMAIN_DELAY` | `1000` | ms between hits to the same host (politeness). |
| `crawlerConcurrency` | `QTPI_CRAWLER_CONCURRENCY` | `3` | Max in-flight fetches (`1–8`). |
| `crawlerMaxResponseSize` | `QTPI_CRAWLER_MAX_RESPONSE_SIZE` | `2000000` | Bytes per page. |
| `crawlerMaxRedirects` | `QTPI_CRAWLER_MAX_REDIRECTS` | `5` | Redirect chain limit. |

### Safety, caching & limits (shared runtime — Step 7)

| Config key | Env var | Default | Notes |
|------------|---------|---------|-------|
| `webSsrfProtection` | `QTPI_WEB_SSRF_PROTECTION` | `true` | Block private / loopback / link-local targets (SSRF guard). |
| `webAllowPrivateHosts` | `QTPI_WEB_ALLOW_PRIVATE_HOSTS` | `false` | Escape hatch for local testing **only**. |
| `webMaxResponseBytes` | `QTPI_WEB_MAX_RESPONSE_BYTES` | `2000000` | Hard byte cap per fetched page. |
| `webMaxPages` | `QTPI_WEB_MAX_PAGES` | `10` | **Hard ceiling** on pages per crawl (overrides per-call args). |
| `webMaxDepth` | `QTPI_WEB_MAX_DEPTH` | `5` | **Hard ceiling** on crawl depth. |
| `webTotalTimeoutMs` | `QTPI_WEB_TOTAL_TIMEOUT_MS` | `60000` | Wall-clock budget for a whole crawl. |
| `webCacheEnabled` | `QTPI_WEB_CACHE_ENABLED` | `false` | Cache search + crawl results. |
| `webCacheTtlMs` | `QTPI_WEB_CACHE_TTL_MS` | `0` | Entry lifetime (`0` = disabled). |
| `webCachePersist` | `QTPI_WEB_CACHE_PERSIST` | `false` | Also persist the cache to disk. |
| `webCacheMaxEntries` | `QTPI_WEB_CACHE_MAX_ENTRIES` | `500` | In-memory entry cap. |
| `webLogEnabled` | `QTPI_WEB_LOG_ENABLED` | `false` | Log every fetch / search. |
| `webLogToFile` | `QTPI_WEB_LOG_TO_FILE` | `true` | Append JSONL to `webLogFile`. |
| `webLogToConsole` | `QTPI_WEB_LOG_TO_CONSOLE` | `false` | Echo one-line summaries to stderr. |
| `webLogFile` | `QTPI_WEB_LOG_FILE` | `''` → `~/.qtpi/web.log` | Log destination. |

> **Order of precedence:** env var → project config (`.qtpi/config.json`) → global config (`~/.qtpi/config.json`) → default.

---

## 4. Cost & rate-limit notes

- **DuckDuckGo (default) is free and needs no key.** It scrapes DuckDuckGo's HTML
  endpoint, so it is best-effort and can occasionally rate-limit or change markup.
  It is the zero-config fallback and is also used automatically when a paid
  provider fails.
- **Brave / Tavily / SerpAPI / Google are paid / quota-limited** and require an API key.
  - `429` responses are surfaced as `RATE_LIMITED` and trigger the DuckDuckGo fallback.
  - Invalid keys surface as `UNAUTHORIZED` (check the key in `qtpi config`).
- **Crawling costs no money but consumes bandwidth/time.** The crawler is deliberately
  polite: it honors `robots.txt`, waits `crawlerPerDomainDelay` ms between hits to the
  same host, caps concurrency, and enforces hard page/depth/byte/time ceilings so a
  single bad URL can never start a runaway crawl.
- **Token cost:** `web_search` output is compact (title/url/snippet). `web_crawl`
  truncates each page's text (`crawlerMaxContentChars`, default `8000`) before it
  reaches the model. Use `includeContent: false` for link discovery only.

### Provider signup

| Provider | Signup | Key format |
|----------|--------|-----------|
| DuckDuckGo | none | — |
| Brave Search | https://brave.com/search/api/ | single token |
| Tavily | https://tavily.com | single token |
| SerpAPI | https://serpapi.com | single token |
| Google CSE | https://developers.google.com/custom-search/v1/overview | `API_KEY:CX_ID` (a Programmable Search Engine id is also required) |

Then run `qtpi config` (or set the env vars) and pick the provider.

---

## 5. Example: search, then crawl a result

See [`examples/web-tools-example.mjs`](../examples/web-tools-example.mjs).

Run it directly:

```bash
node examples/web-tools-example.mjs "node.js fetch retry backoff"
```

It registers both tools on a registry, runs `web_search`, parses the first result
URL, then runs `web_crawl` on it — exactly the sequence the agent performs.

### As an agent prompt

Once configured, just ask QTPi in **Agent** or **Ask** mode:

```
Look up the current recommended way to retry fetch requests in Node.js,
then read the most relevant page to confirm the API.
```

QTPi will call `web_search`, choose a result, and call `web_crawl` on it.

### Programmatic use (inside QTPi)

```js
import { createRegistry, executeTool } from './src/tools/ToolRegistry.js';
import { registerWebSearchTools } from './src/tools/webSearchTool.js';
import { registerWebCrawlTools } from './src/tools/webCrawlTool.js';
import { createWebRuntime } from './src/tools/web/webRuntime.js';
import { getConfig } from './src/config/configManager.js';

const config = { get: (key) => getConfig(key) };
const runtime = createWebRuntime(config);   // shared cache/logger/ssrf/limits
const registry = createRegistry();

registerWebSearchTools(registry, config, runtime);
registerWebCrawlTools(registry, config, runtime);

const results = await executeTool(registry, 'web_search', { query: 'node fetch retry' });
const page = await executeTool(registry, 'web_crawl', { url: 'https://example.com', maxDepth: 0 });
console.log(results, page);
```
