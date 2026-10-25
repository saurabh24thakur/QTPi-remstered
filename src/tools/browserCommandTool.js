// ================================================================
// FILE: src/tools/browserCommandTool.js
// PURPOSE: Register the `browser_command` tool — run a SEQUENCE of
// browser actions in one call (e.g. goto → type → click → read).
//
// Shares the exact same action implementation as `browser`
// (src/tools/browser/browserActions.js) and the same runtime, so
// steps operate on the same Chromium instance and page map.
//
// Execution stops at the first failing step and reports which step
// failed, so the agent can correct course without re-running the
// whole sequence.
// ================================================================

import { registerTool } from './ToolRegistry.js';
import { createBrowserActions } from './browser/browserActions.js';

const MAX_STEPS = 25;


// ─────────────────────────────────────────────────────────────
// registerBrowserCommandTools(registry, config, runtime)
// ─────────────────────────────────────────────────────────────
export function registerBrowserCommandTools(registry, config, runtime) {
  if (!runtime) {
    throw new Error('registerBrowserCommandTools requires a browser runtime (createBrowserRuntime)');
  }

  const actions = createBrowserActions(runtime, config);

  registerTool(registry, 'browser_command', {
    description:
      'Run a SEQUENCE of browser actions in one call (e.g. goto → type → click → read). ' +
      'Each step is an object with an "action" plus its arguments (same actions as the ' +
      '"browser" tool). Steps share one page (default "main"). Execution stops at the first ' +
      'failing step and reports which one failed. Use this to script multi-step flows ' +
      'without a round-trip per action.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: `Ordered list of actions to run (max ${MAX_STEPS}). Each item: { action, ...args }.`,
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'The action to perform.' },
              url: { type: 'string', description: 'Target URL for "goto".' },
              selector: { type: 'string', description: 'CSS selector for interaction/read actions.' },
              text: { type: 'string', description: 'Text for "type"/"fill".' },
              value: { type: 'string', description: 'Option value for "select".' },
              key: { type: 'string', description: 'Key for "press".' },
              script: { type: 'string', description: 'JS for "eval".' },
              confirm: { type: 'boolean', description: 'Required true to run "eval".' },
              page: { type: 'string', description: 'Named page/tab (default "main").' },
              path: { type: 'string', description: 'Screenshot filename.' },
              fullPage: { type: 'boolean', description: 'Full-page screenshot.' },
              waitUntil: { type: 'string', description: 'Navigation wait condition.' },
              maxChars: { type: 'number', description: 'Truncate read/html output.' },
              limit: { type: 'number', description: 'Max links to list.' },
              ms: { type: 'number', description: 'Wait duration in ms.' },
              x: { type: 'number', description: 'Horizontal scroll delta.' },
              y: { type: 'number', description: 'Vertical scroll delta.' },
            },
            required: ['action'],
          },
        },
        stopOnError: {
          type: 'boolean',
          description: 'Stop at the first failing step (default true).',
        },
      },
      required: ['steps'],
    },
  }, async ({ steps, stopOnError = true } = {}) => {
    if (!Array.isArray(steps) || steps.length === 0) {
      return '❌ browser_command requires a non-empty "steps" array.';
    }

    const list = steps.slice(0, MAX_STEPS);
    const results = [];
    let failedAt = -1;

    for (let i = 0; i < list.length; i++) {
      const step = list[i] || {};
      const label = `[${i + 1}/${list.length}] ${step.action || '(no action)'}`;
      const output = await actions.run(step);
      const ok = !output.startsWith('❌');

      results.push(`${label}\n${indent(output, '   ')}`);

      if (!ok) {
        failedAt = i;
        if (stopOnError) break;
      }
    }

    const header = failedAt === -1
      ? `✅ browser_command completed ${list.length} step(s).`
      : `⚠️  browser_command stopped at step ${failedAt + 1} of ${list.length}.`;

    const note = list.length < steps.length
      ? `\nℹ️  Only the first ${MAX_STEPS} of ${steps.length} steps were run.`
      : '';

    return `${header}\n\n${results.join('\n\n')}${note}`;
  });
}


function indent(text, prefix) {
  return String(text).split('\n').map((line) => prefix + line).join('\n');
}
