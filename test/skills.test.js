// ================================================================
// FILE: test/skills.test.js
// PURPOSE: End-to-end tests for the skills system.
//
//   Step 1  fixture creation (good skill + broken skill)
//   Step 2  registry discovery / parsing
//   Step 3  progressive-disclosure formatters (L1/L2/L3)
//   Step 4  tool registration + execution (+ traversal guard)
//   Step 5  skillsAllowRun gate
//   Step 6  config + env overrides (child process)
//
// Run:  node --test test/skills.test.js
// ================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

import { createSkillRegistry } from '../src/skills/skillRegistry.js';
import {
  formatSkillCatalog,
  formatSkillBody,
  formatSkillResource,
} from '../src/skills/skillContext.js';
import { registerSkillTools } from '../src/tools/skillTool.js';
import { createRegistry, getToolDefinitions, executeTool } from '../src/tools/ToolRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── Step 1: fixtures ────────────────────────────────────────────
let tmpRoot;      // temp dir holding the skills root
let skillsRoot;   // the "project" skills root passed to the registry

function writeSkill(root, folder, frontmatter, body, extras = {}) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
  for (const [rel, content] of Object.entries(extras)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpi-skills-test-'));
  skillsRoot = path.join(tmpRoot, 'skills');
  fs.mkdirSync(skillsRoot, { recursive: true });

  // A valid skill with resources + a runnable script.
  writeSkill(
    skillsRoot,
    'demo-skill',
    [
      'name: demo-skill',
      'description: A demo skill for smoke testing.',
      'version: 1.2.3',
      'allowed-tools: [read_file, run_command]',
    ].join('\n'),
    '# Demo Skill\n\nFollow these steps carefully.',
    {
      'resources/checklist.md': '- item one\n- item two\n',
      'scripts/run.mjs': 'console.log("script ran", process.argv.slice(2).join(","));\n',
    },
  );

  // A deliberately broken skill (bad name → not kebab-case).
  writeSkill(
    skillsRoot,
    'broken-skill',
    ['name: Broken Skill', 'description: This name is invalid.'].join('\n'),
    '# Broken',
  );

  // A skill with NO frontmatter at all.
  const noFm = path.join(skillsRoot, 'no-frontmatter');
  fs.mkdirSync(noFm, { recursive: true });
  fs.writeFileSync(path.join(noFm, 'SKILL.md'), '# Just a body, no frontmatter\n');
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Config wrapper mirroring index.js: { get: (key) => value }
function makeConfig(overrides = {}) {
  const values = {
    skillsEnabled: true,
    skillsBuiltinDir: 'src/skills',
    skillsDirs: [skillsRoot],
    skillsMaxBodyBytes: 20000,
    skillsAllowRun: true,
    skillsRunTimeout: 30000,
    ...overrides,
  };
  return { get: (key) => values[key] };
}

// ── Step 2: registry discovery / parsing ────────────────────────
describe('Step 2: registry discovery & parsing', () => {
  test('enabled flag reflects config', () => {
    assert.equal(createSkillRegistry(makeConfig(), { workingDir: REPO_ROOT }).enabled, true);
    assert.equal(
      createSkillRegistry(makeConfig({ skillsEnabled: false }), { workingDir: REPO_ROOT }).enabled,
      false,
    );
  });

  test('list() returns the valid skill with the right source', () => {
    const reg = createSkillRegistry(makeConfig(), { workingDir: REPO_ROOT });
    const list = reg.list();
    const demo = list.find((s) => s.name === 'demo-skill');
    assert.ok(demo, 'demo-skill should be discovered');
    assert.equal(demo.source, 'project');
    assert.equal(demo.description, 'A demo skill for smoke testing.');
  });

  test('get() returns the parsed manifest (version + resources)', () => {
    const reg = createSkillRegistry(makeConfig(), { workingDir: REPO_ROOT });
    const m = reg.get('demo-skill');
    assert.ok(m);
    assert.equal(m.version, '1.2.3');
    assert.deepEqual(m.allowedTools, ['read_file', 'run_command']);
    const rels = m.resources.map((r) => r.relPath).sort();
    assert.deepEqual(rels, ['resources/checklist.md', 'scripts/run.mjs']);
  });

  test('malformed skills are recorded as warnings, not crashes', () => {
    const reg = createSkillRegistry(makeConfig(), { workingDir: REPO_ROOT });
    const warnings = reg.warnings();
    assert.ok(warnings.length >= 2, `expected >=2 warnings, got ${warnings.length}`);
    // The valid skill still loads despite the broken neighbours.
    assert.ok(reg.has('demo-skill'));
    assert.ok(!reg.has('Broken Skill'));
  });
});

// ── Step 3: progressive-disclosure formatters ───────────────────
describe('Step 3: progressive-disclosure formatters', () => {
  test('Level 1 catalog shows only name + description', () => {
    const reg = createSkillRegistry(makeConfig(), { workingDir: REPO_ROOT });
    const catalog = formatSkillCatalog(reg);
    assert.match(catalog, /## Available Skills/);
    assert.match(catalog, /- demo-skill: A demo skill for smoke testing\./);
    // Must NOT leak the body or resources at Level 1.
    assert.doesNotMatch(catalog, /Follow these steps/);
    assert.doesNotMatch(catalog, /checklist\.md/);
  });

  test('Level 2 body includes header, version and resource list', () => {
    const reg = createSkillRegistry(makeConfig(), { workingDir: REPO_ROOT });
    const body = formatSkillBody(reg.get('demo-skill'));
    assert.match(body, /# Skill: demo-skill/);
    assert.match(body, /_version 1\.2\.3_/);
    assert.match(body, /Follow these steps carefully\./);
    assert.match(body, /Allowed tools: read_file, run_command/);
    assert.match(body, /resources\/checklist\.md/);
  });

  test('Level 3 resource formatter returns file contents', () => {
    const reg = createSkillRegistry(makeConfig(), { workingDir: REPO_ROOT });
    const out = formatSkillResource(reg.get('demo-skill'), 'resources/checklist.md');
    assert.match(out, /📄 demo-skill\/resources\/checklist\.md:/);
    assert.match(out, /- item one/);
  });

  test('empty registry yields an empty catalog (nothing injected)', () => {
    const reg = createSkillRegistry(
      makeConfig({ skillsDirs: [path.join(tmpRoot, 'does-not-exist')] }),
      { workingDir: REPO_ROOT },
    );
    assert.equal(formatSkillCatalog(reg), '');
  });
});

// ── Step 4: tool registration + execution ───────────────────────
describe('Step 4: tool registration & execution', () => {
  let tools;
  let reg;

  before(() => {
    reg = createSkillRegistry(makeConfig(), { workingDir: REPO_ROOT });
    tools = createRegistry();
    registerSkillTools(tools, makeConfig(), reg);
  });

  test('skill_list / skill_read / skill_run are registered', () => {
    const names = getToolDefinitions(tools).map((d) => d.name);
    assert.ok(names.includes('skill_list'));
    assert.ok(names.includes('skill_read'));
    assert.ok(names.includes('skill_run'));
  });

  test('skill_list lists the skill', async () => {
    const out = await executeTool(tools, 'skill_list', {});
    assert.match(out, /🧩 Available skills/);
    assert.match(out, /demo-skill \[project\]/);
  });

  test('skill_read {name} returns the body', async () => {
    const out = await executeTool(tools, 'skill_read', { name: 'demo-skill' });
    assert.match(out, /# Skill: demo-skill/);
    assert.match(out, /Follow these steps carefully\./);
  });

  test('skill_read {name, resource} returns the resource file', async () => {
    const out = await executeTool(tools, 'skill_read', {
      name: 'demo-skill',
      resource: 'resources/checklist.md',
    });
    assert.match(out, /- item one/);
  });

  test('skill_read blocks path traversal', async () => {
    const out = await executeTool(tools, 'skill_read', {
      name: 'demo-skill',
      resource: '../../etc/passwd',
    });
    assert.match(out, /escapes the skill directory/);
  });

  test('skill_read rejects an unknown skill', async () => {
    const out = await executeTool(tools, 'skill_read', { name: 'nope' });
    assert.match(out, /Unknown skill "nope"/);
  });

  test('skill_run executes a bundled script and returns stdout', async () => {
    const out = await executeTool(tools, 'skill_run', {
      name: 'demo-skill',
      script: 'scripts/run.mjs',
      args: ['a', 'b'],
    });
    assert.match(out, /✅ skill_run demo-skill\/scripts\/run\.mjs succeeded/);
    assert.match(out, /script ran a,b/);
  });

  test('skill_run refuses a script outside scripts/', async () => {
    const out = await executeTool(tools, 'skill_run', {
      name: 'demo-skill',
      script: 'resources/checklist.md',
    });
    assert.match(out, /is not a runnable script/);
  });

  test('skill_run blocks path traversal', async () => {
    const out = await executeTool(tools, 'skill_run', {
      name: 'demo-skill',
      script: '../../evil.mjs',
    });
    assert.match(out, /escapes the skill directory/);
  });
});

// ── Step 5: skillsAllowRun gate ─────────────────────────────────
describe('Step 5: skillsAllowRun gate', () => {
  test('skill_run is absent when skillsAllowRun=false', () => {
    const reg = createSkillRegistry(makeConfig(), { workingDir: REPO_ROOT });
    const tools = createRegistry();
    registerSkillTools(tools, makeConfig({ skillsAllowRun: false }), reg);
    const names = getToolDefinitions(tools).map((d) => d.name);
    assert.ok(names.includes('skill_list'));
    assert.ok(names.includes('skill_read'));
    assert.ok(!names.includes('skill_run'), 'skill_run must NOT be registered');
  });

  test('skill_run is present when skillsAllowRun=true', () => {
    const reg = createSkillRegistry(makeConfig(), { workingDir: REPO_ROOT });
    const tools = createRegistry();
    registerSkillTools(tools, makeConfig({ skillsAllowRun: true }), reg);
    const names = getToolDefinitions(tools).map((d) => d.name);
    assert.ok(names.includes('skill_run'));
  });
});

// ── Step 6: config + env overrides ──────────────────────────────
describe('Step 6: config & env overrides', () => {
  test('env vars take precedence over config files (child process)', () => {
    // Run in a fresh process so configManager's one-time load sees our env.
    const configUrl = pathToFileURL(path.join(REPO_ROOT, 'src/config/configManager.js')).href;
    const script = `
      process.env.QTPI_SKILLS_ENABLED = 'false';
      process.env.QTPI_SKILLS_ALLOW_RUN = 'true';
      const { getConfig } = await import('${configUrl}');
      console.log(JSON.stringify({
        enabled: getConfig('skillsEnabled'),
        allowRun: getConfig('skillsAllowRun'),
      }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    });
    const parsed = JSON.parse(out.trim().split('\n').pop());
    assert.equal(parsed.enabled, 'false');
    assert.equal(parsed.allowRun, 'true');
  });

  test('defaults apply when nothing is configured', () => {
    const configUrl = pathToFileURL(path.join(REPO_ROOT, 'src/config/configManager.js')).href;
    const script = `
      delete process.env.QTPI_SKILLS_ENABLED;
      delete process.env.QTPI_SKILLS_ALLOW_RUN;
      const { getConfig } = await import('${configUrl}');
      console.log(JSON.stringify({
        enabled: getConfig('skillsEnabled'),
        allowRun: getConfig('skillsAllowRun'),
      }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    });
    const parsed = JSON.parse(out.trim().split('\n').pop());
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.allowRun, false);
  });
});
