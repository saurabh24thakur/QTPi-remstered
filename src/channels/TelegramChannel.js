import { Telegraf, Markup } from 'telegraf';
import chalk from 'chalk';
import { createAgent } from '../core/Agent.js';
import { createProvider } from '../providers/ProviderFactory.js';
import { createRegistry } from '../tools/ToolRegistry.js';
import { registerFileTools } from '../tools/fileManager.js';
import { registerTerminalTools } from '../tools/TerminalRunner.js';
import { registerGitTools } from '../tools/GitManager.js';
import { registerSearchTools } from '../tools/SearchTool.js';
import { registerRepoSearchTool } from '../rag/RepoSearch.js';
import { createLongTermMemory } from '../memory/LongTermMemory.js';
import { askTelegramApproval, resetTelegramApproval } from './TelegramApproval.js';

export async function startTelegramBot(botToken, configData) {
  const bot = new Telegraf(botToken);
  const workingDir = process.cwd();

  console.log(chalk.magenta('\n  🤖 Initializing QTPI Telegram Bot...\n'));

  // 1. Provider
  const provider = createProvider(configData);

  // 2. Tools
  const tools = createRegistry();
  registerFileTools(tools, workingDir);
  registerTerminalTools(tools, workingDir);
  registerGitTools(tools, workingDir);
  registerSearchTools(tools, workingDir);
  registerRepoSearchTool(tools, { get: (k) => configData[k] }, provider);

  // 3. Memory
  const memory = createLongTermMemory(workingDir);

  // 4. Custom Renderer for Telegram (sends text messages to chat)
  let currentCtx = null;

  const telegramRenderer = {
    startThinking: () => {
      if (currentCtx) currentCtx.sendChatAction('typing');
    },
    stopThinking: () => {},
    streamToken: () => {}, // Telegram doesn't support per-token streaming easily
    renderAssistant: async (text) => {
      if (currentCtx) {
        // Chunk long text if > 4000 chars
        if (text.length > 4000) {
          for (let i = 0; i < text.length; i += 4000) {
            await currentCtx.reply(text.slice(i, i + 4000));
          }
        } else {
          await currentCtx.reply(text);
        }
      }
    },
    renderToolCall: (name) => {
      if (currentCtx) currentCtx.reply(`🔧 Tool Call: ${name}`);
    },
    renderToolResult: () => {},
    renderWarning: (msg) => {
      if (currentCtx) currentCtx.reply(`⚠️ ${msg}`);
    },
    renderError: (msg) => {
      if (currentCtx) currentCtx.reply(`❌ Error: ${msg}`);
    },
    renderWelcome: () => {},
  };

  // 5. Create Agent
  const agent = createAgent({
    provider,
    tools,
    memory,
    renderer: telegramRenderer,
    config: { get: (k) => configData[k] },
    workingDir,
  });

  // Handle Telegram Inline Button Callbacks
  bot.action(['approve', 'approve_all', 'reject'], async (ctx) => {
    await ctx.answerCbQuery();
    const choice = ctx.match[0];
    await ctx.editMessageText(`Action decision: *${choice.toUpperCase()}*`, { parse_mode: 'Markdown' });

    if (currentCtx && currentCtx.telegramApprovalResolver) {
      currentCtx.telegramApprovalResolver(choice);
    }
  });

  // Listen for text messages
  bot.on('text', async (ctx) => {
    currentCtx = ctx;
    const userMsg = ctx.message.text;

    if (userMsg === '/start') {
      resetTelegramApproval();
      await ctx.reply('🧁 QTPI Telegram Bot is online! Send me any task or question for your codebase.');
      return;
    }

    if (userMsg === '/reset') {
      resetTelegramApproval();
      agent.conversation.clear();
      await ctx.reply('✓ Session and approval settings reset.');
      return;
    }

    try {
      await agent.run(userMsg);
    } catch (err) {
      await ctx.reply(`❌ Execution Error: ${err.message}`);
    }
  });

  // Launch Bot
  await bot.launch();
  console.log(chalk.green('  ✓ Telegram Bot is running!'));
  console.log(chalk.gray('  Open Telegram on your phone and message your bot.\n'));

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}