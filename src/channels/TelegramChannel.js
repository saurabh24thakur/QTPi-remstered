import { Telegraf } from 'telegraf';
import chalk from 'chalk';
import { createRuntimeWithPlugins } from '../runtime/createRuntime.js';
import { getConfig } from '../config/configManager.js';
import { askTelegramApproval, resetTelegramApproval } from './TelegramApproval.js';
import { assertChannel, createChannelRenderer, bindChannelToRuntime } from './Channel.js';

// Telegram rejects messages longer than 4096 chars — chunk at 4000.
const TELEGRAM_MAX_LEN = 4000;


async function sendChunked(ctx, text) {
  const str = String(text ?? '');
  if (str.length <= TELEGRAM_MAX_LEN) {
    await ctx.reply(str);
    return;
  }
  for (let i = 0; i < str.length; i += TELEGRAM_MAX_LEN) {
    await ctx.reply(str.slice(i, i + TELEGRAM_MAX_LEN));
  }
}


// ─────────────────────────────────────────────────────────────
// createTelegramChannel({ token })
// Returns a Channel (see Channel.js) backed by Telegraf.
//
// The channel owns the transport only — the runtime is built by the
// caller and bound in with bindChannelToRuntime(), so the same runtime
// can serve several channels (Phase 2 gateway).
// ─────────────────────────────────────────────────────────────
export function createTelegramChannel({ token } = {}) {
  if (!token) throw new Error('createTelegramChannel requires a bot token');

  const bot = new Telegraf(token);

  let messageHandler = null;
  let currentCtx = null;

  // Inline-button callbacks (approve / approve_all / reject).
  bot.action(['approve', 'approve_all', 'reject'], async (ctx) => {
    await ctx.answerCbQuery();
    const choice = ctx.match[0];
    await ctx.editMessageText(`Action decision: *${choice.toUpperCase()}*`, { parse_mode: 'Markdown' });

    if (currentCtx && currentCtx.telegramApprovalResolver) {
      currentCtx.telegramApprovalResolver(choice);
    }
  });

  // Inbound text → the registered handler.
  bot.on('text', async (ctx) => {
    currentCtx = ctx;
    if (!messageHandler) return;

    const senderId = String(ctx.chat?.id ?? ctx.from?.id ?? 'unknown');
    await messageHandler({
      senderId,
      text: ctx.message.text,
      reply: (text) => sendChunked(ctx, text),
      sendTyping: () => ctx.sendChatAction('typing').catch(() => {}),
    });
  });

  const channel = {
    name: 'telegram',

    async start() {
      await bot.launch();
      console.log(chalk.green('  ✓ Telegram Bot is running!'));
      console.log(chalk.gray('  Open Telegram on your phone and message your bot.\n'));
    },

    async stop() {
      bot.stop();
    },

    async send(target, text) {
      await bot.telegram.sendMessage(target, String(text));
    },

    onMessage(handler) {
      messageHandler = handler;
    },

    async requestApproval(toolName, args) {
      if (!currentCtx) return 'rejected';
      return askTelegramApproval(currentCtx, toolName, args);
    },

    resetApproval() {
      resetTelegramApproval();
    },
  };

  return assertChannel(channel);
}


// ─────────────────────────────────────────────────────────────
// startTelegramBot(botToken, configData)
// Backward-compatible entry point used by bin/qtpi.js. Builds the
// shared runtime, binds the Telegram channel to it, and launches.
// ──────���──────────────────────────────────────────────────────
export async function startTelegramBot(botToken, configData) {
  const workingDir = process.cwd();
  console.log(chalk.magenta('\n  🤖 Initializing QTPI Telegram Bot...\n'));

  // Use getConfig (env → project → global → default) rather than the raw
  // configData object, which omits env vars and built-in defaults.
  const configWrapper = { get: (key) => getConfig(key) };

  const renderer = createChannelRenderer();
  const channel = createTelegramChannel({ token: botToken });

  // Build the SAME runtime the CLI uses (provider + all tools + memory +
  // skills + agent). This is what fixes the old drift where Telegram was
  // missing the web, browser and skill tools.
  const runtime = await createRuntimeWithPlugins({
    workingDir,
    configWrapper,
    renderer,
    options: {
      approvalHandler: (toolName, args) => channel.requestApproval(toolName, args),
    },
  });

  bindChannelToRuntime(channel, runtime, renderer);

  await channel.start();

  // Enable graceful stop.
  process.once('SIGINT', () => channel.stop());
  process.once('SIGTERM', () => channel.stop());
}
