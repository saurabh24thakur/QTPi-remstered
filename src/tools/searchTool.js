
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { registerTool } from './toolsRegistory.js';


export function registerSearchTools(registry, workingDir) {


  // ━━━━━━━━━━━━━━━━ TOOL: search_code ━━━━━━━━━━━━━━━━
  registerTool(registry, 'search_code', {
    description: 'Search for a text pattern across all code files in the project. Like grep. Use to find where something is defined or used.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or regex pattern to search for (e.g., "useState", "function login")',
        },
        filePattern: {
          type: 'string',
          description: 'Glob pattern to limit search (e.g., "**/*.js"). Default: all files.',
        },
      },
      required: ['pattern'],
    },
  }, async ({ pattern, filePattern = '**/*' }) => {

    // Find all files to search
    const files = await glob(filePattern, {
      cwd: workingDir,
      ignore: ['node_modules/**', '.git/**', '.qtpi/**', 'dist/**', '*.lock'],
      nodir: true,
    });

    const results = [];

    // Build regex from the pattern
    let regex;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch {
      // If pattern isn't valid regex, escape it and search literally
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, 'gi');
    }

    // Search through each file (limit to 200 files for speed)
    for (const file of files.slice(0, 200)) {
      try {
        const fullPath = path.join(workingDir, file);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push({
              file: file,
              line: i + 1,
              text: lines[i].trim().slice(0, 120), // Truncate long lines
            });
          }
          regex.lastIndex = 0; // Reset regex state for next test
        }
      } catch {
        // Skip binary files or files we can't read
      }
    }

    if (results.length === 0) {
      return `🔍 No matches found for "${pattern}" in ${files.length} files.`;
    }

    // Show max 50 results
    const display = results.slice(0, 50);
    const lines = display.map(r =>
      `  ${r.file}:${r.line}  │  ${r.text}`
    );

    let output = `🔍 Found ${results.length} matches for "${pattern}":\n\n${lines.join('\n')}`;

    if (results.length > 50) {
      output += `\n\n  ... and ${results.length - 50} more matches`;
    }

    return output;
  });


  // ━━━━━━━━━━━━━━━━ TOOL: find_files ━━━━━━━━━━━━━━━━
  registerTool(registry, 'find_files', {
    description: 'Find files by name or pattern. Useful to locate specific files.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g., "**/*.test.js", "**/config*", "**/*auth*")',
        },
      },
      required: ['pattern'],
    },
  }, async ({ pattern }) => {

    const matchingFiles = await glob(pattern, {
      cwd: workingDir,
      ignore: ['node_modules/**', '.git/**'],
      nodir: true,
    });

    if (matchingFiles.length === 0) {
      return `🔍 No files found matching "${pattern}"`;
    }

    const fileList = matchingFiles.map(f => `  📄 ${f}`).join('\n');
    return `🔍 Files matching "${pattern}" (${matchingFiles.length} found):\n\n${fileList}`;
  });
}