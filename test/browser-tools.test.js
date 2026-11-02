// ================================================================
// FILE: test/browser-tools.test.js
// PURPOSE: Offline, deterministic tests for the browser tools:
//   browser          (src/tools/browserTool.js)
//   browser_command  (src/tools/browserCommandTool.js)
//   + the shared action layer (src/tools/browser/browserActions.js)
//   + the shared runtime (src/tools/browser/browserRuntime.js)
//
// Run with:  npm test            (node --test)
//            npm run test:browser
//            node --test test/browser-tools.test.js
//
// These tests NEVER launch a real Chromium. The runtime is exercised
// only for its pure config mapping, and the action layer is driven
// against a STUB runtime so every assertion is fast and hermetic.
// Live coverage lives in examples/browser-tools-example.mjs and
// `npm run test:browser:live` (see docs/BROWSER_TOOLS.md).
// ================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';

import { createBrowserRuntime } from '../src/tools/browser/browserRuntime.js';
import { createBrowserActions } from '../src/tools/browser/browserActions.js';

import { createRegistry, registerTool, executeTool } from '../src/tools/ToolRegistry.js';
import { registerBrowserTools } from '../src/tools/browserTool.js';
import { registerBrowserCommandTools } from '../src/tools/browserCommandTool.js';


// ─────────────────────────────────────────────────────────────
// A minimal fake Playwright page. Only the methods the action
// layer actually calls are implemented; everything returns a
// deterministic value so assertions are stable.
// ─────────────────────────────────────────────────────────────
function fakePage(name = 'main') {
  return {
    __name: name,
    _url: 'https://example.com/',
    async goto(url) {
      this._url = url;
      return { status: () => 200 };
    },
    url() {
      return this._url;
    },
    async title() {
      return 'Example Domain';
    },
    async click() {},
    async fill() {},
    async selectOption() {
      return ['opt'];
    },
    async hover() {},
    async content() {
      return '<html><body>hi</body></html>';
    },
    async screenshot() {},
    async goBack() {},
    async goForward() {},
    async reload() {},
    async waitForSelector() {},
    async waitForTimeout() {},
    async evaluate(fn) {
      // Playwright accepts a function OR a string expression. Our stub
      // returns a fixed marker so we can assert the eval path ran.
      return typeof fn === 'function' ? fn() : 'EVAL_RESULT';
    },
    locator() {
      return {
        first() {
          return this;
        },
        async innerText() {
          return 'Hello body text';
        },
        async scrollIntoViewIfNeeded() {},
      };
    },
    keyboard: { async press() {} },
  };
}


// ─────────────────────────────────────────────────────────────
// A stub runtime that satisfies the createBrowserActions contract
// (settings, logger, getPage, newPage, closePage, closeAll,
// pageNames) WITHOUT touching Playwright.
// ─────────────────────────────────────────────────────────────
function makeStubRuntime(settingsOverrides = {}) {
  const pages = new Map();
  const calls = [];

  const runtime = {
    calls,
    logger: null,
    settings: {
      timeout: 1000,
      confirmDestructive: true,
      ssrf: { enabled: false, allowPrivate: false },
      downloadDir: os.tmpdir(),
      ...settingsOverrides,
    },
    async getPage(name = 'main') {
      calls.push(['getPage', name]);
      if (!pages.has(name)) pages.set(name, fakePage(name));
      return pages.get(name);
    },
    async newPage(name = 'main') {
      calls.push(['newPage', name]);
      if (!pages.has(name)) pages.set(name, fakePage(name));
      return pages.get(name);
    },
    async closePage(name = 'main') {
      calls.push(['closePage', name]);
      return pages.delete(name);
    },
    async closeAll() {
      calls.push(['closeAll']);
      pages.clear();
    },
    get pageNames() {
      return Array.from(pages.keys());
    },
  };

  return runtime;
}


// ─────────────────────────────────────────────────────────────
// Step 1: runtime config mapping (pure — no browser launch)
// ─────────────────────────────────────────────────────────────
describe('browserRuntime', () => {
  test('applies config values', () => {
    const values = {
      browserHeadless: false,
      browserTimeout: 1234,
      browserMaxPages: 3,
      browserConfirmDestructive: false,
      browserSsrfProtection: false,
      browserAllowPrivateHosts: true,
      browserViewportWidth: 800,
      browserViewportHeight: 600,
      browserUserAgent: 'TestAgent/9',
    };
    const runtime = createBrowserRuntime({ get: (k) => values[k] });

    assert.equal(runtime.settings.headless, false);
    assert.equal(runtime.settings.timeout, 1234);
    assert.equal(runtime.settings.maxPages, 3);
    assert.equal(runtime.settings.confirmDestructive, false);
    assert.equal(runtime.settings.ssrf.enabled, false);
    assert.equal(runtime.settings.ssrf.allowPrivate, true);
    assert.equal(runtime.settings.viewportWidth, 800);
    assert.equal(runtime.settings.viewportHeight, 600);
    assert.equal(runtime.settings.userAgent, 'TestAgent/9');
  });

  test('falls back to safe defaults when config is empty', () => {
    const runtime = createBrowserRuntime({ get: () => undefined });

    assert.equal(runtime.settings.headless, true);
    assert.equal(runtime.settings.timeout, 30000);
    assert.equal(runtime.settings.maxPages, 5);
    assert.equal(runtime.settings.confirmDestructive, true);
    assert.equal(runtime.settings.ssrf.enabled, true);
    assert.equal(runtime.settings.ssrf.allowPrivate, false);
    assert.equal(runtime.settings.viewportWidth, 1280);
    assert.equal(runtime.settings.viewportHeight, 800);
    assert.equal(runtime.settings.userAgent, 'QTPi/1.0 (+https://qtpi.dev)');
  });

  test('coerces string booleans ("true"/"false")', () => {
    const runtime = createBrowserRuntime({
      get: (k) => ({ browserHeadless: 'false', browserConfirmDestructive: 'false' }[k]),
    });
    assert.equal(runtime.settings.headless, false);
    assert.equal(runtime.settings.confirmDestructive, false);
  });

  test('starts idle: not launched, not closed, no pages', () => {
    const runtime = createBrowserRuntime({ get: () => undefined });
    assert.equal(runtime.isLaunched, false);
    assert.equal(runtime.isClosed, false);
    assert.deepEqual(runtime.pageNames, []);
  });
});


// ─────────────────────────────────────────────────────────────
// Step 2: action layer against a stub runtime (no browser)
// ─────────────────────────────────────────────────────────────
describe('browser actions (offline, stubbed runtime)', () => {
  test('missing action returns a helpful string (never throws)', async () => {
    const actions = createBrowserActions(makeStubRuntime());
    const out = await actions.run({});
    assert.equal(typeof out, 'string');
    assert.match(out, /requires an "action"/);
  });

  test('unknown action lists the supported actions', async () => {
    const actions = createBrowserActions(makeStubRuntime());
    const out = await actions.run({ action: 'frobnicate' });
    assert.match(out, /Unknown browser action "frobnicate"/);
    assert.match(out, /Supported actions/);
  });

  test('goto blocks a private URL via the SSRF policy before any page use', async () => {
    const runtime = makeStubRuntime({ ssrf: { enabled: true, allowPrivate: false } });
    const actions = createBrowserActions(runtime);
    const out = await actions.run({ action: 'goto', url: 'http://127.0.0.1/' });
    assert.match(out, /Blocked by SSRF policy/);
    // The guard must short-circuit BEFORE the runtime is asked for a page.
    assert.equal(runtime.calls.length, 0);
  });

  test('goto navigates and reports status/title/page', async () => {
    const actions = createBrowserActions(makeStubRuntime());
    const out = await actions.run({ action: 'goto', url: 'https://example.com/' });
    assert.match(out, /Navigated to https:\/\/example\.com\//);
    assert.match(out, /status: 200/);
    assert.match(out, /title: Example Domain/);
  });

  test('read returns the element text', async () => {
    const actions = createBrowserActions(makeStubRuntime());
    const out = await actions.run({ action: 'read' });
    assert.match(out, /Hello body text/);
  });

  test('pages reports none open, then reflects newPage/close', async () => {
    const runtime = makeStubRuntime();
    const actions = createBrowserActions(runtime);

    assert.match(await actions.run({ action: 'pages' }), /No pages are open/);
    assert.match(await actions.run({ action: 'newPage', page: 'tab2' }), /Opened page "tab2"/);
    assert.match(await actions.run({ action: 'pages' }), /tab2/);
    assert.match(await actions.run({ action: 'close', page: 'tab2' }), /Closed page "tab2"/);
  });

  test('eval is gated by confirmDestructive (rejects without confirm)', async () => {
    const runtime = makeStubRuntime({ confirmDestructive: true });
    const actions = createBrowserActions(runtime);
    const out = await actions.run({ action: 'eval', script: '1 + 1' });
    assert.match(out, /browserConfirmDestructive/);
    assert.match(out, /confirm: true/);
    // Gated call must not touch the page.
    assert.equal(runtime.calls.length, 0);
  });

  test('eval runs when confirm: true is supplied', async () => {
    const actions = createBrowserActions(makeStubRuntime({ confirmDestructive: true }));
    const out = await actions.run({ action: 'eval', script: '1 + 1', confirm: true });
    assert.match(out, /eval result/);
    assert.match(out, /EVAL_RESULT/);
  });

  test('eval runs without confirm when the gate is disabled', async () => {
    const actions = createBrowserActions(makeStubRuntime({ confirmDestructive: false }));
    const out = await actions.run({ action: 'eval', script: '1 + 1' });
    assert.match(out, /EVAL_RESULT/);
  });
});


// ─────────────────────────────────────────────────────────────
// Step 3: tools via the registry — registration & "never throws"
// ─────────────────────────────────────────────────────────────
describe('browser tools via registry', () => {
  function buildRegistry(runtime = makeStubRuntime()) {
    const registry = createRegistry();
    const config = { get: () => undefined };
    registerBrowserTools(registry, config, runtime);
    registerBrowserCommandTools(registry, config, runtime);
    return registry;
  }

  test('both tools are registered with definitions', () => {
    const registry = buildRegistry();
    assert.ok(registry.has('browser'));
    assert.ok(registry.has('browser_command'));
    assert.equal(registry.get('browser').definition.name, 'browser');
    assert.ok(registry.get('browser').definition.parameters.required.includes('action'));
    assert.ok(registry.get('browser').definition.parameters.properties.action.enum.includes('goto'));
    assert.ok(registry.get('browser_command').definition.parameters.required.includes('steps'));
  });

  test('registerBrowserTools throws without a runtime', () => {
    assert.throws(
      () => registerBrowserTools(createRegistry(), { get: () => undefined }, null),
      /requires a browser runtime/
    );
  });

  test('registerBrowserCommandTools throws without a runtime', () => {
    assert.throws(
      () => registerBrowserCommandTools(createRegistry(), { get: () => undefined }, null),
      /requires a browser runtime/
    );
  });

  test('browser rejects a missing action without throwing', async () => {
    const registry = buildRegistry();
    const out = await executeTool(registry, 'browser', {});
    assert.equal(typeof out, 'string');
    assert.match(out, /requires an "action"/);
  });

  test('browser_command rejects empty steps without throwing', async () => {
    const registry = buildRegistry();
    const out = await executeTool(registry, 'browser_command', { steps: [] });
    assert.equal(typeof out, 'string');
    assert.match(out, /non-empty "steps"/);
  });

  test('browser_command runs a sequence and stops at the first failure', async () => {
    const registry = buildRegistry();
    const out = await executeTool(registry, 'browser_command', {
      steps: [{ action: 'pages' }, { action: 'bogus' }, { action: 'pages' }],
    });
    assert.match(out, /stopped at step 2 of 3/);
    assert.match(out, /\[1\/3\] pages/);
    assert.match(out, /\[2\/3\] bogus/);
    // Step 3 must NOT have run (stopOnError defaults to true).
    assert.ok(!/\[3\/3\]/.test(out), 'step 3 should not run after a failure');
  });

  test('browser_command continues past failures when stopOnError is false', async () => {
    const registry = buildRegistry();
    const out = await executeTool(registry, 'browser_command', {
      steps: [{ action: 'bogus' }, { action: 'pages' }],
      stopOnError: false,
    });
    assert.match(out, /\[1\/2\] bogus/);
    assert.match(out, /\[2\/2\] pages/);
  });

  test('browser_command caps the number of steps it runs', async () => {
    const registry = buildRegistry();
    const steps = Array.from({ length: 30 }, () => ({ action: 'pages' }));
    const out = await executeTool(registry, 'browser_command', { steps });
    assert.match(out, /Only the first 25 of 30 steps were run/);
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
