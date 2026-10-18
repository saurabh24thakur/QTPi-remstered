// ================================================================
// FILE: src/tools/web/httpClient.js
// PURPOSE: Shared HTTP helpers for the web tools (web_search, web_crawl)
//
// Provides:
//   - fetchWithTimeout()  : fetch() that respects an AbortController timeout
//   - fetchWithRetry()    : timeout + retry with exponential backoff + jitter
//   - isRetryableStatus() : classifies status codes (429 / 5xx = retry)
//   - configureHttpClient(): installs the SSRF policy + logger used by
//                            every request (see webRuntime.js)
//
// Every function NEVER throws for network-level problems; callers get a
// structured result so tools can return a friendly error string instead.
//
// SECURITY: fetchWithRetry runs an SSRF check (ssrfGuard) before any
// network I/O, so private/loopback/link-local targets are blocked even
// for robots.txt and search-provider calls. The policy is installed by
// configureHttpClient(); when unset it defaults to "protection ON".
// ================================================================

import { assertUrlSafe, SSRF_CODES } from './ssrfGuard.js';

const DEFAULT_TIMEOUT = 15000;

// ─────────────────────────────────────────────────────────────
// Module-level policy installed by configureHttpClient().
// Defaults are safe: SSRF protection ON, no logger.
// ─────────────────────────────────────────────────────────────
let httpPolicy = {
  ssrf: { enabled: true, allowPrivate: false },
  logger: null,
};

// ─────────────────────────────────────────────────────────────
// configureHttpClient({ ssrf, logger })
// Called once by createWebRuntime(). Merges into the current policy.
// ─────────────────────────────────────────────────────────────
export function configureHttpClient({ ssrf, logger } = {}) {
  if (ssrf) httpPolicy.ssrf = { ...httpPolicy.ssrf, ...ssrf };
  if (logger !== undefined) httpPolicy.logger = logger;
}

// ─────────────────────────────────────────────────────────────
// getHttpPolicy()
// Exposed for tests / diagnostics.
// ─────────────────────────────────────────────────────────────
export function getHttpPolicy() {
  return httpPolicy;
}
const DEFAULT_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

// User-Agent we present to search engines / websites.
export const DEFAULT_USER_AGENT = 'QTPi/1.0 (+https://qtpi.dev)';


// ─────────────────────────────────────────────────────────────
// sleep(ms)
// Tiny promise-based delay used between retries.
// ─────────────────────────────────────────────────────────────
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// ─────────────────────────────────────────────────────────────
// isRetryableStatus(status)
// 429 (rate limited) and 5xx (server hiccup) are worth retrying.
// 4xx client errors (bad key, bad request) are NOT.
// ─────────────────────────────────────────────────────────────
export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}


// ─────────────────────────────────────────────────────────────
// computeBackoff(attempt)
// Exponential backoff: 500ms, 1000ms, 2000ms, ... with a bit of
// random jitter so parallel callers don't all retry in lockstep.
// Capped at MAX_BACKOFF_MS.
// ─────────────────────────────────────────────────────────────
export function computeBackoff(attempt) {
  const exponential = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}


// ─────────────────────────────────────────────────────────────
// fetchWithTimeout(url, options, timeoutMs)
// Wraps fetch() with an AbortController so a hung server can't
// stall the agent forever. Returns a normal Response.
// ─────────────────────────────────────────────────────────────
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}


// ─────────────────────────────────────────────────────────────
// readBodyWithLimit(response, maxBytes)
// Streams a Response body and stops once maxBytes is reached, so a
// hostile/huge page can't exhaust memory. Falls back to .text()
// if streaming isn't available.
//
// Returns { text, truncated }.
// ─────────────────────────────────────────────────────────────
export async function readBodyWithLimit(response, maxBytes = 2_000_000) {
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : 2_000_000;

  // Preferred path: stream via the Web Streams reader.
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let received = 0;
    let truncated = false;
    let text = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        received += value.byteLength;
        if (received > limit) {
          // Keep only the portion up to the limit, then stop.
          const allowed = value.byteLength - (received - limit);
          text += decoder.decode(value.subarray(0, Math.max(allowed, 0)), { stream: true });
          truncated = true;
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      // Cancel the rest of the stream so the socket is released.
      try { await reader.cancel(); } catch { /* ignore */ }
    }

    return { text, truncated };
  }

  // Fallback: read everything, then slice.
  const full = await response.text();
  if (full.length > limit) {
    return { text: full.slice(0, limit), truncated: true };
  }
  return { text: full, truncated: false };
}


// ─────────────────────────────────────────────────────────────
// fetchWithRetry(url, options, config)
// Performs a request, retrying on network errors and retryable
// status codes with exponential backoff.
//
// Returns:
//   { ok: true, response }                    on success
//   { ok: false, error, status, attempts }    on failure (never throws)
//
// config: { timeout, retries, userAgent, onRetry }
// ─────────────────────────────────────────────────────────────
export async function fetchWithRetry(url, options = {}, config = {}) {
  const {
    timeout = DEFAULT_TIMEOUT,
    retries = DEFAULT_RETRIES,
    userAgent = DEFAULT_USER_AGENT,
    onRetry = null,
  } = config;

  // ── SSRF gate: block internal/private targets before any network I/O. ──
  const policy = httpPolicy.ssrf;
  if (policy.enabled && !policy.allowPrivate) {
    const safe = await assertUrlSafe(url, { allowPrivate: policy.allowPrivate });
    if (!safe.ok) {
      // A DNS failure isn't an attack — word it plainly so users don't
      // chase a security rabbit hole when a host is simply unreachable.
      const message = safe.code === SSRF_CODES.DNS_FAILED
        ? `Could not verify host safety: ${safe.reason}`
        : `Blocked by SSRF protection: ${safe.reason}`;
      if (httpPolicy.logger) {
        httpPolicy.logger.record({
          type: 'fetch',
          url: String(url),
          ok: false,
          status: safe.code,
          error: message,
        });
      }
      return { ok: false, status: null, error: message, attempts: 0, blocked: true, code: safe.code };
    }
  }

  const headers = {
    'User-Agent': userAgent,
    ...(options.headers || {}),
  };

  const elapsed = httpPolicy.logger ? httpPolicy.logger.startTimer() : null;
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(
        url,
        { ...options, headers },
        timeout
      );

      // Success (or a non-retryable error) → return to caller.
      if (response.ok || !isRetryableStatus(response.status)) {
        logFetch({
          url,
          method: options.method || 'GET',
          status: response.status,
          ok: response.ok,
          durationMs: elapsed ? elapsed() : undefined,
          attempts: attempt + 1,
        });
        return { ok: response.ok, response, status: response.status, attempts: attempt + 1 };
      }

      // Retryable status (429 / 5xx)
      lastStatus = response.status;

      // Respect a Retry-After header when the server sends one.
      const retryAfter = Number(response.headers.get('retry-after'));
      let waitMs;
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        waitMs = Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
      } else {
        waitMs = computeBackoff(attempt);
      }

      if (attempt < retries) {
        if (onRetry) onRetry({ attempt: attempt + 1, status: response.status, waitMs });
        await sleep(waitMs);
        continue;
      }

      logFetch({
        url,
        method: options.method || 'GET',
        status: response.status,
        ok: false,
        durationMs: elapsed ? elapsed() : undefined,
        attempts: attempt + 1,
      });
      return { ok: false, status: response.status, error: `HTTP ${response.status}`, attempts: attempt + 1 };
    } catch (error) {
      // Abort (timeout) or network-level failure → retry.
      lastError = error.name === 'AbortError'
        ? `Request timed out after ${timeout}ms`
        : error.message;

      if (attempt < retries) {
        const waitMs = computeBackoff(attempt);
        if (onRetry) onRetry({ attempt: attempt + 1, error: lastError, waitMs });
        await sleep(waitMs);
        continue;
      }
    }
  }

  logFetch({
    url,
    method: options.method || 'GET',
    status: lastStatus,
    ok: false,
    error: lastError,
    durationMs: elapsed ? elapsed() : undefined,
    attempts: retries + 1,
  });

  return {
    ok: false,
    status: lastStatus,
    error: lastError || (lastStatus ? `HTTP ${lastStatus}` : 'Request failed'),
    attempts: retries + 1,
  };
}


// ─────────────────────────────────────────────────────────────
// logFetch(fields)
// Emits one structured log entry per request when a logger is set.
// Never throws — logging is best-effort.
// ─────────────────────────────────────────────────────────────
function logFetch(fields) {
  if (!httpPolicy.logger) return;
  try {
    httpPolicy.logger.record({ type: 'fetch', ...fields });
  } catch {
    // Ignore logging errors.
  }
}
