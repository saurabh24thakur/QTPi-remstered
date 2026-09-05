

import fs from 'fs';
import path from 'path';
import { diffLines } from 'diff';
import chalk from 'chalk';
import { registerTool } from './toolsRegistory.js';


export function registerFileTools(registry, workingDir) {


  // ━━━━━━━━━━━━━━━━ TOOL: read_file ━━━━━━━━━━━━━━━━
  registerTool(registry, 'read_file', {
    description: 'Read the contents of a file. Always read files before editing them to understand the current code. Supports reading specific line ranges for large files.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file relative to project root (e.g., "src/index.js")',
        },
        startLine: {
          type: 'number',
          description: 'Optional: start reading from this line number (1-based)',
        },
        endLine: {
          type: 'number',
          description: 'Optional: stop reading at this line number',
        },
      },
      required: ['filePath'],
    },
  }, async ({ filePath, startLine, endLine }) => {

    const fullPath = safeResolve(workingDir, filePath);

    if (!fs.existsSync(fullPath)) {
      return `❌ File not found: ${filePath}`;
    }

    let content = fs.readFileSync(fullPath, 'utf-8');

    // If specific line range requested, extract only those lines
    if (startLine || endLine) {
      const allLines = content.split('\n');
      const start = (startLine || 1) - 1; // Convert 1-based to 0-based index
      const end = endLine || allLines.length;
      const selectedLines = allLines.slice(start, end);

      // Add line numbers so the AI knows exactly where it is
      const numbered = selectedLines.map((line, i) =>
        `${String(start + i + 1).padStart(4)} │ ${line}`
      ).join('\n');

      return `📄 ${filePath} (lines ${start + 1}-${end}):\n\n${numbered}`;
    }

    // Full file with line numbers
    const lines = content.split('\n');
    const numbered = lines.map((line, i) =>
      `${String(i + 1).padStart(4)} │ ${line}`
    ).join('\n');

    return `📄 ${filePath} (${lines.length} lines):\n\n${numbered}`;
  });


  // ━━━━━━━━━━━━━━━━ TOOL: write_file ━━━━━━━━━━━━━━━━
  registerTool(registry, 'write_file', {
    description: 'Create a new file or completely overwrite an existing file. Use this for creating new files. For small changes to existing files, use edit_file instead.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file relative to project root',
        },
        content: {
          type: 'string',
          description: 'The complete content to write to the file',
        },
      },
      required: ['filePath', 'content'],
    },
  }, async ({ filePath, content }) => {

    const fullPath = safeResolve(workingDir, filePath);

    // Create parent directories if they don't exist
    // e.g., "src/components/Button.jsx" → make sure "src/components/" exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf-8');

    const lineCount = content.split('\n').length;
    return `✅ File written: ${filePath} (${lineCount} lines)`;
  });


  // ━━━━━━━━━━━━━━━━ TOOL: edit_file ━━━━━━━━━━━━━━━━
  registerTool(registry, 'edit_file', {
    description: 'Edit a file by finding and replacing specific text. Better than write_file for small changes because it preserves the rest of the file. The searchText must match EXACTLY including whitespace.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to edit',
        },
        searchText: {
          type: 'string',
          description: 'The exact text to find (must match exactly, including indentation and whitespace)',
        },
        replaceText: {
          type: 'string',
          description: 'The new text to replace it with',
        },
      },
      required: ['filePath', 'searchText', 'replaceText'],
    },
  }, async ({ filePath, searchText, replaceText }) => {

    const fullPath = safeResolve(workingDir, filePath);

    if (!fs.existsSync(fullPath)) {
      return `❌ File not found: ${filePath}`;
    }

    const original = fs.readFileSync(fullPath, 'utf-8');

    // Check if the search text actually exists in the file
    if (!original.includes(searchText)) {
      return (
        `❌ Could not find the exact text to replace in ${filePath}.\n\n` +
        `Searched for:\n"""\n${searchText}\n"""\n\n` +
        `Make sure it matches EXACTLY including indentation.\n` +
        `Tip: Use read_file first to see the exact current content.`
      );
    }

    // Do the replacement (only first occurrence)
    const updated = original.replace(searchText, replaceText);
    fs.writeFileSync(fullPath, updated, 'utf-8');

    // Generate a diff to show what changed
    const changes = diffLines(original, updated);
    let diffOutput = '';
    for (const change of changes) {
      if (change.added) {
        diffOutput += chalk.green(`+ ${change.value}`);
      } else if (change.removed) {
        diffOutput += chalk.red(`- ${change.value}`);
      }
    }

    return `✅ File edited: ${filePath}\n\nChanges:\n${diffOutput || '(no visible diff)'}`;
  });


  // ━━━━━━━━━━━━━━━━ TOOL: list_files ━━━━━━━━━━━━━━━━
  registerTool(registry, 'list_files', {
    description: 'List files and folders at a given path. Use to explore and understand the project structure.',
    parameters: {
      type: 'object',
      properties: {
        dirPath: {
          type: 'string',
          description: 'Directory path relative to project root. Use "." for root.',
        },
        recursive: {
          type: 'boolean',
          description: 'If true, list subdirectories too (default: false)',
        },
        maxDepth: {
          type: 'number',
          description: 'Max depth for recursive listing (default: 3)',
        },
      },
      required: ['dirPath'],
    },
  }, async ({ dirPath, recursive = false, maxDepth = 3 }) => {

    const fullPath = safeResolve(workingDir, dirPath || '.');
    const entries = buildFileTree(workingDir, fullPath, recursive, maxDepth, 0);

    return `📁 Contents of ${dirPath || '.'}:\n\n${entries.join('\n')}`;
  });


  // ━━━━━━━━━━━━━━━━ TOOL: delete_file ━━━━━━━━━━━━━━━━
  registerTool(registry, 'delete_file', {
    description: 'Delete a file from the project. Use with caution.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to delete',
        },
      },
      required: ['filePath'],
    },
  }, async ({ filePath }) => {

    const fullPath = safeResolve(workingDir, filePath);

    if (!fs.existsSync(fullPath)) {
      return `❌ File not found: ${filePath}`;
    }

    fs.unlinkSync(fullPath);
    return `🗑️ File deleted: ${filePath}`;
  });
}


// ─────────────────────────────────────────────────────────────
// safeResolve(workingDir, relativePath)
//
// Convert a relative path to absolute AND verify it stays
// inside the project directory.
//
// WHY: Without this, the AI could do:
//   read_file({ filePath: "../../../../etc/passwd" })
// and read sensitive system files.
//
// HOW: path.resolve() normalizes the path (resolves .. and .)
// Then we check the result starts with the working directory.
// ─────────────────────────────────────────────────────────────
function safeResolve(workingDir, relativePath) {
  const absolutePath = path.resolve(workingDir, relativePath);

  if (!absolutePath.startsWith(workingDir)) {
    throw new Error(
      `🛑 Security: Cannot access "${relativePath}" — ` +
      `it's outside the project directory`
    );
  }

  return absolutePath;
}



function buildFileTree(workingDir, dirPath, recursive, maxDepth, currentDepth) {
  const entries = [];

  // Directories to skip (they'd clutter output and are rarely useful)
  const SKIP = [
    'node_modules', '.git', '.qtpi', 'dist', 'build',
    '.next', '__pycache__', '.venv', 'venv', 'coverage',
  ];

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      if (SKIP.includes(item.name)) continue;

      const indent = '  '.repeat(currentDepth);

      if (item.isDirectory()) {
        entries.push(`${indent}📁 ${item.name}/`);

        if (recursive && currentDepth < maxDepth) {
          const subEntries = buildFileTree(
            workingDir,
            path.join(dirPath, item.name),
            recursive,
            maxDepth,
            currentDepth + 1
          );
          entries.push(...subEntries);
        }
      } else {
        const stats = fs.statSync(path.join(dirPath, item.name));
        const sizeStr = stats.size > 1024
          ? `${(stats.size / 1024).toFixed(1)}KB`
          : `${stats.size}B`;

        entries.push(`${indent}📄 ${item.name} (${sizeStr})`);
      }
    }
  } catch (error) {
    entries.push(`  ⚠ Error: ${error.message}`);
  }

  return entries;
}