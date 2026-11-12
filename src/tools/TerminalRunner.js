
import { execFileSync, execSync } from 'child_process';
import chalk from 'chalk';
import { registerTool } from './ToolRegistry.js';


// Commands that could destroy a system — never allow these
const DANGEROUS_PATTERNS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /*',
  'mkfs.',
  'dd if=',
  ':(){:|:&};:',     
  'chmod -R 777 /',
  'shutdown',
  'reboot',
  'format c:',
  '> /dev/sda',
];



export function registerTerminalTools(registry, workingDir, config) {

  registerTool(registry, 'run_command', {
    description: 'Run a shell command in the project directory. Use for: installing packages (npm install), running tests (npm test), building (npm run build), checking versions, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to run (e.g., "npm install express")',
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait (default: 30)',
        },
      },
      required: ['command'],
    },
  }, async ({ command, timeout = 30 }) => {

    // ── Safety check ──
    if (isDangerous(command)) {
      return '⛔ BLOCKED: This command is potentially dangerous and was NOT executed.';
    }

    console.log(chalk.gray(`\n  $ ${command}\n`));

    try {
      const timeoutMs = timeout * 1000;
      const output = sandboxEnabled(config)
        ? runSandboxed(command, workingDir, timeoutMs)
        : execSync(command, {
        cwd: workingDir,
        timeout: timeout * 1000,      // Convert seconds → milliseconds
        maxBuffer: 1024 * 1024,       // Max 1MB output
        encoding: 'utf-8',            // Return string, not Buffer
        stdio: ['pipe', 'pipe', 'pipe'], // Capture all output
      });

      const trimmed = output.trim();

      // Truncate very long outputs to save AI context window space
      if (trimmed.length > 5000) {
        return (
          `✅ Command succeeded. Output (truncated):\n\n` +
          `${trimmed.slice(0, 5000)}\n\n` +
          `... (${trimmed.length - 5000} more characters)`
        );
      }

      return `✅ Command succeeded:\n\n${trimmed || '(no output)'}`;

    } catch (error) {
      const stderr = error.stderr ? error.stderr.toString().trim() : '';
      const stdout = error.stdout ? error.stdout.toString().trim() : '';

      return (
        `❌ Command failed (exit code ${error.status}):\n\n` +
        `STDERR:\n${stderr || '(none)'}\n\n` +
        `STDOUT:\n${stdout || '(none)'}`
      );
    }
  });
}

function sandboxEnabled(config) {
  const value = config && typeof config.get === 'function' ? config.get('sandboxEnabled') : config?.sandboxEnabled;
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true');
}

export function buildSandboxArgs(workingDir, command) {
  return [
    '--die-with-parent', '--unshare-all',
    '--ro-bind', '/', '/',
    '--bind', workingDir, workingDir,
    '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev',
    '--chdir', workingDir, '--clearenv',
    '--setenv', 'PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--setenv', 'HOME', '/tmp',
    '/bin/sh', '-lc', command,
  ];
}

function runSandboxed(command, workingDir, timeout) {
  if (process.platform !== 'linux') {
    throw new Error('QTPI_SANDBOX_ENABLED requires Linux with bubblewrap (bwrap); command was not run.');
  }
  return execFileSync('bwrap', buildSandboxArgs(workingDir, command), {
    cwd: workingDir,
    timeout,
    maxBuffer: 1024 * 1024,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}


// Check if the command is dangerous
function isDangerous(command) {
  const lower = command.toLowerCase().trim();
  return DANGEROUS_PATTERNS.some(pattern => lower.includes(pattern.toLowerCase()));
}
