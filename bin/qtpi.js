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

import { createVectorStore } from '../src/rag/VectorStore.js';
import { indexRepository } from '../src/rag/Indexer.js';
import { createProvider } from '../src/providers/ProviderFactory.js';

import { spawn } from 'child_process';
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
      gw = createGateway({ workingDir: process.cwd(), configWrapper });
      await gw.start();
    } catch (error) {
      console.log(chalk.red(`  ❌ Gateway failed to start: ${error.message}\n`));
      process.exit(1);
    }

    writePidFile(pidFile, process.pid);
    const { channels, sessions } = gw.status();
    console.log(chalk.green(`  ✓ Gateway online (pid ${process.pid})`));
    console.log(chalk.gray(`  Channels: ${channels.join(', ')}`));
    console.log(chalk.gray(`  Pidfile:  ${pidFile}`));
    console.log(chalk.gray(`  Sessions: ${sessions.sessions} live\n`));
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


program.parse();
