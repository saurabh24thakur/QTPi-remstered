// ================================================================
// FILE: src/tools/web/webRuntime.js
// PURPOSE: One place that turns the config wrapper into the shared
// web-tool services (cache, logger, SSRF policy, limits).
//
// The two tools (web_search, web_crawl) both need these services and
// they must SHARE one cache/logger instance. index.js creates a single
// runtime and passes it to both register* functions; if a caller omits
// it, each registration builds its own (still fully functional, just
// not shared across the two tools).
//
// Config keys (all optional, safe defaults):
//   webCacheEnabled      bool    default false
//   webCacheTtlMs        number  default 0 (disabled)
//   webCachePersist      bool    default false
//   webCacheMaxEntries   number  default 500
//   webLogEnabled        bool    default false
//   webLogToFile         bool    default true
//   webLogToConsole      bool    default false
//   webLogFile           string  default ~/.qtpi/web.log
//   webSsrfProtection    bool    default true  (block internal targets)
//   webAllowPrivateHosts bool    default false (escape hatch for testing)
//   webMaxResponseBytes  number  default 2_000_000
//   webMaxPages          number  default 10
//   webMaxDepth          number  default 5
//   webTotalTimeoutMs    number  default 60000 (wall clock per operation)
// ================================================================

import { createWebCache } from './cache.js';
import { createWebLogger } from './webLogger.js';
import { configureHttpClient } from './httpClient.js';

// Read a value from either a config wrapper ({ get }) or a plain object.
function readConfig(config, key) {
  if (!config) return undefined;
  if (typeof config.get === 'function') return config.get(key);
  return config[key];
}

// Coerce to a finite number, else fall back to `fallback`.
function readNumber(config, key, fallback) {
  const value = Number(readConfig(config, key));
  return Number.isFinite(value) ? value : fallback;
}

// Coerce "true"/"false"/1/0/true/false into a real boolean.
function readBool(config, key, fallback) {
  const value = readConfig(config, key);
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return Boolean(value);
}


// ─────────────────────────────────────────────────────────────
// createWebRuntime(config)
// Builds the shared web services and applies the SSRF policy to the
// shared HTTP client so EVERY fetch (including robots.txt) is guarded.
// ─────────────────────────────────────────────────────────────
export function createWebRuntime(config) {
  const cache = createWebCache({
    enabled: readBool(config, 'webCacheEnabled', false),
    ttlMs: readNumber(config, 'webCacheTtlMs', 0),
    persist: readBool(config, 'webCachePersist', false),
    maxEntries: readNumber(config, 'webCacheMaxEntries', 500),
  });

  const logger = createWebLogger({
    enabled: readBool(config, 'webLogEnabled', false),
    toFile: readBool(config, 'webLogToFile', true),
    toConsole: readBool(config, 'webLogToConsole', false),
    file: readConfig(config, 'webLogFile') || undefined,
  });

  const ssrf = {
    enabled: readBool(config, 'webSsrfProtection', true),
    allowPrivate: readBool(config, 'webAllowPrivateHosts', false),
  };

  const limits = {
    maxResponseBytes: readNumber(config, 'webMaxResponseBytes', 2_000_000),
    maxPages: readNumber(config, 'webMaxPages', 10),
    maxDepth: readNumber(config, 'webMaxDepth', 5),
    totalTimeoutMs: readNumber(config, 'webTotalTimeoutMs', 60_000),
  };

  // Make the SSRF policy + logger global to the HTTP layer so no call
  // site can accidentally bypass it.
  configureHttpClient({ ssrf, logger });

  return { cache, logger, ssrf, limits };
}