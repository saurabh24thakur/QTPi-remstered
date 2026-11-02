// ================================================================
// FILE: src/skills/skillManifest.js
// PURPOSE: Parse a single `SKILL.md` file into a normalized manifest
// object. A skill is a folder containing a `SKILL.md` whose YAML
// frontmatter describes the skill and whose Markdown body holds the
// instructions the agent loads on activation.
//
// Format:
//   ---
//   name: code-review
//   description: Review a diff for bugs, style, and security issues.
//   version: 1.0.0
//   allowed-tools: [read_file, search_code, run_command]
//   ---
//
//   # Code Review
//   ...instructions...
//
// We deliberately avoid a YAML dependency: the frontmatter we accept is
// a small, well-defined subset (flat key/value pairs, inline arrays,
// block lists, quoted strings, booleans, numbers). Anything fancier is
// rejected with a clear error rather than silently mis-parsed.
// ================================================================

import fs from 'fs';
import path from 'path';

// Directories inside a skill folder whose files are exposed as
// "resources" (Level 3 — loaded on demand). `references` is included
// because it is the convention used by Anthropic-style skills (e.g. the
// published excalidraw-diagram skill ships its docs under references/).
export const RESOURCE_DIRS = ['resources', 'references', 'templates', 'scripts'];

// A skill name must be kebab-case: lowercase words separated by single
// hyphens (e.g. "code-review", "commit-message").
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DEFAULT_MAX_BODY_BYTES = 40000;


// ─────────────────────────────────────────────────────────────
// SkillManifestError
// Thrown for any malformed skill so callers can catch it and record a
// warning instead of crashing the whole registry.
// ─────────────────────────────────────────────────────────────
export class SkillManifestError extends Error {
  constructor(message, filePath) {
    super(filePath ? `${message} (${filePath})` : message);
    this.name = 'SkillManifestError';
    this.filePath = filePath;
  }
}


// ─────────────────────────────────────────────────────────────
// parseSkillManifest(filePath, options)
// Reads a SKILL.md and returns a normalized manifest:
//   {
//     name, description, version, allowedTools, metadata,
//     dir, manifestPath, body, resources: [ { path, relPath, bytes } ]
//   }
// `options.maxBodyBytes` truncates the body (default 20000).
// Throws SkillManifestError on any problem.
// ─────────────────────────────────────────────────────────────
export function parseSkillManifest(filePath, options = {}) {
  const maxBodyBytes = Number.isFinite(options.maxBodyBytes)
    ? options.maxBodyBytes
    : DEFAULT_MAX_BODY_BYTES;

  if (!fs.existsSync(filePath)) {
    throw new SkillManifestError('SKILL.md not found', filePath);
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new SkillManifestError(`Could not read SKILL.md: ${error.message}`, filePath);
  }

  const { frontmatter, body } = splitFrontmatter(raw, filePath);
  const data = parseFrontmatter(frontmatter, filePath);

  // ── Validate required fields ──
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) {
    throw new SkillManifestError('Missing required field "name"', filePath);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new SkillManifestError(
      `Invalid skill name "${name}" — use kebab-case (e.g. "code-review")`,
      filePath,
    );
  }

  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!description) {
    throw new SkillManifestError('Missing required field "description"', filePath);
  }

  const dir = path.dirname(path.resolve(filePath));

  // ── Normalize optional fields ──
  const version = data.version != null ? String(data.version) : '';
  const allowedTools = normalizeStringArray(data['allowed-tools'] ?? data.allowedTools);
  const metadata = (data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata))
    ? data.metadata
    : {};

  // ── Truncate the body to the configured byte budget ──
  const trimmedBody = body.trim();
  const { text: finalBody, truncated } = truncateBytes(trimmedBody, maxBodyBytes);

  return {
    name,
    description,
    version,
    allowedTools,
    metadata,
    dir,
    manifestPath: path.resolve(filePath),
    body: finalBody,
    bodyTruncated: truncated,
    resources: listResources(dir),
  };
}


// ─────────────────────────────────────────────────────────────
// splitFrontmatter(raw, filePath)
// Splits a `---`-delimited YAML frontmatter block from the Markdown
// body. Returns { frontmatter, body }. Throws if the opening fence is
// present but never closed.
// ─────────────────────────────────────────────────────────────
export function splitFrontmatter(raw, filePath = '') {
  // Normalize line endings so CRLF files parse identically to LF files.
  const text = raw.replace(/\r\n/g, '\n');

  if (!text.startsWith('---')) {
    // No frontmatter at all — the whole file is body. Validation will
    // then fail on the missing "name"/"description" fields.
    return { frontmatter: '', body: text };
  }

  const lines = text.split('\n');
  // lines[0] === '---'; find the next line that is exactly '---'
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }

  if (end === -1) {
    throw new SkillManifestError('Unterminated frontmatter (missing closing "---")', filePath);
  }

  const frontmatter = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  return { frontmatter, body };
}


// ─────────────────────────────────────────────────────────────
// parseFrontmatter(text, filePath)
// Minimal YAML subset parser. Supports:
//   key: value
//   key: "quoted value"
//   key: [a, b, c]            (inline array)
//   key:                      (block list follows)
//     - a
//     - b
//   key:                      (nested map follows, one level)
//     sub: value
// Booleans (true/false), numbers and null are coerced.
// ─────────────────────────────────────────────────────────────
export function parseFrontmatter(text, filePath = '') {
  const result = {};
  if (!text || !text.trim()) return result;

  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines and comments.
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    // Top-level keys must not be indented.
    if (/^\s/.test(line)) {
      throw new SkillManifestError(`Unexpected indentation in frontmatter: "${line.trim()}"`, filePath);
    }

    const colon = line.indexOf(':');
    if (colon === -1) {
      throw new SkillManifestError(`Invalid frontmatter line (expected "key: value"): "${line.trim()}"`, filePath);
    }

    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();

    if (!key) {
      throw new SkillManifestError(`Invalid frontmatter line (empty key): "${line.trim()}"`, filePath);
    }
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new SkillManifestError(`Duplicate frontmatter key "${key}"`, filePath);
    }

    if (rest !== '') {
      // Inline value (scalar or inline array).
      result[key] = parseScalar(rest);
      i++;
      continue;
    }

    // Empty value → look ahead for a block list or nested map.
    const block = [];
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) {
      block.push(lines[j]);
      j++;
    }

    if (block.length === 0) {
      result[key] = '';
      i++;
      continue;
    }

    const first = block[0].trim();
    if (first.startsWith('- ')) {
      // Block list.
      result[key] = block.map((b) => parseScalar(b.trim().slice(2).trim()));
    } else {
      // Nested map (one level).
      const map = {};
      for (const entry of block) {
        const c = entry.indexOf(':');
        if (c === -1) {
          throw new SkillManifestError(`Invalid nested frontmatter line: "${entry.trim()}"`, filePath);
        }
        const subKey = entry.slice(0, c).trim();
        const subVal = entry.slice(c + 1).trim();
        map[subKey] = parseScalar(subVal);
      }
      result[key] = map;
    }

    i = j;
  }

  return result;
}


// ─────────────────────────────────────────────────────────────
// parseScalar(value)
// Coerces a raw YAML scalar string into a JS value.
// ─────────────────────────────────────────────────────────────
function parseScalar(value) {
  const v = String(value).trim();

  // Inline array: [a, b, c]
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((part) => parseScalar(part.trim()));
  }

  // Quoted string.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }

  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;

  // Number (only if it round-trips cleanly).
  if (/^-?\d+(?:\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }

  return v;
}


// ─────────────────────────────────────────────────────────────
// normalizeStringArray(value)
// Accepts an array or a comma-separated string and returns a clean
// array of non-empty strings.
// ─────────────────────────────────────────────────────────────
function normalizeStringArray(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : String(value).split(',');
  return arr
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
}


// ─────────────────────────────────────────────────────────────
// listResources(dir)
// Walks the known resource subfolders and returns a flat list of
// files (relative paths) so the agent can discover Level-3 assets.
// ─────────────────────────────────────────────────────────────
export function listResources(dir) {
  const out = [];

  for (const sub of RESOURCE_DIRS) {
    const root = path.join(dir, sub);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    walk(root, sub, out);
  }

  return out;
}

function walk(absDir, relDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(abs, rel, out);
    } else if (entry.isFile()) {
      let bytes = 0;
      try { bytes = fs.statSync(abs).size; } catch { /* ignore */ }
      out.push({ path: abs, relPath: rel, bytes });
    }
  }
}


// ─────────────────────────────────────────────────────────────
// truncateBytes(text, maxBytes)
// Truncates a string to at most `maxBytes` UTF-8 bytes without
// splitting a multi-byte character. Returns { text, truncated }.
// ─────────────────────────────────────────────────────────────
export function truncateBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return { text, truncated: false };

  // Slice then trim any partial trailing character.
  let sliced = buf.slice(0, maxBytes).toString('utf-8');
  // A replacement char at the end means we cut a multi-byte sequence.
  if (sliced.endsWith('\uFFFD')) sliced = sliced.slice(0, -1);

  return { text: sliced + '\n\n… (truncated)', truncated: true };
}
