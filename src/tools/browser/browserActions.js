// ================================================================
// FILE: src/tools/browser/browserActions.js
// PURPOSE: The single implementation of every browser action.
//
// Both agent-facing tools delegate here so they behave identically:
//   - `browser`          → runs ONE action
//   - `browser_command`  → runs a SEQUENCE of actions
//
// Design rules:
//   - NEVER throws. Every failure becomes a readable string so the
//     agent loop keeps going and can react.
//   - Navigation is guarded by the shared SSRF policy BEFORE any
//     browser is launched (so a blocked URL costs nothing).
//   - The browser is launched lazily by the runtime on first real
//     page use; read-only actions like `pages` never launch it.
//
// Actions:
//   goto | open | navigate   url, waitUntil?
//   click                    selector
//   type | fill              selector, text
//   press                    key
//   select                   selector, value
//   hover                    selector
//   scroll                   selector? | x?, y?
//   read | text              selector? (default body), maxChars?
//   html | content           maxChars?
//   title
//   url
//   links                    limit?
//   screenshot               path?, fullPage?
//   eval                     script, confirm?
//   wait                     selector? | ms?
//   back | forward | reload
//   newPage                  page?
//   close                    page?
//   pages
//   closeAll
// ================================================================

import path from 'path';
import fs from 'fs';
import { assertUrlSafe } from '../web/ssrfGuard.js';

const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_LINKS = 50;

// ─────────────────────────────────────────────────────────────
// createBrowserActions(runtime, config)
// `runtime` is the object returned by createBrowserRuntime().
// Returns { run(args) } where run() always resolves to a string.
// ─────────────────────────────────────────────────────────────
export function createBrowserActions(runtime, config = null) {
  if (!runtime) throw new Error('createBrowserActions requires a browser runtime');

  const settings = runtime.settings;
  const logger = runtime.logger;

  // ── small helpers ───────────────────────────────────────────
  const pageName = (args) => (args.page ? String(args.page) : 'main');

  function log(event) {
    if (logger) logger.record({ type: 'browser', ...event });
  }

  // Guard a URL against the SSRF policy. Returns { ok, reason? }.
  async function guardUrl(url) {
    if (!settings.ssrf || settings.ssrf.enabled === false) return { ok: true };
    const result = await assertUrlSafe(url, { allowPrivate: settings.ssrf.allowPrivate });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason || result.code };
  }

  function requireArg(args, key, action) {
    const value = args[key];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`action "${action}" requires a non-empty "${key}"`);
    }
    return String(value);
  }

  // ───────────────────────────────────────────────────────────
  // run(args)
  // Dispatches one action. Always returns a string.
  // ───────────────────────────────────────────────────────────
  async function run(args = {}) {
    const action = String(args.action || '').toLowerCase().trim();
    if (!action) {
      return '❌ browser requires an "action" (e.g. "goto", "click", "read", "screenshot").';
    }

    try {
      return await dispatch(action, args);
    } catch (error) {
      log({ event: 'action', action, ok: false, error: error.message });
      return `❌ browser action "${action}" failed: ${error.message}`;
    }
  }

  // ───────────────────────────────────────────────────────────
  // dispatch(action, args)
  // ───────────────────────────────────────────────────────────
  async function dispatch(action, args) {
    switch (action) {
      // ── navigation ──────────────────────────────────────────
      case 'goto':
      case 'open':
      case 'navigate': {
        const url = requireArg(args, 'url', action);
        const guard = await guardUrl(url);
        if (!guard.ok) {
          log({ event: 'goto', url, ok: false, blocked: true });
          return `❌ Blocked by SSRF policy: ${guard.reason}`;
        }

        const page = await runtime.getPage(pageName(args));
        const response = await page.goto(url, {
          waitUntil: args.waitUntil || 'domcontentloaded',
          timeout: settings.timeout,
        });
        const status = response ? response.status() : 'n/a';
        const title = await page.title().catch(() => '');
        log({ event: 'goto', url, status, ok: true });
        return [
          `✅ Navigated to ${page.url()}`,
          `   status: ${status}`,
          `   title: ${title || '(none)'}`,
          `   page: ${pageName(args)}`,
        ].join('\n');
      }

      case 'back': {
        const page = await runtime.getPage(pageName(args));
        await page.goBack({ timeout: settings.timeout });
        return `✅ Went back → ${page.url()}`;
      }

      case 'forward': {
        const page = await runtime.getPage(pageName(args));
        await page.goForward({ timeout: settings.timeout });
        return `✅ Went forward → ${page.url()}`;
      }

      case 'reload': {
        const page = await runtime.getPage(pageName(args));
        await page.reload({ timeout: settings.timeout });
        return `✅ Reloaded ${page.url()}`;
      }

      // ── interaction ─────────────────────────────────────────
      case 'click': {
        const selector = requireArg(args, 'selector', action);
        const page = await runtime.getPage(pageName(args));
        await page.click(selector, { timeout: settings.timeout });
        log({ event: 'click', selector, ok: true });
        return `✅ Clicked "${selector}" on page "${pageName(args)}" (now ${page.url()})`;
      }

      case 'type':
      case 'fill': {
        const selector = requireArg(args, 'selector', action);
        const text = args.text ?? args.value ?? '';
        const page = await runtime.getPage(pageName(args));
        await page.fill(selector, String(text), { timeout: settings.timeout });
        log({ event: 'fill', selector, ok: true });
        return `✅ Filled "${selector}" with ${String(text).length} character(s).`;
      }

      case 'press': {
        const key = requireArg(args, 'key', action);
        const page = await runtime.getPage(pageName(args));
        await page.keyboard.press(key);
        return `✅ Pressed "${key}".`;
      }

      case 'select': {
        const selector = requireArg(args, 'selector', action);
        const value = requireArg(args, 'value', action);
        const page = await runtime.getPage(pageName(args));
        const selected = await page.selectOption(selector, value, { timeout: settings.timeout });
        return `✅ Selected ${JSON.stringify(selected)} in "${selector}".`;
      }

      case 'hover': {
        const selector = requireArg(args, 'selector', action);
        const page = await runtime.getPage(pageName(args));
        await page.hover(selector, { timeout: settings.timeout });
        return `✅ Hovered "${selector}".`;
      }

      case 'scroll': {
        const page = await runtime.getPage(pageName(args));
        if (args.selector) {
          await page.locator(String(args.selector)).first().scrollIntoViewIfNeeded({ timeout: settings.timeout });
          return `✅ Scrolled "${args.selector}" into view.`;
        }
        const x = Number(args.x) || 0;
        const y = Number(args.y) || 0;
        await page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [x, y]);
        return `✅ Scrolled by (${x}, ${y}).`;
      }

      // ── reading ─────────────────────────────────────────────
      case 'read':
      case 'text': {
        const selector = args.selector ? String(args.selector) : 'body';
        const maxChars = Number(args.maxChars) || DEFAULT_MAX_CHARS;
        const page = await runtime.getPage(pageName(args));
        const text = await page.locator(selector).first().innerText({ timeout: settings.timeout });
        const clean = String(text || '').trim();
        if (!clean) return `ℹ️  "${selector}" is empty on ${page.url()}.`;
        return [
          `📄 Text of "${selector}" on ${page.url()}:`,
          '',
          truncate(clean, maxChars),
        ].join('\n');
      }

      case 'html':
      case 'content': {
        const maxChars = Number(args.maxChars) || DEFAULT_MAX_CHARS;
        const page = await runtime.getPage(pageName(args));
        const html = await page.content();
        return [
          `📄 HTML of ${page.url()} (${html.length} chars):`,
          '',
          truncate(html, maxChars),
        ].join('\n');
      }

      case 'title': {
        const page = await runtime.getPage(pageName(args));
        const title = await page.title();
        return `📄 Title: ${title || '(none)'}`;
      }

      case 'url': {
        const page = await runtime.getPage(pageName(args));
        return `📄 URL: ${page.url()}`;
      }

      case 'links': {
        const limit = Number(args.limit) || DEFAULT_LINKS;
        const page = await runtime.getPage(pageName(args));
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]')).map((a) => ({
            text: (a.innerText || a.textContent || '').trim().slice(0, 120),
            href: a.href,
          }))
        );
        if (!links.length) return `ℹ️  No links found on ${page.url()}.`;
        const shown = links.slice(0, limit);
        const lines = shown.map((l, i) => `${i + 1}. ${l.text || '(no text)'}\n   ${l.href}`);
        const more = links.length > shown.length ? `\n\n… and ${links.length - shown.length} more.` : '';
        return `🔗 ${links.length} link(s) on ${page.url()}:\n\n${lines.join('\n')}${more}`;
      }

      // ── capture ─────────────────────────────────────────────
      case 'screenshot': {
        const page = await runtime.getPage(pageName(args));
        const file = args.path
          ? path.resolve(settings.downloadDir, String(args.path))
          : path.join(settings.downloadDir, `screenshot-${Date.now()}.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, fullPage: Boolean(args.fullPage) });
        log({ event: 'screenshot', file, ok: true });
        return `📸 Screenshot saved to ${file}`;
      }

      // ── scripting ───────────────────────────────────────────
      case 'eval':
      case 'evaluate': {
        const script = requireArg(args, 'script', action);
        if (settings.confirmDestructive && args.confirm !== true) {
          return [
            '⚠️  "eval" runs arbitrary JavaScript in the page and is gated by',
            '   browserConfirmDestructive (default: true).',
            '   Re-run with confirm: true to proceed.',
          ].join('\n');
        }
        const page = await runtime.getPage(pageName(args));
        const result = await page.evaluate(script);
        const rendered = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return `✅ eval result:\n${truncate(rendered ?? 'undefined', DEFAULT_MAX_CHARS)}`;
      }

      case 'wait': {
        const page = await runtime.getPage(pageName(args));
        if (args.selector) {
          await page.waitForSelector(String(args.selector), { timeout: Number(args.timeout) || settings.timeout });
          return `✅ "${args.selector}" appeared.`;
        }
        const ms = Number(args.ms) || 1000;
        await page.waitForTimeout(ms);
        return `✅ Waited ${ms}ms.`;
      }

      // ── page management (no browser launch for read-only) ───
      case 'newpage':
      case 'new_page': {
        const name = pageName(args);
        await runtime.newPage(name);
        return `✅ Opened page "${name}". Open pages: ${runtime.pageNames.join(', ')}`;
      }

      case 'close': {
        const name = pageName(args);
        const existed = await runtime.closePage(name);
        return existed
          ? `✅ Closed page "${name}". Open pages: ${runtime.pageNames.join(', ') || '(none)'}`
          : `ℹ️  No page named "${name}" was open.`;
      }

      case 'pages': {
        const names = runtime.pageNames;
        return names.length
          ? `📑 Open pages: ${names.join(', ')}`
          : '📑 No pages are open yet.';
      }

      case 'closeall':
      case 'close_all': {
        await runtime.closeAll();
        return '✅ Closed all pages and the browser.';
      }

      default:
        return [
          `❌ Unknown browser action "${action}".`,
          '',
          'Supported actions:',
          '  goto, click, type/fill, press, select, hover, scroll,',
          '  read/text, html/content, title, url, links, screenshot,',
          '  eval, wait, back, forward, reload,',
          '  newPage, close, pages, closeAll',
        ].join('\n');
    }
  }

  return { run };
}


// ─────────────────────────────────────────────────────────────
// truncate(text, max)
// ─────────────────────────────────────────────────────────────
function truncate(text, max) {
  const str = String(text ?? '');
  return str.length > max ? str.slice(0, max) + `\n… (${str.length - max} more chars)` : str;
}
