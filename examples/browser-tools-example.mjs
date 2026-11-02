// ================================================================
// FILE: examples/browser-tools-example.mjs
// PURPOSE: End-to-end demo of the browser / browser_command tools
//          that the QTPi agent drives. Launches a REAL Chromium.
//
// Usage:
//   node examples/browser-tools-example.mjs
//   node examples/browser-tools-example.mjs https://example.com
//
// It registers both tools on a registry (sharing one browser
// runtime), then:
//   1. navigates to the target URL,
//   2. reads the page title + body text,
//   3. lists links,
//   4. takes a screenshot,
//   5. exercises browser_command with a multi-step sequence.
//
// Requires Playwright's Chromium (already a dependency). If the
// browser binary is missing run:  npx playwright install chromium
// ================================================================

import { createRegistry, executeTool } from '../src/tools/ToolRegistry.js';
import { registerBrowserTools } from '../src/tools/browserTool.js';
import { registerBrowserCommandTools } from '../src/tools/browserCommandTool.js';
import { createBrowserRuntime } from '../src/tools/browser/browserRuntime.js';
import { getConfig } from '../src/config/configManager.js';

const url = process.argv[2] || 'https://example.com';

// 1. One shared runtime: one Chromium instance, one page map, one logger.
const config = { get: (key) => getConfig(key) };
const runtime = createBrowserRuntime(config);

// 2. A registry with both tools registered.
const registry = createRegistry();
registerBrowserTools(registry, config, runtime);
registerBrowserCommandTools(registry, config, runtime);

console.log(`\n=== browser-tools demo against ${url} ===\n`);

try {
  // 3. Navigate (single action).
  console.log('--- browser { action: "goto" } ---');
  console.log(await executeTool(registry, 'browser', { action: 'goto', url }));

  // 4. Read the title and the first 400 chars of body text.
  console.log('\n--- browser { action: "title" } ---');
  console.log(await executeTool(registry, 'browser', { action: 'title' }));

  console.log('\n--- browser { action: "read", maxChars: 400 } ---');
  console.log(await executeTool(registry, 'browser', { action: 'read', maxChars: 400 }));

  // 5. List links (capped).
  console.log('\n--- browser { action: "links", limit: 5 } ---');
  console.log(await executeTool(registry, 'browser', { action: 'links', limit: 5 }));

  // 6. Screenshot (written under browserDownloadDir).
  console.log('\n--- browser { action: "screenshot" } ---');
  console.log(await executeTool(registry, 'browser', { action: 'screenshot' }));

  // 7. Multi-step flow in ONE call.
  console.log('\n--- browser_command { steps: [...] } ---');
  console.log(
    await executeTool(registry, 'browser_command', {
      steps: [
        { action: 'goto', url },
        { action: 'title' },
        { action: 'url' },
      ],
    })
  );

  console.log('\n✅ Browser tools are functional end-to-end.\n');
} catch (error) {
  console.error('❌ Browser demo failed:', error.message);
  process.exitCode = 1;
} finally {
  await runtime.closeAll();
}
