// ================================================================
// FILE: src/tools/browser/browserRuntime.js
// PURPOSE: One place that turns the config wrapper into the shared
// browser-automation services used by the `browser` and
// `browser_command` tools.
//
// Mirrors src/tools/web/webRuntime.js: index.js creates a single
// runtime and passes it to the register* functions so every action
// shares ONE Chromium instance, ONE page map, ONE logger and ONE
// SSRF policy.
//
// Design:
//   - The browser is launched LAZILY on first use (not at startup),
//     so users who never touch the browser tools pay nothing.
//   - Named pages live in a Map ("main", "tab2", ...) so multi-step
//     commands can keep operating on the same tab.
//   - A process-exit / SIGINT hook closes the browser cleanly.
//
// Config keys (all optional, safe defaults):
//   browserHeadless            bool    default true
//   browserTimeout             number  default 30000 (ms per action)
//   browserUserAgent           string  default QTPi/1.0 (+https://qtpi.dev)
//   browserViewportWidth       number  default 1280
//   browserViewportHeight      number  default 800
//   browserDownloadDir         string  default <cwd>/.qtpi/downloads
//   browserMaxPages            number  default 5
//   browserConfirmDestructive  bool    default true
//   browserSsrfProtection      bool    default true
//   browserAllowPrivateHosts   bool    default false
//   browserLogEnabled          bool    default false
// ================================================================

import path from 'path';
import os from 'os';
import { createWebLogger } from '../web/webLogger.js';

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

const DEFAULT_USER_AGENT = 'QTPi/1.0 (+https://qtpi.dev)';

// ─────────────────────────────────────────────────────────────
// createBrowserRuntime(config, options)
// Builds the shared browser services. `options.logger` lets a caller
// inject the web runtime's logger so browser + web activity share one
// log stream; otherwise a dedicated browser logger is created.
// ─────────────────────────────────────────────────────────────
export function createBrowserRuntime(config, options = {}) {
  const settings = {
    headless: readBool(config, 'browserHeadless', true),
    timeout: readNumber(config, 'browserTimeout', 30_000),
    userAgent: readConfig(config, 'browserUserAgent') || DEFAULT_USER_AGENT,
    viewportWidth: readNumber(config, 'browserViewportWidth', 1280),
    viewportHeight: readNumber(config, 'browserViewportHeight', 800),
    downloadDir:
      readConfig(config, 'browserDownloadDir') ||
      path.join(process.cwd(), '.qtpi', 'downloads'),
    maxPages: readNumber(config, 'browserMaxPages', 5),
    confirmDestructive: readBool(config, 'browserConfirmDestructive', true),
    sandboxEnabled: readBool(config, 'sandboxEnabled', false),
    ssrf: {
      enabled: readBool(config, 'browserSsrfProtection', true),
      allowPrivate: readBool(config, 'browserAllowPrivateHosts', false),
    },
  };

  const logger =
    options.logger ||
    createWebLogger({
      enabled: readBool(config, 'browserLogEnabled', false),
      toFile: readBool(config, 'browserLogToFile', true),
      toConsole: readBool(config, 'browserLogToConsole', false),
      file: readConfig(config, 'browserLogFile') || path.join(os.homedir(), '.qtpi', 'browser.log'),
    });

  // ── Lazy state ──────────────────────────────────────────────
  let browser = null;          // the Playwright Browser (or null)
  let launching = null;        // in-flight launch promise (dedupe)
  const pages = new Map();     // name -> Playwright Page
  let hooksInstalled = false;
  let closed = false;

  // ───────────────────────────────────────────────────────────
  // launch()
  // Lazily starts Chromium. Concurrent callers share one launch.
  // ───────────────────────────────────────────────────────────
  async function launch() {
    if (browser && browser.isConnected()) return browser;
    if (launching) return launching;

    launching = (async () => {
      // Imported lazily so the (heavy) Playwright module is only
      // loaded when a browser action is actually requested.
      const { chromium } = await import('playwright');

      browser = await chromium.launch({
        headless: settings.headless,
        downloadsPath: settings.downloadDir,
        chromiumSandbox: settings.sandboxEnabled,
      });

      browser.on('disconnected', () => {
        browser = null;
        pages.clear();
      });

      installHooks();
      if (logger) logger.record({ type: 'browser', event: 'launch', headless: settings.headless });
      return browser;
    })();

    try {
      return await launching;
    } finally {
      launching = null;
    }
  }

  // ───────────────────────────────────────────────────────────
  // newPage(name)
  // Creates (or returns) a named page with the configured viewport
  // and user agent. Enforces the maxPages ceiling.
  // ───────────────────────────────────────────────────────────
  async function newPage(name = 'main') {
    if (pages.has(name)) return pages.get(name);

    if (pages.size >= settings.maxPages) {
      throw new Error(
        `browserMaxPages limit reached (${settings.maxPages}). Close a page first (action "close").`
      );
    }

    const b = await launch();
    const context = await b.newContext({
      userAgent: settings.userAgent,
      viewport: { width: settings.viewportWidth, height: settings.viewportHeight },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(settings.timeout);
    page.setDefaultNavigationTimeout(settings.timeout);

    // Track the context so closePage can dispose it cleanly.
    page.__qtpiContext = context;
    pages.set(name, page);
    if (logger) logger.record({ type: 'browser', event: 'newPage', page: name });
    return page;
  }

  // ───────────────────────────────────────────────────────────
  // getPage(name)
  // Returns an existing page, or creates "main" on demand.
  // ───────────────────────────────────────────────────────────
  async function getPage(name = 'main') {
    if (pages.has(name)) return pages.get(name);
    return newPage(name);
  }

  // ───────────────────────────────────────────────────────────
  // closePage(name)
  // Closes one named page (and its context). Returns true if it
  // existed.
  // ───────────────────────────────────────────────────────────
  async function closePage(name = 'main') {
    const page = pages.get(name);
    if (!page) return false;
    pages.delete(name);
    try {
      const context = page.__qtpiContext;
      if (context) await context.close();
      else await page.close();
    } catch {
      // best-effort
    }
    if (logger) logger.record({ type: 'browser', event: 'closePage', page: name });
    return true;
  }

  // ───────────────────────────────────────────────────────────
  // closeAll()
  // Closes every page and the browser. Safe to call repeatedly.
  // ───────────────────────────────────────────────────────────
  async function closeAll() {
    closed = true;
    for (const name of Array.from(pages.keys())) {
      await closePage(name);
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        // best-effort
      }
      browser = null;
    }
    if (logger) logger.record({ type: 'browser', event: 'closeAll' });
  }

  // ───────────────────────────────────────────────────────────
  // installHooks()
  // Ensures the browser is closed on process exit / SIGINT. Installed
  // once, on first launch.
  // ───────────────────────────────────────────────────────────
  function installHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;

    const shutdown = () => {
      // Synchronous best-effort: Playwright's close is async, but on
      // exit we just want the child process reaped.
      try {
        if (browser) browser.close().catch(() => {});
      } catch {
        // ignore
      }
    };

    process.once('exit', shutdown);
    process.once('SIGINT', () => {
      shutdown();
      // Re-raise so the default handler still terminates the process.
      process.exit(130);
    });
    process.once('SIGTERM', () => {
      shutdown();
      process.exit(143);
    });
  }

  return {
    settings,
    logger,
    launch,
    newPage,
    getPage,
    closePage,
    closeAll,
    get pageNames() {
      return Array.from(pages.keys());
    },
    get isLaunched() {
      return Boolean(browser && browser.isConnected());
    },
    get isClosed() {
      return closed;
    },
  };
}
