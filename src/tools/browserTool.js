// ================================================================
// FILE: src/tools/browserTool.js
// PURPOSE: Register the `browser` tool — a single browser action.
//
// The heavy lifting lives in src/tools/browser/browserActions.js so
// `browser` and `browser_command` share ONE implementation.
//
// The tool ALWAYS returns a string (never throws) so the agent loop
// keeps going and can react to failures.
// ================================================================

import { registerTool } from './ToolRegistry.js';
import { createBrowserActions } from './browser/browserActions.js';

const ACTIONS = [
  'goto', 'click', 'type', 'fill', 'press', 'select', 'hover', 'scroll',
  'read', 'text', 'html', 'content', 'title', 'url', 'links', 'screenshot',
  'eval', 'wait', 'back', 'forward', 'reload', 'newPage', 'close', 'pages', 'closeAll',
];


// ─────────────────────────────────────────────────────────────
// registerBrowserTools(registry, config, runtime)
// `runtime` : the object from createBrowserRuntime(). Required —
//             index.js creates ONE and shares it with
//             registerBrowserCommandTools so both tools drive the
//             same Chromium instance and page map.
// ─────────────────────────────────────────────────────────────
export function registerBrowserTools(registry, config, runtime) {
  if (!runtime) {
    throw new Error('registerBrowserTools requires a browser runtime (createBrowserRuntime)');
  }

  const actions = createBrowserActions(runtime, config);

  registerTool(registry, 'browser', {
    description:
      'Control a real Chromium browser. Runs ONE action per call: navigate to a URL, ' +
      'click/type/select elements, read page text or HTML, list links, take a screenshot, ' +
      'run JS, or manage tabs. Pages are named (default "main") so multi-step flows can ' +
      'keep operating on the same tab. Use browser_command to run several actions in one call.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'The action to perform.',
        },
        url: {
          type: 'string',
          description: 'Target URL for "goto" (must be http/https; SSRF-guarded).',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for click/type/fill/select/hover/scroll/read/wait.',
        },
        text: {
          type: 'string',
          description: 'Text to enter for "type"/"fill".',
        },
        value: {
          type: 'string',
          description: 'Option value for "select" (alias of text for fill).',
        },
        key: {
          type: 'string',
          description: 'Key to press for "press" (e.g. "Enter", "Tab", "Control+A").',
        },
        script: {
          type: 'string',
          description: 'JavaScript to evaluate in the page for "eval".',
        },
        confirm: {
          type: 'boolean',
          description: 'Required true to run "eval" when browserConfirmDestructive is on.',
        },
        page: {
          type: 'string',
          description: 'Named page/tab to act on (default "main").',
        },
        path: {
          type: 'string',
          description: 'Screenshot filename (relative to the download dir) for "screenshot".',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page for "screenshot".',
        },
        waitUntil: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
          description: 'Navigation wait condition for "goto" (default "domcontentloaded").',
        },
        maxChars: {
          type: 'number',
          description: 'Truncate read/html output to this many characters (default 8000).',
        },
        limit: {
          type: 'number',
          description: 'Max links to list for "links" (default 50).',
        },
        ms: {
          type: 'number',
          description: 'Milliseconds to wait for "wait" when no selector is given.',
        },
        x: { type: 'number', description: 'Horizontal scroll delta for "scroll".' },
        y: { type: 'number', description: 'Vertical scroll delta for "scroll".' },
      },
      required: ['action'],
    },
  }, async (args = {}) => actions.run(args));
}
