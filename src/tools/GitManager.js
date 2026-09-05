
import { execSync } from 'child_process';
import { registerTool } from './toolsRegistory.js';

export function registerGitTools(registry, workingDir) {

 
  function runGit(command) {
    try {
      const output = execSync(command, {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 15000,
      });
      return output.trim() || '(no output)';
    } catch (error) {
      return `Git error: ${error.stderr || error.message}`;
    }
  }


  // ━━━━━━━━━━━━━━━━ TOOL: git_status ━━━━━━━━━━━━━━━━
  registerTool(registry, 'git_status', {
    description: 'Show which files are modified, added, or deleted in git.',
    parameters: { type: 'object', properties: {} },
  }, async () => {
    return runGit('git status --short');
  });


  // ━━━━━━━━━━━━━━━━ TOOL: git_diff ━━━━━━━━━━━━━━━━
  registerTool(registry, 'git_diff', {
    description: 'Show the actual code changes (diff) in modified files.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Optional: diff only this specific file',
        },
        staged: {
          type: 'boolean',
          description: 'If true, show staged changes (default: false)',
        },
      },
    },
  }, async ({ filePath = '', staged = false }) => {
    const stagedFlag = staged ? '--staged' : '';
    return runGit(`git diff ${stagedFlag} ${filePath}`.trim());
  });


  // ━━━━━━━━━━━━━━━━ TOOL: git_log ━━━━━━━━━━━━━━━━
  registerTool(registry, 'git_log', {
    description: 'Show recent git commit history.',
    parameters: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of commits to show (default: 10)',
        },
      },
    },
  }, async ({ count = 10 }) => {
    return runGit(`git log --oneline -${count}`);
  });


  // ━━━━━━━━━━━━━━━━ TOOL: git_commit ━━━━━━━━━━━━━━━━
  registerTool(registry, 'git_commit', {
    description: 'Stage all changes and create a git commit with a message.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The commit message',
        },
      },
      required: ['message'],
    },
  }, async ({ message }) => {
    runGit('git add -A');
    const safeMessage = message.replace(/"/g, '\\"');
    return runGit(`git commit -m "${safeMessage}"`);
  });
}