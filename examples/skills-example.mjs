// ================================================================
// FILE: examples/skills-example.mjs
// PURPOSE: End-to-end demo of the skills system that the QTPi agent
//          uses internally.
//
// Usage:
//   node examples/skills-example.mjs [skill-name]
//
// It builds a skill registry from the repo, prints the Level-1 catalog
// (skill_list), loads a skill's full body (skill_read), reads one of its
// bundled resources, and — when skillsAllowRun is enabled — runs a
// bundled script (skill_run).
// ================================================================

import { createRegistry, executeTool } from '../src/tools/ToolRegistry.js';
import { registerSkillTools } from '../src/tools/skillTool.js';
import { createSkillRegistry } from '../src/skills/skillRegistry.js';
import { getConfig } from '../src/config/configManager.js';

const requested = process.argv.slice(2).join(' ').trim();

// 1. One shared registry: discovery + parsing + warnings.
const config = { get: (key) => getConfig(key) };
const skills = createSkillRegistry(config, { workingDir: process.cwd() });

if (!skills.enabled) {
  console.log('\nSkills are disabled (skillsEnabled=false). Nothing to demo.\n');
  process.exit(0);
}

// 2. A tool registry with the skill tools registered.
const registry = createRegistry();
registerSkillTools(registry, config, skills);

// 3. Level 1 — the catalog (name + description only).
console.log('\n=== skill_list ===\n');
console.log(await executeTool(registry, 'skill_list', {}));

// 4. Pick a skill: the CLI arg, else the first discovered one.
const available = skills.list();
const target = requested || (available[0] && available[0].name);

if (!target) {
  console.log('\nNo skills installed — add a SKILL.md folder under ./.qtpi/skills/.\n');
  process.exit(0);
}

// 5. Level 2 — the full body.
console.log(`\n=== skill_read { name: "${target}" } ===\n`);
console.log(await executeTool(registry, 'skill_read', { name: target }));

// 6. Level 3 — read the first bundled resource, if any.
const manifest = skills.get(target);
const firstResource = manifest && manifest.resources && manifest.resources[0];
if (firstResource) {
  console.log(`\n=== skill_read { name: "${target}", resource: "${firstResource.relPath}" } ===\n`);
  console.log(await executeTool(registry, 'skill_read', {
    name: target,
    resource: firstResource.relPath,
  }));
}

// 7. skill_run — only present when skillsAllowRun is on.
const runnable = manifest && (manifest.resources || []).find(
  (r) => r.relPath.startsWith('scripts/'),
);

if (registry.has('skill_run') && runnable) {
  console.log(`\n=== skill_run { name: "${target}", script: "${runnable.relPath}" } ===\n`);
  console.log(await executeTool(registry, 'skill_run', {
    name: target,
    script: runnable.relPath,
  }));
} else if (!registry.has('skill_run')) {
  console.log('\n(skill_run is disabled — set skillsAllowRun=true or QTPI_SKILLS_ALLOW_RUN=true to enable it.)');
} else {
  console.log(`\n(skill "${target}" ships no scripts/ file to run.)`);
}

console.log('');
