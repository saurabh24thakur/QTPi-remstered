// ================================================================
// FILE: src/skills/skillRegistry.js
// PURPOSE: Discover every skill across the configured roots, parse
// each one, dedupe by name (higher precedence wins) and expose a tiny
// read API. Mirrors the factory style of webRuntime.js /
// browserRuntime.js so index.js can build one and share it.
//
// Discovery roots (lowest → highest precedence):
//   1. built-in   : <workingDir>/src/skills        (ships with QTPi)
//   2. global user: ~/.qtpi/skills
//   3. project    : <workingDir>/.qtpi/skills
//
// A skill is any immediate subdirectory of a root that contains a
// `SKILL.md`. A malformed skill is recorded as a warning and skipped —
// one bad skill never breaks the rest.
//
// Config keys (all optional, safe defaults):
//   skillsEnabled      bool    default true
//   skillsBuiltinDir   string  default 'src/skills'
//   skillsDirs         array   default ['~/.qtpi/skills', './.qtpi/skills']
//   skillsMaxBodyBytes number  default 40000
// ================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseSkillManifest, SkillManifestError } from './skillManifest.js';

const DEFAULT_MAX_BODY_BYTES = 40000;


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

// Accept an array or a comma-separated string.
function readList(config, key, fallback) {
  const value = readConfig(config, key);
  if (value == null || value === '') return fallback;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value).split(',').map((v) => v.trim()).filter(Boolean);
}


// ─────────────────────────────────────────────────────────────
// expandHome(p)
// Expands a leading `~` to the user's home directory.
// ─────────────────────────────────────────────────────────────
export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}


// ─────────────────────────────────────────────────────────────
// createSkillRegistry(config, options)
// `config`  : config wrapper ({ get }) or plain object.
// `options` : { workingDir } — defaults to process.cwd().
//
// Returns:
//   list()      -> [{ name, description, source, dir }]  (Level 1)
//   get(name)   -> full manifest object or undefined
//   reload()    -> re-scan the roots
//   warnings()  -> [{ path, message }]
//   roots()     -> resolved root descriptors
//   enabled     -> boolean
// ─────────────────────────────────────────────────────────────
export function createSkillRegistry(config, options = {}) {
  const workingDir = options.workingDir || process.cwd();
  const enabled = readBool(config, 'skillsEnabled', true);
  const maxBodyBytes = readNumber(config, 'skillsMaxBodyBytes', DEFAULT_MAX_BODY_BYTES);

  // Build the ordered root list (lowest precedence first).
  const builtinDir = readConfig(config, 'skillsBuiltinDir') || 'src/skills';
  const userDirs = readList(config, 'skillsDirs', ['~/.qtpi/skills', './.qtpi/skills']);

  const roots = [
    { source: 'builtin', dir: path.resolve(workingDir, expandHome(builtinDir)) },
    ...userDirs.map((d, idx) => ({
      // The last configured dir is the project root (highest precedence).
      source: idx === userDirs.length - 1 ? 'project' : 'global',
      dir: path.resolve(workingDir, expandHome(d)),
    })),
  ];

  // name -> manifest (last write wins → higher precedence overrides).
  let skills = new Map();
  let warnings = [];

  function scan() {
    skills = new Map();
    warnings = [];

    for (const root of roots) {
      if (!fs.existsSync(root.dir) || !fs.statSync(root.dir).isDirectory()) continue;

      let entries;
      try {
        entries = fs.readdirSync(root.dir, { withFileTypes: true });
      } catch (error) {
        warnings.push({ path: root.dir, message: `Could not read skills root: ${error.message}` });
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(root.dir, entry.name);
        const manifestPath = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(manifestPath)) continue;

        try {
          const manifest = parseSkillManifest(manifestPath, { maxBodyBytes });
          manifest.source = root.source;
          // Later roots override earlier ones by name.
          skills.set(manifest.name, manifest);
        } catch (error) {
          const message = error instanceof SkillManifestError
            ? error.message
            : `Unexpected error: ${error.message}`;
          warnings.push({ path: manifestPath, message });
        }
      }
    }
  }

  scan();

  return {
    enabled,

    // Level-1 metadata only — cheap to inject into the system prompt.
    list() {
      return Array.from(skills.values()).map((m) => ({
        name: m.name,
        description: m.description,
        source: m.source,
        dir: m.dir,
      }));
    },

    // Full manifest (body + resources) for a single skill.
    get(name) {
      return skills.get(name);
    },

    has(name) {
      return skills.has(name);
    },

    reload() {
      scan();
      return this.list();
    },

    warnings() {
      return warnings.slice();
    },

    roots() {
      return roots.slice();
    },
  };
}
