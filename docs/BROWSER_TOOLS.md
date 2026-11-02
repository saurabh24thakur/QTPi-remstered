# 🖥️ Browser Tools: `browser` & `browser_command`

QTPi can drive a **real Chromium browser** through Playwright. Two tools expose it:

| Tool | Use it for |
|------|-----------|
| `browser` | **One** action per call — navigate, click, type, read, screenshot, eval, manage tabs. |
| `browser_command` | A **sequence** of actions in one call — e.g. `goto → type → click → read`. |

Both tools share **one** Chromium instance, **one** page map, **one** logger and **one**
SSRF policy (created once in `src/index.js` via `createBrowserRuntime`). That means a
`browser` call and a `browser_command` call operate on the *same* tabs.

> **Lazy launch:** Chromium is only started the first time an action actually needs a
> page. If you never use these tools, you pay nothing at startup. Read-only actions
> like `pages` never launch the browser.

---

## 1. `browser`

Runs exactly one action. Always returns a **string** (it never throws), so the agent
loop keeps going and can react to a failure.

### Parameters

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `action` | string | ✅ | One of the actions below. |
| `url` | string | for `goto` | Must be `http`/`https`; SSRF-guarded. |
| `selector` | string | for `click`/`type`/`fill`/`select`/`hover`/`scroll`/`read`/`wait` | CSS selector. |
| `text` | string | for `type`/`fill` | Text to enter. |
| `value` | string | for `select` | Option value (also accepted as an alias of `text` for `fill`). |
| `key` | string | for `press` | e.g. `Enter`, `Tab`, `Control+A`. |
| `script` | string | for `eval` | JavaScript to evaluate in the page. |
| `confirm` | boolean | for `eval` | Must be `true` when `browserConfirmDestructive` is on. |
| `page` | string | — | Named tab (default `main`). |
| `path` | string | — | Screenshot filename, relative to `browserDownloadDir`. |
| `fullPage` | boolean | — | Capture the full scrollable page. |
| `waitUntil` | string | — | `load` \| `domcontentloaded` \| `networkidle` \| `commit` (default `domcontentloaded`). |
| `maxChars` | number | — | Truncate `read`/`html` output (default `8000`). |
| `limit` | number | — | Max links for `links` (default `50`). |
| `ms` | number | — | Wait duration for `wait` when no selector is given. |
| `x`, `y` | number | — | Scroll deltas for `scroll`. |

### Actions

| Action | Aliases | What it does |
|--------|---------|--------------|
| `goto` | `open`, `navigate` | Navigate the named page; reports status, title, URL. |
| `click` | — | Click a selector. |
| `type` | `fill` | Fill an input with `text`. |
| `press` | — | Press a keyboard key. |
| `select` | — | Choose an `<option>` by value. |
| `hover` | — | Hover a selector. |
| `scroll` | — | Scroll an element into view, or by `x`/`y`. |
| `read` | `text` | Read visible text (default `body`), truncated to `maxChars`. |
| `html` | `content` | Read page HTML, truncated to `maxChars`. |
| `title` | — | Page title. |
| `url` | — | Current URL. |
| `links` | — | List `a[href]` links (text + absolute href), capped by `limit`. |
| `screenshot` | — | Save a PNG under `browserDownloadDir`. |
| `eval` | `evaluate` | Run JS in the page — **gated**, see safety. |
| `wait` | — | Wait for a selector, or for `ms` milliseconds. |
| `back` / `forward` / `reload` | — | History / reload. |
| `newPage` | `new_page` | Open a named tab (subject to `browserMaxPages`). |
| `close` | — | Close a named tab. |
| `pages` | — | List open tabs (does **not** launch the browser). |
| `closeAll` | `close_all` | Close every tab and the browser. |

### Return shape

Success lines start with `✅`, informational with `ℹ️`/`📄`/`📑`/`🔗`/`📸`, and
failures with `❌`. Examples:

```
✅ Navigated to https://example.com/
   status: 200
   title: Example Domain
   page: main
```

```
📄 Text of "body" on https://example.com/:

Example Domain
This domain is for use in illustrative examples…
```

```
❌ Blocked by SSRF policy: private_ip
```

---

## 2. `browser_command`

Runs an ordered list of steps in **one** call. Each step is an object with an `action`
plus the same arguments as the `browser` tool. Steps share one page (default `main`).

### Parameters

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `steps` | array | ✅ | Ordered actions, **max 25**. Each item: `{ action, ...args }`. |
| `stopOnError` | boolean | — | Stop at the first failing step (default `true`). |

### Return shape

```
✅ browser_command completed 3 step(s).

[1/3] goto
   ✅ Navigated to https://example.com/
   …

[2/3] title
   📄 Title: Example Domain
```

On failure it reports exactly which step broke, so the agent can correct course
without re-running the whole sequence:

```
⚠️  browser_command stopped at step 2 of 3.
```

If more than 25 steps are supplied, only the first 25 run and a note is appended.

---

## 3. Configuration

Configure interactively (recommended):

```bash
qtpi config
```

…or via env vars (env **always wins**, useful for CI / one-off runs):

```bash
QTPI_BROWSER_HEADLESS=false qtpi wakeup
```

### Browser keys

| Config key | Env var | Default | Notes |
|------------|---------|---------|-------|
| `browserHeadless` | `QTPI_BROWSER_HEADLESS` | `true` | Run Chromium headless. Set `false` to watch it work. |
| `browserTimeout` | `QTPI_BROWSER_TIMEOUT` | `30000` | ms per action / navigation. |
| `browserUserAgent` | `QTPI_BROWSER_USER_AGENT` | `QTPi/1.0 (+https://qtpi.dev)` | Sent by every page context. |
| `browserViewportWidth` | `QTPI_BROWSER_VIEWPORT_WIDTH` | `1280` | Viewport width. |
| `browserViewportHeight` | `QTPI_BROWSER_VIEWPORT_HEIGHT` | `800` | Viewport height. |
| `browserDownloadDir` | `QTPI_BROWSER_DOWNLOAD_DIR` | `''` → `<cwd>/.qtpi/downloads` | Screenshots + downloads. |
| `browserMaxPages` | `QTPI_BROWSER_MAX_PAGES` | `5` | Max concurrent named tabs. |
| `browserConfirmDestructive` | `QTPI_BROWSER_CONFIRM_DESTRUCTIVE` | `true` | Require `confirm: true` for `eval`. |
| `browserSsrfProtection` | `QTPI_BROWSER_SSRF_PROTECTION` | `true` | Block private / loopback / link-local targets. |
| `browserAllowPrivateHosts` | `QTPI_BROWSER_ALLOW_PRIVATE_HOSTS` | `false` | Escape hatch for local testing **only**. |
| `browserLogEnabled` | `QTPI_BROWSER_LOG_ENABLED` | `false` | Log every browser action. |
| `browserLogToFile` | `QTPI_BROWSER_LOG_TO_FILE` | `true` | Append JSONL to `browserLogFile`. |
| `browserLogToConsole` | `QTPI_BROWSER_LOG_TO_CONSOLE` | `false` | Echo one-line summaries to stderr. |
| `browserLogFile` | `QTPI_BROWSER_LOG_FILE` | `''` → `~/.qtpi/browser.log` | Log destination. |

> **Order of precedence:** env var → project config (`.qtpi/config.json`) → global config (`~/.qtpi/config.json`) → default.

---

## 4. Safety notes

- **SSRF guard runs first.** `goto` is checked against the shared SSRF policy *before*
  a page is created, so a blocked URL costs nothing. Private, loopback, link-local and
  reserved hostnames are rejected unless `browserAllowPrivateHosts` is `true`.
- **`eval` is gated.** Running arbitrary JavaScript in a page is the one genuinely
  dangerous action, so it requires `confirm: true` while `browserConfirmDestructive`
  is on (the default). Without it the tool returns an explanatory `⚠️` message and
  does **not** touch the page.
- **Tab ceiling.** `browserMaxPages` (default `5`) caps concurrent tabs; exceeding it
  returns a clear error telling the agent to `close` a page first.
- **Clean shutdown.** A process-exit / `SIGINT` / `SIGTERM` hook closes the browser so
  no orphaned Chromium processes are left behind.
- **Output is truncated.** `read`/`html` are capped by `maxChars` (default `8000`) and
  `links` by `limit` (default `50`) to protect the model's context window.

---

## 5. Cost & resource notes

- **No API cost.** Browser control is entirely local — no paid provider is involved.
- **It is heavy.** Chromium is a real process: expect a few hundred MB of RAM and a
  noticeable startup cost on the first action. That is why launch is lazy.
- **Token cost.** `read`/`html`/`links` output goes straight into the model's context.
  Prefer `read` with a small `maxChars` over `html` when you only need text, and use
  `links` with a low `limit` for navigation discovery.
- **Prefer `browser_command` for multi-step flows.** One call with 5 steps costs one
  round-trip instead of five.

---

## 6. Example: navigate, read, screenshot

See [`examples/browser-tools-example.mjs`](../examples/browser-tools-example.mjs).

Run it directly (launches a real Chromium):

```bash
node examples/browser-tools-example.mjs
node examples/browser-tools-example.mjs https://example.com
```

It registers both tools on a registry, navigates, reads the title and body text,
lists links, takes a screenshot, then exercises `browser_command` with a multi-step
sequence — exactly what the agent does.

### As an agent prompt

Once configured, just ask QTPi in **Agent** mode:

```
Open https://example.com, tell me the page title, and list the first five links.
```

QTPi will call `browser` with `action: "goto"`, then `title`, then `links`.

### Programmatic use (inside QTPi)

```js
import { createRegistry, executeTool } from './src/tools/ToolRegistry.js';
import { registerBrowserTools } from './src/tools/browserTool.js';
import { registerBrowserCommandTools } from './src/tools/browserCommandTool.js';
import { createBrowserRuntime } from './src/tools/browser/browserRuntime.js';
import { getConfig } from './src/config/configManager.js';

const config = { get: (key) => getConfig(key) };
const runtime = createBrowserRuntime(config);   // ONE shared runtime

const registry = createRegistry();
registerBrowserTools(registry, config, runtime);
registerBrowserCommandTools(registry, config, runtime);

console.log(await executeTool(registry, 'browser', {
  action: 'goto',
  url: 'https://example.com',
}));

console.log(await executeTool(registry, 'browser_command', {
  steps: [{ action: 'title' }, { action: 'links', limit: 5 }],
}));

await runtime.closeAll();
```

---

## 7. Testing

| Command | What it does |
|---------|--------------|
| `npm run test:browser` | Offline tests — **never** launches Chromium (stubbed runtime). |
| `npm run test:browser:live` | Live demo against a real browser (`examples/browser-tools-example.mjs`). |
| `node examples/browser-manual-test.mjs` | Minimal runtime smoke test (launch → goto → read). |

The offline suite (`test/browser-tools.test.js`) covers config mapping and defaults,
string-boolean coercion, the SSRF short-circuit, the `eval` confirmation gate, tab
management, step sequencing / `stopOnError` / the 25-step cap, and the "always returns
a string" contract.

### Missing browser binary?

If Playwright's Chromium is not installed:

```bash
npx playwright install chromium
```
