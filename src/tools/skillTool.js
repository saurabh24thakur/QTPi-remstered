// ================================================================
// FILE: src/tools/skillTool.js
// PURPOSE: Expose the skills system to the model as normal QTPi tools.
//
//   skill_list  → Level-1 catalog (name + description + source)
//   skill_read  → Level-2 body, or a specific bundled resource (Level 3)
//   skill_run   → run a bundled script (only when skillsAllowRun is on)
//
// Every handler returns a STRING (executeTool coerces, but returning a
// string keeps the output stable and never throws into the agent loop).
// ================================================================

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { registerTool } from './ToolRegistry.js';
import { formatSkillBody, formatSkillResource } from '../skills/skillContext.js';

const DEFAULT_RUN_TIMEOUT = 30000;
const MAX_RESOURCE_LIST = 50;


// Read a value from either a config wrapper ({ get }) or a plain object.
function readConfig(config, key) {
  if (!config) return undefined;
  if (typeof config.get === 'function') return config.get(key);
  return config[key];
}

function readBool(config, key, fallback) {
  const value = readConfig(config, key);
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return Boolean(value);
}

function readNumber(config, key, fallback) {
  const value = Number(readConfig(config, key));
  return Number.isFinite(value) ? value : fallback;
}


// ─────────────────────────────────────────────────────────────
// registerSkillTools(registry, config, skillRegistry)
// `skillRegistry` : the object from createSkillRegistry(). Required.
// ─────────────────────────────────────────────────────────────
export function registerSkillTools(registry, config, skillRegistry) {
  if (!skillRegistry) {
    throw new Error('registerSkillTools requires a skill registry (createSkillRegistry)');
  }

  // ━━━━━━━━━━━━━━━━ TOOL: skill_list ━━━━━━━━━━━━━━━━
  registerTool(registry, 'skill_list', {
    description:
      'List the available skills (name + description). Skills are reusable, on-demand ' +
      'instruction sets. Use this to discover what skills exist; then call skill_read to ' +
      'load a skill\'s full instructions before following them.',
    parameters: {
      type: 'object',
      properties: {},
    },
  }, async () => {
    const skills = skillRegistry.list();

    if (!skills || skills.length === 0) {
      return '📭 No skills are installed. Add a skill folder containing a SKILL.md under ' +
        'src/skills/, ~/.qtpi/skills/, or ./.qtpi/skills/.';
    }

    const lines = skills.map((s) => `- ${s.name} [${s.source}]: ${s.description}`);

    const warnings = skillRegistry.warnings();
    const warnBlock = warnings.length
      ? `\n\n⚠️  ${warnings.length} skill(s) failed to load:\n` +
        warnings.map((w) => `  • ${w.path}: ${w.message}`).join('\n')
      : '';

    return `🧩 Available skills (${skills.length}):\n\n${lines.join('\n')}${warnBlock}`;
  });

  // ━━━━━━━━━━━━━━━━ TOOL: skill_read ━━━━━━━━━━━━━━━━
  registerTool(registry, 'skill_read', {
    description:
      'Load a skill\'s full instructions by name, or read one of its bundled resource files. ' +
      'Call this before following a skill found via skill_list. Pass "resource" to read a ' +
      'specific file (e.g. "resources/checklist.md") listed by the skill.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The skill name (kebab-case), e.g. "code-review".',
        },
        resource: {
          type: 'string',
          description: 'Optional bundled resource path to read instead of the body, e.g. "resources/checklist.md".',
        },
      },
      required: ['name'],
    },
  }, async ({ name, resource } = {}) => {
    if (!name || !String(name).trim()) {
      return '❌ skill_read requires a non-empty "name".';
    }

    const manifest = skillRegistry.get(String(name).trim());
    if (!manifest) {
      const available = skillRegistry.list().map((s) => s.name).join(', ') || '(none)';
      return `❌ Unknown skill "${name}". Available skills: ${available}`;
    }

    if (resource) {
      return formatSkillResource(manifest, String(resource).trim());
    }

    return formatSkillBody(manifest, {
      maxBodyBytes: readNumber(config, 'skillsMaxBodyBytes', 40000),
    });
  });

  // ━━━━━━━━━━━━━━━━ TOOL: skill_run (opt-in) ━━━━━━━━━━━━━━━━
  // Only registered when skillsAllowRun is true, so by default no skill
  // can execute anything.
  if (readBool(config, 'skillsAllowRun', false)) {
    registerTool(registry, 'skill_run', {
      description:
        'Run a bundled script that a skill ships under its "scripts/" folder. Only scripts ' +
        'listed by the skill are allowed. Runs with the skill folder as the working directory ' +
        'and a hard timeout, and returns the captured output.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The skill name, e.g. "commit-message".',
          },
          script: {
            type: 'string',
            description: 'Script path relative to the skill folder, e.g. "scripts/run.sh".',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional arguments passed to the script.',
          },
        },
        required: ['name', 'script'],
      },
    }, async ({ name, script, args } = {}) => {
      const manifest = skillRegistry.get(String(name || '').trim());
      if (!manifest) {
        return `❌ Unknown skill "${name}".`;
      }

      const skillDir = path.resolve(manifest.dir);
      const target = path.resolve(skillDir, String(script || ''));

      // Must stay inside the skill directory.
      const rel = path.relative(skillDir, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return `❌ Script path escapes the skill directory: ${script}`;
      }

      // Only scripts the skill advertises (under scripts/) are allowed.
      const allowed = (manifest.resources || []).some(
        (r) => r.relPath === String(script) && r.relPath.startsWith('scripts/'),
      );
      if (!allowed) {
        return `❌ "${script}" is not a runnable script for skill "${manifest.name}". ` +
          'Scripts must live under scripts/ and be listed by the skill.';
      }

      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        return `❌ Script not found: ${script}`;
      }

      const timeout = readNumber(config, 'skillsRunTimeout', DEFAULT_RUN_TIMEOUT);
      const scriptArgs = Array.isArray(args) ? args.map(String) : [];

      try {
        const output = execFileSync(process.execPath, [target, ...scriptArgs], {
          cwd: skillDir,
          timeout,
          maxBuffer: 1024 * 1024,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const trimmed = (output || '').trim();
        return `✅ skill_run ${manifest.name}/${script} succeeded:\n\n${trimmed || '(no output)'}`;
      } catch (error) {
        const stderr = error.stderr ? error.stderr.toString().trim() : '';
        const stdout = error.stdout ? error.stdout.toString().trim() : '';
        return (
          `❌ skill_run ${manifest.name}/${script} failed (exit code ${error.status ?? '?'}):\n\n` +
          `STDERR:\n${stderr || '(none)'}\n\nSTDOUT:\n${stdout || '(none)'}`
        );
      }
    });
  }
}


// Exposed for tests / future use.
export { MAX_RESOURCE_LIST };
