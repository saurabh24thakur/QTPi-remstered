import { Markup } from 'telegraf';

let telegramApproveAll = false;

export function resetTelegramApproval() {
  telegramApproveAll = false;
}

export async function askTelegramApproval(ctx, toolName, args) {
  if (telegramApproveAll) {
    return 'approved';
  }

  // Build preview message
  let preview = `⚠️ *QTPI wants to execute a sensitive action:*\n\n`;
  preview += `*Action:* \`${toolName}\`\n`;

  if (args.filePath) preview += `*File:* \`${args.filePath}\`\n`;
  if (args.command) preview += `*Command:* \`$ ${args.command}\`\n`;
  if (args.message) preview += `*Commit:* \`${args.message}\`\n`;

  // Inline action buttons
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Approve', 'approve'),
      Markup.button.callback('✅✅ Approve All', 'approve_all'),
    ],
    [
      Markup.button.callback('❌ Reject', 'reject'),
    ]
  ]);

  const sentMessage = await ctx.replyWithMarkdownV2(
    escapeMarkdown(preview),
    keyboard
  );

  // Return a promise that resolves when the user taps a button
  return new Promise((resolve) => {
    // Save resolver on context for callback query handler
    ctx.telegramApprovalResolver = (choice) => {
      if (choice === 'approve_all') {
        telegramApproveAll = true;
        resolve('approved');
      } else if (choice === 'approve') {
        resolve('approved');
      } else {
        resolve('rejected');
      }
    };
  });
}

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
}