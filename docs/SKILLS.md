# 🧩 Skills: `skill_list`, `skill_read` & `skill_run`

QTPi ships a **skills system**: reusable, on-demand instruction sets that the
agent loads only when they are relevant. A skill is just a folder containing a
`SKILL.md` file whose YAML frontmatter describes it and whose Markdown body
holds the instructions.

Three agent tools expose skills to the model:

| Tool | What it does | When the agent uses it |
|------|--------------|------------------------|
| `skill_list` | Returns the catalog of installed skills (name + description + source). | To discover what skills exist when the user's request might match one. |
| `skill_read` | Loads a skill's full Markdown body, **or** a specific bundled resource file. | Before following a skill it found via `skill_list`. |
| `skill_run` | Runs a bundled script that a skill ships under its `scripts/` folder. | Only when a skill explicitly says to run a script **and** `skillsAllowRun` is enabled. |

They are registered in `src/index.js` and share a single registry
(`createSkillRegistry`) so discovery, parsing and warnings are consistent
across all of them.

---

## 1. How skills work — progressive disclosure

Skills use **progressive disclosure** so the base system prompt stays small no
matter how many skills are installed:

| Level | Loaded when | What the model sees |
|:-----:|-------------|---------------------|
| **L1 — Catalog** | Always (injected into the system prompt) | `name` + `description` only. |
| **L2 — Body** | On demand, via `skill_read { name }` | The full Markdown body + a list of bundled resources. |
| **L3 — Resources** | On demand, via `skill_read { name, resource }` | The contents of a single bundled file (e.g. a checklist or template). |

The agent flow is therefore:

```
skill_list  →  skill_read { name }  →  (optionally) skill_read { name, resource }
             →  (optionally) skill_run { name, script }
```

---

## 2. Discovery roots & precedence

Skills are discovered by scanning a set of **roots** for immediate
subdirectories that contain a `SKILL.md`. When two skills share a name, the
**higher-precedence root wins** (lowest → highest):

| Order | Source tag | Directory | Purpose |
|:-----:|------------|-----------|---------|
| 1 | `builtin` | `src/skills/` | Skills that ship with QTPi. |
| 2 | `global` | `~/.qtpi/skills/` | Skills shared across all your projects. |
| 3 | `project` | `./.qtpi/skills/` | Skills specific to the current project. |

- `src/skills/` is where QTPi keeps its own code; if you drop a skill folder
  there it is tagged `builtin`.
- The **last configured directory is treated as the project root** and has the
  highest precedence, so a project can override a globally-installed skill of
  the same name.
- Override the roots entirely with the `skillsDirs` config key (an array, or a
  comma-separated string via `QTPI_SKILLS_DIR`).
- `~` is expanded to your home directory.
- A malformed skill is recorded as a **warning** and skipped — one broken skill
  never stops the others from loading. Warnings are surfaced by `skill_list`.

---

## 3. `SKILL.md` format

A `SKILL.md` has a small, well-defined YAML frontmatter block followed by a
Markdown body. QTPi parses a deliberate subset of YAML (flat key/value pairs,
inline arrays, block lists, quoted strings, booleans, numbers) — no YAML
dependency, and anything fancier is rejected with a clear error.

### Required fields

| Field | Type | Rules |
|-------|------|-------|
| `name` | string | **kebab-case** — lowercase words separated by single hyphens, e.g. `code-review`. Must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`. |
| `description` | string | One line explaining when to use the skill. This is the only thing shown in the L1 catalog, so make it count. |

### Optional fields

| Field | Type | Notes |
|-------|------|-------|
| `version` | string | Free-form (e.g. `1.0.0`). Shown in the L2 header. |
| `allowed-tools` | array | Names of tools the skill expects to use (advisory). Also accepts `allowedTools`. |
| `metadata` | map | Arbitrary key/value pairs, one level deep. |

### Minimal example

```markdown
---
name: commit-message
description: Write a clean, conventional commit message from a staged diff.
version: 1.0.0
allowed-tools: [run_command, read_file]
---

# Commit Message

Produce a Conventional Commits message for the currently staged changes.

## Steps
1. Run `git diff --staged` to see what changed.
2. Pick a type: `feat`, `fix`, `docs`, `refactor`, `test`, or `chore`.
3. Write a subject line in the imperative mood, max 72 characters.
4. Add a short body explaining the *why* when the change is non-trivial.

## Rules
- Never mention the AI or the tooling in the message.
- One logical change per commit.
```

One level of nested map is also supported, e.g.:

```markdown
---
name: code-review
description: Review a diff for bugs, style, and security issues.
metadata:
  category: quality
  author: platform-team
---
```

> **Frontmatter parsing:** the closing fence is a line that is exactly `---`.
> A file with an opening `---` but no closing `---` is rejected as an error
> (rather than silently mis-parsed). CRLF and LF files parse identically.

---

## 4. Bundled resources & scripts

Inside a skill folder, files under these subdirectories are exposed as
**resources** (L3) and are listed at the bottom of the L2 body:

| Directory | Typical contents |
|-----------|------------------|
| `resources/` | Reference docs, checklists, examples. |
| `references/` | Same as `resources/` — the convention used by Anthropic-style skills (e.g. `excalidraw-diagram`). |
| `templates/` | Files the skill can copy or fill in. |
| `scripts/` | Runnable scripts (see `skill_run`). |

Example layout:

```
.qtpi/skills/commit-message/
├── SKILL.md
├── resources/
│   └── example.md
└── scripts/
    └── run.mjs
```

Read any resource on demand:

```
skill_read { "name": "commit-message", "resource": "resources/example.md" }
```

### Path-traversal guard

Both `skill_read` (resources) and `skill_run` (scripts) **confine access to the
skill's own folder**. A path that escapes the directory (e.g.
`../../etc/passwd`) is rejected with an error and never read or executed.

---

## 5. Tool reference

### `skill_list`

List the installed skills.

| Name | Type | Required | Default | Description |
|------|------|:--------:|---------|-------------|
| — | — | — | — | Takes no parameters. |

Returns a **string** (never throws). Example:

```
🧩 Available skills (2):

- commit-message [project]: Write a clean, conventional commit message from a staged diff.
- code-review [global]: Review a diff for bugs, style, and security issues.

⚠️  1 skill(s) failed to load:
  • /path/to/SKILL.md: Missing required field "description" (…/SKILL.md)
```

If none are found:

```
📭 No skills are installed. Add a skill folder containing a SKILL.md under src/skills/, ~/.qtpi/skills/, or ./.qtpi/skills/.
```

---

### `skill_read`

Load a skill's full body, or one of its bundled resource files.

| Name | Type | Required | Default | Description |
|------|------|:--------:|---------|-------------|
| `name` | string | ✅ | — | The skill name (kebab-case), e.g. `code-review`. |
| `resource` | string | ❌ | — | A bundled resource path, e.g. `resources/checklist.md`. Omit to read the body. |

Returns a **string** (never throws).

Body (L2):

```
# Skill: commit-message
_version 1.0.0_
> Write a clean, conventional commit message from a staged diff.

# Commit Message
…instructions…

Allowed tools: run_command, read_file

Bundled resources (load with skill_read { name, resource }):
- resources/example.md
```

Resource (L3):

```
📄 commit-message/resources/example.md:

<file contents>
```

Error cases:

```
❌ skill_read requires a non-empty "name".
❌ Unknown skill "nope". Available skills: commit-message, code-review
❌ Resource path escapes the skill directory: ../../etc/passwd
❌ Resource not found: resources/missing.md
```

The body is truncated to `skillsMaxBodyBytes` (default `40000`) with a
`… (truncated)` marker if it is longer.

---

### `skill_run` *(opt-in)*

Run a bundled script that a skill ships under its `scripts/` folder. **This
tool is only registered when `skillsAllowRun` is `true`.**

| Name | Type | Required | Default | Description |
|------|------|:--------:|---------|-------------|
| `name` | string | ✅ | — | The skill name, e.g. `commit-message`. |
| `script` | string | ✅ | — | Script path relative to the skill folder, e.g. `scripts/run.mjs`. Must live under `scripts/` and be listed by the skill. |
| `args` | string[] | ❌ | `[]` | Arguments passed to the script. |

Returns a **string** (never throws). Success:

```
✅ skill_run commit-message/scripts/run.mjs succeeded:

<captured stdout>
```

Failure:

```
❌ skill_run commit-message/scripts/run.mjs failed (exit code 1):

STDERR:
<captured stderr>

STDOUT:
<captured stdout>
```

Refusals:

```
❌ Unknown skill "nope".
❌ Script path escapes the skill directory: ../../evil.sh
❌ "SKILL.md" is not a runnable script for skill "commit-message". Scripts must live under scripts/ and be listed by the skill.
❌ Script not found: scripts/run.mjs
```

---

## 6. Configuration

Configure interactively (recommended):

```bash
qtpi config
```

…or via env vars (env **always wins**, useful for CI / one-off runs):

```bash
QTPI_SKILLS_ALLOW_RUN=true qtpi wakeup
```

| Config key | Env var | Default | Notes |
|------------|---------|---------|-------|
| `skillsEnabled` | `QTPI_SKILLS_ENABLED` | `true` | Master switch. When `false`, no skill tools are registered and nothing is injected. |
| `skillsBuiltinDir` | `QTPI_SKILLS_BUILTIN_DIR` | `src/skills` | The built-in skills root. |
| `skillsDirs` | `QTPI_SKILLS_DIR` | `['~/.qtpi/skills', './.qtpi/skills']` | Global + project roots (array or comma-separated). The **last** entry is the highest-precedence project root. |
| `skillsMaxBodyBytes` | `QTPI_SKILLS_MAX_BODY` | `40000` | Truncate a skill body to this many UTF-8 bytes. |
| `skillsAutoActivate` | `QTPI_SKILLS_AUTO_ACTIVATE` | `false` | Reserved: auto-load a skill when its name is mentioned. |
| `skillsAllowRun` | `QTPI_SKILLS_ALLOW_RUN` | `false` | **Enables the `skill_run` tool** (executes bundled scripts). |
| `skillsRunTimeout` | `QTPI_SKILLS_RUN_TIMEOUT` | `30000` | ms timeout for a `skill_run` script. |

> **Order of precedence:** env var → project config (`.qtpi/config.json`) → global config (`~/.qtpi/config.json`) → default.

---

## 7. Safety notes

- **`skill_run` is off by default.** With the default config, no skill can
  execute anything. Turn it on deliberately with `skillsAllowRun` (or
  `QTPI_SKILLS_ALLOW_RUN=true`).
- **Scripts only.** `skill_run` runs **only** files that (a) live under the
  skill's `scripts/` folder and (b) are listed by the skill. Any other path —
  including the skill's own `SKILL.md` — is refused.
- **Confined to the skill folder.** Both `skill_read` (resources) and
  `skill_run` (scripts) reject any path that escapes the skill directory, so a
  malicious skill cannot reach the rest of your filesystem.
- **Bounded execution.** `skill_run` runs with the skill folder as its working
  directory, a hard timeout (`skillsRunTimeout`, default 30s) and a 1 MB output
  cap, and captures `stdout`/`stderr` instead of streaming them to your
  terminal.
- **Forgiving discovery.** A malformed `SKILL.md` produces a warning and is
  skipped; it never crashes the agent. Check `skill_list` output for warnings.

---

## 8. Example

See [`examples/skills-example.mjs`](../examples/skills-example.mjs).

Run it directly:

```bash
node examples/skills-example.mjs
```

It builds a skill registry from the repo, prints the L1 catalog, loads a skill
body with `skill_read`, reads a bundled resource, and (when `skillsAllowRun` is
on) runs a bundled script — mirroring what the agent does.

### As an agent prompt

Once a skill is installed, just ask QTPi in **Agent** or **Ask** mode:

```
Write a commit message for my staged changes.
```

QTPi will see the `commit-message` skill in the catalog, call
`skill_read { name: "commit-message" }`, and follow its instructions.

### Programmatic use (inside QTPi)

```js
import { createRegistry, executeTool } from './src/tools/ToolRegistry.js';
import { registerSkillTools } from './src/tools/skillTool.js';
import { createSkillRegistry } from './src/skills/skillRegistry.js';
import { getConfig } from './src/config/configManager.js';

const config = { get: (key) => getConfig(key) };
const skills = createSkillRegistry(config, { workingDir: process.cwd() });
const registry = createRegistry();

if (skills.enabled) {
  registerSkillTools(registry, config, skills);   // adds skill_list / skill_read (+ skill_run)
}

console.log(await executeTool(registry, 'skill_list', {}));
console.log(await executeTool(registry, 'skill_read', { name: 'commit-message' }));
```
