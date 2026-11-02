// ================================================================
// FILE: src/skills/skillContext.js
// PURPOSE: Turn the skill registry into prompt-ready text using
// progressive disclosure:
//
//   Level 1 (always loaded)  : name + description  → formatSkillCatalog
//   Level 2 (on activation)  : full Markdown body  → formatSkillBody
//   Level 3 (on demand)      : resource files      → formatSkillResource
//
// Keeping Level 1 tiny means the base system prompt stays small no
// matter how many skills are installed.
// ================================================================

import fs from 'fs';
import path from 'path';

const DEFAULT_MAX_BODY_BYTES = 20000;


// ─────────────────────────────────────────────────────────────
// formatSkillCatalog(registry)
// A compact Markdown block listing every available skill. Returns ''
// when there are no skills (so callers can skip injecting anything).
// ─────────────────────────────────────────────────────────────
export function formatSkillCatalog(registry) {
  if (!registry || typeof registry.list !== 'function') return '';

  const skills = registry.list();
  if (!skills || skills.length === 0) return '';

  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);

  return [
    '## Available Skills',
    'Skills are reusable, on-demand instruction sets. Only their name and',
    'description are loaded here — call skill_read to load a skill\'s full',
    'instructions before using it.',
    '',
    ...lines,
  ].join('\n');
}


// ─────────────────────────────────────────────────────────────
// formatSkillBody(manifest, options)
// Level-2 output: the skill's Markdown body with a small header and a
// list of any bundled resources the agent can request next.
// ─────────────────────────────────────────────────────────────
export function formatSkillBody(manifest, options = {}) {
  if (!manifest) return '';

  const maxBodyBytes = Number.isFinite(options.maxBodyBytes)
    ? options.maxBodyBytes
    : DEFAULT_MAX_BODY_BYTES;

  const header = [
    `# Skill: ${manifest.name}`,
    manifest.version ? `_version ${manifest.version}_` : '',
    manifest.description ? `> ${manifest.description}` : '',
  ].filter(Boolean).join('\n');

  let body = manifest.body || '';
  if (Buffer.byteLength(body, 'utf-8') > maxBodyBytes) {
    body = body.slice(0, maxBodyBytes) + '\n\n… (truncated)';
  }

  const parts = [header, '', body];

  if (manifest.allowedTools && manifest.allowedTools.length > 0) {
    parts.push('', `Allowed tools: ${manifest.allowedTools.join(', ')}`);
  }

  if (manifest.resources && manifest.resources.length > 0) {
    const list = manifest.resources.map((r) => `- ${r.relPath}`).join('\n');
    parts.push('', 'Bundled resources (load with skill_read { name, resource }):', list);
  }

  return parts.join('\n');
}


// ─────────────────────────────────────────────────────────────
// formatSkillResource(manifest, relPath)
// Level-3 output: the contents of a single bundled resource file.
// Guards against path traversal so a skill can only read files inside
// its own folder. Returns a string (never throws).
// ─────────────────────────────────────────────────────────────
export function formatSkillResource(manifest, relPath) {
  if (!manifest) return '❌ Unknown skill.';
  if (!relPath) return '❌ No resource path provided.';

  const skillDir = path.resolve(manifest.dir);
  const target = path.resolve(skillDir, relPath);

  // Must stay inside the skill directory.
  const rel = path.relative(skillDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return `❌ Resource path escapes the skill directory: ${relPath}`;
  }

  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return `❌ Resource not found: ${relPath}`;
  }

  try {
    const content = fs.readFileSync(target, 'utf-8');
    return `📄 ${manifest.name}/${relPath}:\n\n${content}`;
  } catch (error) {
    return `❌ Could not read resource ${relPath}: ${error.message}`;
  }
}
