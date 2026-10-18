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
} from '../src/config/ConfigManager.js';

import { startAgent } from '../src/index.js';

import { createVectorStore } from '../src/rag/VectorStore.js';
import { indexRepository } from '../src/rag/Indexer.js';
import { createProvider } from '../src/providers/ProviderFactory.js';

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
      oneShot: true,
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



program.parse();