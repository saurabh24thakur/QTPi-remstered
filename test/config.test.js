// ================================================================
// FILE: test/config.test.js
// PURPOSE: Offline, deterministic tests for the config layer,
//          focused on the qdrantCheckCompatibility key.
//
//   Step 1  default value (no env, no config files)
//   Step 2  env override (QTPI_QDRANT_CHECK_COMPATIBILITY)
//   Step 3  VectorStore boolean coercion (resolveCheckCompatibility)
//
// Run with:  npm test
//            node --test test/config.test.js
//
// These tests never touch the network or a real Qdrant instance.
// The config-layer tests run in a child process (like the skills
// suite) so configManager's one-time load sees a clean environment
// and an isolated HOME (no global/project config leaks in).
// ================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

import { resolveCheckCompatibility } from '../src/rag/VectorStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'src/config/configManager.js')).href;

// Run a snippet in a fresh process with an isolated HOME so the
// global (~/.qtpi/config.json) and project (./.qtpi/config.json)
// config files cannot influence the result. Returns parsed JSON.
function runInChild(script, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpi-config-test-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home, // Windows uses USERPROFILE for os.homedir()
    ...extraEnv,
  };
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
    env,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

// ── Step 1: default value ───────────────────────────────────────
describe('Step 1: qdrantCheckCompatibility default', () => {
  test('defaults to false when nothing is configured', () => {
    const script = `
      delete process.env.QTPI_QDRANT_CHECK_COMPATIBILITY;
      const { getConfig } = await import('${CONFIG_URL}');
      console.log(JSON.stringify({
        check: getConfig('qdrantCheckCompatibility'),
        url: getConfig('qdrantUrl'),
      }));
    `;
    const parsed = runInChild(script);
    assert.equal(parsed.check, false);
    assert.equal(parsed.url, 'http://localhost:6333');
  });
});

// ── Step 2: env override ────────────────────────────────────────
describe('Step 2: qdrantCheckCompatibility env override', () => {
  test('QTPI_QDRANT_CHECK_COMPATIBILITY=true wins over the default', () => {
    const script = `
      const { getConfig } = await import('${CONFIG_URL}');
      console.log(JSON.stringify({ check: getConfig('qdrantCheckCompatibility') }));
    `;
    const parsed = runInChild(script, { QTPI_QDRANT_CHECK_COMPATIBILITY: 'true' });
    // Env values arrive as strings; the coercion helper turns this into true.
    assert.equal(parsed.check, 'true');
    assert.equal(resolveCheckCompatibility(parsed.check), true);
  });
});

// ── Step 3: VectorStore coercion ────────────────────────────────
describe('Step 3: resolveCheckCompatibility coercion', () => {
  test('true (boolean) -> true', () => {
    assert.equal(resolveCheckCompatibility(true), true);
  });

  test('"true" (string) -> true', () => {
    assert.equal(resolveCheckCompatibility('true'), true);
  });

  test('false (boolean) -> false', () => {
    assert.equal(resolveCheckCompatibility(false), false);
  });

  test('"false" (string) -> false', () => {
    assert.equal(resolveCheckCompatibility('false'), false);
  });

  test('undefined -> false', () => {
    assert.equal(resolveCheckCompatibility(undefined), false);
  });

  test('other truthy values are not treated as true', () => {
    assert.equal(resolveCheckCompatibility(1), false);
    assert.equal(resolveCheckCompatibility('1'), false);
    assert.equal(resolveCheckCompatibility('TRUE'), false);
  });
});
