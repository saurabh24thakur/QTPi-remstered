#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';

import { startTelegramBot } from '../src/channels/TelegramChannel.js';

import {
  setConfig,
  getConfig,
  isConfigured,
  showConfig,
  interactiveSetup,
  getAllConfig,
} from '../src/config/configManager.js';

import { startAgent } from '../src/index.js';

import { createRuntimeWithPlugins } from '../src/runtime/createRuntime.js';
import { createAutomation } from '../src/automation/createAutomation.js';
import { createCollectingRenderer } from '../src/automation/scheduler.js';
import { resolveJobs } from '../src/automation/jobStore.js';
import { createVectorStore } from '../src/rag/VectorStore.js';
import { indexRepository } from '../src/rag/Indexer.js';
import { createProvider } from '../src/providers/ProviderFactory.js';

import { spawn, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveEnabledChannels } from '../src/channels/registry.js';
import {
  createGateway,
  resolvePidFile,
  writePidFile,
  removePidFile,
  gatewayStatus,
} from '../src/gateway/server.js';

const program = new Command();

program
  .name('qtpi')
  .description(chalk.magenta('🧁 QTPI - Your AI coding agent in your terminal'))
  .version('1.0.0');



program
  .command('wakeup')
  .description('Wake up QTPI in your current workspace')
  .option('--no-memory', 'Start without loading long-term memory')
  .action(async (options) => {
    console.log(chalk.magenta('\n  🧁 QTPI is waking up...\n'));

    // Verify configuration
    if (!isConfigured()) {
      console.log(chalk.yellow('  ⚠ QTPI is not configured yet!'));
      console.log(chalk.gray('  Run: qtpi config\n'));
      process.exit(1);
    }

    // ── STEP 1: Choose Channel (CLI / Telegram / Exit) ──
    const { channel } = await inquirer.prompt([
      {
        type: 'list',
        name: 'channel',
        message: 'How do you want to use QTPI?',
        choices: [
          { name: '💻  CLI Mode (terminal chat)', value: 'cli' },
          { name: '📱  Telegram Mode (phone bot)', value: 'telegram' },
          { name: '❌  Exit', value: 'exit' },
        ],
      },
    ]);

    // Exit
    if (channel === 'exit') {
      console.log(chalk.magenta('\n  🧁 Bye!\n'));
      process.exit(0);
    }

    // ── Telegram Mode ──
    if (channel === 'telegram') {
      const token = getConfig('telegramToken');
      if (!token) {
        console.log(chalk.yellow('\n  ⚠ Telegram token not set!'));
        console.log(chalk.gray('  Run: qtpi telegram --token YOUR_BOT_TOKEN\n'));
        process.exit(1);
      }

      console.log(chalk.green('\n  🤖 Telegram mode is running...'));
      console.log(chalk.gray('  Open Telegram and message your bot. Press Ctrl+C to stop.\n'));

      const configData = getAllConfig();
      await startTelegramBot(token, configData);
      return;
    }

    const { mode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'mode',
        message: 'Select agent mode:',
        choices: [
          { name: '🤖  Agent Mode  — full access (read, write, run)', value: 'agent' },
          { name: '💬  Ask Mode    — read-only (no file changes)', value: 'ask' },
          { name: '📋  Plan Mode   — plan first, then execute', value: 'plan' },
          { name: '←   Back', value: 'back' },
        ],
      },
    ]);

    if (mode === 'back') {
      // Restart wakeup flow
      console.log('');
      // Re-run by calling the same logic — simplest: exit and tell user to run again
      // Or recursively re-invoke. For simplicity:
      console.log(chalk.gray('  Run qtpi wakeup again to go back.\n'));
      process.exit(0);
    }

    // Start interactive CLI agent
    await startAgent({
      mode: mode,
      memory: options.memory,
    });
  });



program
  .command('config')
  .description('Configure API keys, AI provider, and Qdrant settings')
  .option('-p, --provider <provider>', 'Provider: openai, openrouter, groq, anthropic, gemini, ollama')
  .option('-k, --key <key>', 'API key for your AI provider')
  .option('-m, --model <model>', 'Model to use (e.g. gpt-4o, claude-sonnet-4-20250514)')
  .option('--qdrant-url <url>', 'Qdrant URL (e.g. https://xyz.cloud.qdrant.io:6333)')
  .option('--qdrant-key <key>', 'Qdrant API key')
  .option('--show', 'Display current configuration')
  .action(async (options) => {

    if (options.show) {
      showConfig();
      return;
    }

    let updated = false;

    if (options.provider) {
      setConfig('provider', options.provider);
      console.log(chalk.green(`  ✓ Provider set to: ${options.provider}`));
      updated = true;
    }

    if (options.key) {
      setConfig('apiKey', options.key);
      console.log(chalk.green(`  ✓ API key saved`));
      updated = true;
    }

    if (options.model) {
      setConfig('model', options.model);
      console.log(chalk.green(`  ✓ Model set to: ${options.model}`));
      updated = true;
    }

    if (options.qdrantUrl) {
      setConfig('qdrantUrl', options.qdrantUrl);
      console.log(chalk.green(`  ✓ Qdrant URL set to: ${options.qdrantUrl}`));
      updated = true;
    }

    if (options.qdrantKey) {
      setConfig('qdrantKey', options.qdrantKey);
      console.log(chalk.green(`  ✓ Qdrant API key saved`));
      updated = true;
    }

    if (!updated) {
      await interactiveSetup();
    }
  });


program
  .command('ask <question...>')
  .description('Ask QTPI a quick single question about your code')
  .action(async (questionParts) => {
    const question = questionParts.join(' ');

    if (!isConfigured()) {
      console.log(chalk.yellow('  ⚠ QTPI is not configured yet. Run: qtpi config\n'));
      process.exit(1);
    }

    await startAgent({
      mode: 'ask',
      initialQuestion: question,
    });
  });



program
  .command('index')
  .description('Index repository into Qdrant for semantic search')
  .action(async () => {
    console.log(chalk.magenta('\n  🧁 QTPI is indexing your workspace...\n'));

    if (!isConfigured()) {
      console.log(chalk.yellow('  ⚠ QTPI is not configured yet. Run: qtpi config\n'));
      process.exit(1);
    }

    try {
      const workingDir = process.cwd();
      const configWrapper = { get: (key) => getConfig(key) };
      const configData = getAllConfig();
      
      const provider = createProvider(configData);
      const vectorStore = createVectorStore(configWrapper);

      await indexRepository(workingDir, vectorStore, provider);
      console.log(chalk.green('\n  ✓ Indexing complete! Semantic search enabled.\n'));
    } catch (error) {
      console.log(chalk.red(`\n  ❌ Indexing failed: ${error.message}\n`));
    }
  });



// ─────────────────────────────────────────────────────────────
// qtpi gateway start | status | stop
// A persistent process that serves every configured channel
// (config: channelsEnabled / QTPI_CHANNELS).
// ─────────────────────────────────────────────────────────────
const gateway = program
  .command('gateway')
  .description('Run QTPI as a persistent multi-channel gateway');

gateway
  .command('start')
  .description('Start the gateway (foreground by default)')
  .option('--foreground', 'Run in the current process (used internally)')
  .option('--detach', 'Spawn a detached background process')
  .action(async (options) => {
    const configWrapper = { get: (key) => getConfig(key) };
    const pidFile = resolvePidFile(configWrapper);

    const running = gatewayStatus(pidFile);
    if (running.running) {
      console.log(chalk.yellow(`  ⚠ Gateway already running (pid ${running.pid}).`));
      process.exit(1);
    }

    // Detach: re-launch ourselves with --foreground, then exit.
    if (options.detach && !options.foreground) {
      const binPath = fileURLToPath(import.meta.url);
      const child = spawn(process.execPath, [binPath, 'gateway', 'start', '--foreground'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      console.log(chalk.green(`  ✓ Gateway started in background (pid ${child.pid}).`));
      console.log(chalk.gray(`  Pidfile: ${pidFile}\n`));
      process.exit(0);
    }

    if (!isConfigured()) {
      console.log(chalk.yellow('  ⚠ QTPI is not configured yet. Run: qtpi config\n'));
      process.exit(1);
    }

    const channelNames = resolveEnabledChannels(configWrapper);
    if (channelNames.length === 0) {
      console.log(chalk.yellow('  ⚠ No channels enabled.'));
      console.log(chalk.gray('  Set channelsEnabled in config or QTPI_CHANNELS=webhook.\n'));
      process.exit(1);
    }

    console.log(chalk.magenta('\n  🧁 Starting QTPI gateway...\n'));

    let gw;
    try {
      gw = await createGateway({ workingDir: process.cwd(), configWrapper });
      await gw.start();
    } catch (error) {
      console.log(chalk.red(`  ❌ Gateway failed to start: ${error.message}\n`));
      process.exit(1);
    }

    writePidFile(pidFile, process.pid);
    const { channels, sessions, controlUi } = gw.status();
    console.log(chalk.green(`  ✓ Gateway online (pid ${process.pid})`));
    console.log(chalk.gray(`  Channels: ${channels.join(', ')}`));
    console.log(chalk.gray(`  Pidfile:  ${pidFile}`));
    console.log(chalk.gray(`  Sessions: ${sessions.sessions} live`));
    if (controlUi && controlUi.address) {
      const { address, port } = controlUi.address;
      console.log(chalk.gray(`  Control:  http://${address}:${port}`));
    }
    console.log('');
    console.log(chalk.gray('  Press Ctrl+C to stop.\n'));

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(chalk.magenta('\n  🧁 Gateway shutting down...\n'));
      await gw.stop();
      removePidFile(pidFile);
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

gateway
  .command('status')
  .description('Report whether the gateway is running')
  .action(() => {
    const configWrapper = { get: (key) => getConfig(key) };
    const status = gatewayStatus(resolvePidFile(configWrapper));
    if (status.running) {
      console.log(chalk.green(`  ✓ Gateway is running (pid ${status.pid}).`));
    } else {
      console.log(chalk.gray('  Gateway is not running.'));
    }
    console.log(chalk.gray(`  Pidfile: ${status.pidFile}\n`));
  });

gateway
  .command('stop')
  .description('Stop a running gateway')
  .action(() => {
    const configWrapper = { get: (key) => getConfig(key) };
    const pidFile = resolvePidFile(configWrapper);
    const status = gatewayStatus(pidFile);

    if (!status.running) {
      console.log(chalk.gray('  Gateway is not running.'));
      removePidFile(pidFile);
      return;
    }

    try {
      process.kill(status.pid, 'SIGTERM');
      removePidFile(pidFile);
      console.log(chalk.green(`  ✓ Sent stop signal to gateway (pid ${status.pid}).`));
    } catch (error) {
      console.log(chalk.red(`  ❌ Could not stop gateway: ${error.message}`));
    }
  });


// ─────────────────────────────────────────────────────────────
// qtpi dashboard
// Start the gateway with the local control UI enabled and open it
// in the default browser. The dashboard talks to the SAME runtime
// as every channel (see src/gateway/controlUi.js).
// ─────────────────────────────────────────────────────────────
program
  .command('dashboard')
  .description('Open the local QTPi control dashboard')
  .option('--port <port>', 'Dashboard port (default 8788)')
  .option('--host <host>', 'Bind host (default 127.0.0.1)')
  .option('--no-open', 'Do not open the browser automatically')
  .option('--auto-approve', 'Auto-approve sensitive tools from the dashboard')
  .action(async (options) => {
    if (!isConfigured()) {
      console.log(chalk.yellow('  ⚠ QTPI is not configured yet. Run: qtpi config\n'));
      process.exit(1);
    }

    const configWrapper = { get: (key) => getConfig(key) };
    const port = options.port ? Number(options.port) : getConfig('controlUiPort') || 8788;
    const host = options.host || getConfig('controlUiHost') || '127.0.0.1';

    console.log(chalk.magenta('\n  🧁 Starting QTPi control dashboard...\n'));

    let gw;
    try {
      gw = await createGateway({
        workingDir: process.cwd(),
        configWrapper,
        options: {
          controlUi: true,
          controlUiPort: port,
          controlUiHost: host,
          controlUiAutoApprove: options.autoApprove,
        },
      });
      await gw.start();
    } catch (error) {
      console.log(chalk.red(`  ❌ Dashboard failed to start: ${error.message}\n`));
      process.exit(1);
    }

    const ui = gw.controlUi;
    const addr = ui && ui.address();
    const url = `http://${host}:${addr ? addr.port : port}`;
    console.log(chalk.green(`  ✓ Dashboard online at ${url}`));
    console.log(chalk.gray('  Press Ctrl+C to stop.\n'));

    if (options.open !== false) {
      const opener = process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
      execFile(opener[0], opener[1], () => { /* best-effort */ });
    }

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(chalk.magenta('\n  🧁 Dashboard shutting down...\n'));
      await gw.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });



// ─────────────────────────────────────────────────────────────
// qtpi jobs list | validate | run <id>
// Phase 4 automation: cron-scheduled agent runs.
// The gateway runs the same scheduler in the background; these
// subcommands let you inspect and trigger jobs from a terminal.
// ─────────────────────────────────────────────────────────────
const jobsCmd = program
  .command('jobs')
  .description('List, validate and run scheduled automation jobs');

jobsCmd
  .command('list')
  .description('Show configured jobs')
  .option('--json', 'Emit JSON instead of a table')
  .action((options) => {
    const configWrapper = { get: (key) => getConfig(key) };
    const enabled = String(getConfig('automationEnabled')).toLowerCase() === 'true';
    const { jobs, warnings } = resolveJobs(configWrapper);

    if (options.json) {
      console.log(JSON.stringify({ enabled, jobs, warnings }, null, 2));
      return;
    }

    console.log(chalk.magenta(`\n  🧁 Automation: ${enabled ? chalk.green('enabled') : chalk.gray('disabled')}\n`));

    if (warnings.length) {
      for (const warning of warnings) console.log(chalk.yellow(`  ⚠ ${warning}`));
      console.log('');
    }

    if (jobs.length === 0) {
      console.log(chalk.gray('  No jobs configured.'));
      console.log(chalk.gray('  Add jobs to the automationJobs config key or a automationJobsFile JSON file.\n'));
      return;
    }

    const idWidth = Math.max(2, ...jobs.map((j) => j.id.length));
    console.log(chalk.gray(`  ${'ID'.padEnd(idWidth)}  ${'SCHEDULE'.padEnd(16)}  ${'STATE'.padEnd(8)}  NAME`));
    for (const job of jobs) {
      const state = job.enabled ? chalk.green('on') : chalk.gray('off');
      console.log(`  ${job.id.padEnd(idWidth)}  ${job.schedule.padEnd(16)}  ${state.padEnd(8)}  ${chalk.gray(job.name)}`);
    }
    console.log('');
  });

jobsCmd
  .command('validate')
  .description('Check job definitions without running them')
  .action(() => {
    const configWrapper = { get: (key) => getConfig(key) };
    const { jobs, warnings } = resolveJobs(configWrapper);

    console.log(chalk.magenta(`\n  🧁 Validating ${jobs.length} job(s)...\n`));
    for (const warning of warnings) console.log(chalk.red(`  ✗ ${warning}`));
    if (jobs.length === 0 && warnings.length === 0) {
      console.log(chalk.gray('  No jobs configured.\n'));
      return;
    }
    if (warnings.length === 0) {
      console.log(chalk.green(`  ✓ All ${jobs.length} job(s) are valid.\n`));
    } else {
      console.log(chalk.gray(`\n  ${jobs.length} valid, ${warnings.length} problem(s).\n`));
    }
  });

jobsCmd
  .command('run <id>')
  .description('Run a job immediately through a headless runtime')
  .option('--verbose', 'Print tool activity to stderr')
  .action(async (id, options) => {
    if (!isConfigured()) {
      console.log(chalk.yellow('  ⚠ QTPI is not configured yet. Run: qtpi config\n'));
      process.exit(1);
    }

    const configWrapper = { get: (key) => getConfig(key) };
    const { jobs } = resolveJobs(configWrapper);
    const job = jobs.find((entry) => entry.id === id);

    if (!job) {
      console.log(chalk.red(`  ❌ Unknown job "${id}".`));
      const known = jobs.map((entry) => entry.id).join(', ') || 'none';
      console.log(chalk.gray(`  Known jobs: ${known}\n`));
      process.exit(1);
    }

    const renderer = createCollectingRenderer();
    let runtime;
    try {
      runtime = await createRuntimeWithPlugins({
        workingDir: process.cwd(),
        configWrapper,
        renderer,
        options: { memory: false },
      });
    } catch (error) {
      console.log(chalk.red(`\n  ❌ Failed to initialize provider: ${error.message}\n`));
      process.exit(1);
    }

    // enabled: false — we drive runNow() directly, no cron tasks.
    const automation = createAutomation({
      runtime,
      config: configWrapper,
      options: { enabled: false, jobs, autoApprove: job.autoApprove === null ? undefined : job.autoApprove },
    });

    console.log(chalk.magenta(`\n  🧁 Running job "${job.id}" (${job.schedule})...\n`));

    const result = await automation.scheduler.runNow(job.id);

    const output = renderer.getOutput();
    if (output) console.log(output);

    if (result.ok) {
      console.log(chalk.green(`\n  ✓ Job "${job.id}" finished in ${result.durationMs}ms\n`));
    } else {
      console.log(chalk.red(`\n  ❌ Job "${job.id}" failed: ${result.error}\n`));
      process.exitCode = 1;
    }

    try { await runtime.agent.endSession(); } catch { /* best-effort */ }
  });

program.parse();
