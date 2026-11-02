// ================================================================
// FILE: examples/browser-manual-test.mjs
// PURPOSE: Manual smoke test for the browser runtime, runnable TODAY
//          even though the agent-facing `browser` tool is not yet
//          registered. Drives createBrowserRuntime directly:
//            launch -> newPage("main") -> goto -> read title/h1
//
// Usage:
//   node examples/browser-manual-test.mjs
//   node examples/browser-manual-test.mjs https://example.com
//
// NOTE: example.com currently has NO <h1> (only a paragraph), so the
// default below is a page that has both a stable title AND heading.
// ================================================================

import { createBrowserRuntime } from '../src/tools/browser/browserRuntime.js';

const url = process.argv[2] || 'https://www.iana.org/help/example-domains';

// A plain config object (no keys set) -> runtime uses safe defaults.
const runtime = createBrowserRuntime({ get: () => undefined });

console.log(`\n=== browser manual test: ${url} ===\n`);

try {
  const page = await runtime.getPage('main');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Read title + first heading via evaluate (robust; no locator waits).
  const info = await page.evaluate(() => ({
    title: document.title,
    h1: document.querySelector('h1')?.innerText?.trim() || '(no <h1>)',
    url: location.href,
  }));

  console.log('TITLE:', info.title);
  console.log('H1   :', info.h1);
  console.log('URL  :', info.url);
  console.log('\n✅ Runtime works — browser control is functional at the runtime layer.');
} catch (error) {
  console.error('❌ Runtime test failed:', error.message);
  process.exitCode = 1;
} finally {
  await runtime.closeAll();
}
