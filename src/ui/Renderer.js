import chalk from 'chalk';
import ora from 'ora';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// Configure marked to render markdown for the terminal
marked.use(markedTerminal({
  code: chalk.cyan,
  codespan: chalk.cyan,
  strong: chalk.bold.white,
  em: chalk.italic,
  heading: chalk.magenta.bold,
}));



export function createRenderer() {

  let spinner = null;        // Current loading spinner
  let isStreaming = false;   // Are we currently streaming text?
  let streamBuffer = '';     // Accumulated streamed text


 
  function startThinking() {
    spinner = ora({
      text: chalk.gray(' Thinking...'),
      color: 'magenta',
      spinner: 'dots',
    }).start();
  }


 
  // ───────────────────────────────────────────────────────
  function stopThinking() {
    if (spinner) {
      spinner.stop();
      spinner = null;
    }
  }



  // ───────────────────────────────────────────────────────
  function streamToken(token) {
    // First token: stop spinner and show the QTPI label
    if (spinner) {
      spinner.stop();
      spinner = null;
      process.stdout.write(chalk.magenta('\n  🧁 QTPI: '));
      isStreaming = true;
    }

    // Write the token directly (no newline)
    process.stdout.write(token);
    streamBuffer += token;
  }



  // ───────────────────────────────────────────────────────
  function renderAssistant(content) {
    // If we already streamed it, just add a newline and done
    if (isStreaming) {
      console.log('\n');
      isStreaming = false;
      streamBuffer = '';
      return;
    }

    // Not streaming — render the full response at once
    console.log(chalk.magenta('\n  🧁 QTPI:\n'));

    try {
      const rendered = marked(content);
      // Indent every line for nice spacing
      const indented = rendered.split('\n').map(line => '  ' + line).join('\n');
      console.log(indented);
    } catch {
      // If markdown fails, just print plain text
      console.log('  ' + content);
    }
  }


  // ───────────────────────────────────────────────────────
  function renderToolCall(toolName, args) {
    // Format args nicely (truncate long values)
    const argsDisplay = Object.entries(args || {})
      .map(([key, value]) => {
        let displayVal;
        if (typeof value === 'string') {
          displayVal = value.length > 50 ? value.slice(0, 50) + '...' : value;
        } else {
          displayVal = JSON.stringify(value);
        }
        return `${chalk.gray(key)}=${chalk.white(displayVal)}`;
      })
      .join(', ');

    console.log(chalk.yellow(`\n  🔧 Using: ${chalk.bold(toolName)}`));
    if (argsDisplay) {
      console.log(chalk.gray(`     ${argsDisplay}`));
    }
  }


  // ───────────────────────────────────────────────────────
  function renderToolResult(toolName, result) {
    const maxDisplay = 400;
    let displayResult = result;

    if (result.length > maxDisplay) {
      displayResult = result.slice(0, maxDisplay) +
        chalk.gray(`\n     ... (${result.length - maxDisplay} more characters)`);
    }

    console.log(chalk.green(`  ✓ ${toolName} completed`));

    // Indent the result
    const indented = displayResult.split('\n').map(l => '     ' + l).join('\n');
    console.log(chalk.gray(indented));
  }


  // ───────────────────────────────────────────────────────
  function renderWarning(message) {
    console.log(chalk.yellow(`\n  ⚠ ${message}\n`));
  }

  // ───────────────────────────────────────────────────────
  function renderError(message) {
    console.log(chalk.red(`\n  ❌ Error: ${message}\n`));
  }


  // ───────────────────────────────────────────────────────
  function renderWelcome(mode) {
    console.log(chalk.magenta(`
  ╔══════════════════════════════════════════╗
  ║          🧁 QTPI is awake!              ║
  ║                                          ║
  ║  Your AI coding agent is ready to help   ║
  ╚══════════════════════════════════════════╝
    `));

    console.log(chalk.gray(`  Mode: ${mode}`));
    console.log(chalk.gray(`  Working in: ${process.cwd()}`));
    console.log('');
    console.log(chalk.gray('  Commands:'));
    console.log(chalk.white('  /ask     ') + chalk.gray('Switch to ask mode (read-only)'));
    console.log(chalk.white('  /plan    ') + chalk.gray('Switch to plan mode'));
    console.log(chalk.white('  /agent   ') + chalk.gray('Switch to agent mode (default)'));
    console.log(chalk.white('  /actions ') + chalk.gray('Show actions taken this session'));
    console.log(chalk.white('  /memory  ') + chalk.gray('View stored memories'));
    console.log(chalk.white('  /clear   ') + chalk.gray('Clear conversation'));
    console.log(chalk.white('  /index   ') + chalk.gray('Index repo for smart search'));
    console.log(chalk.white('  /exit    ') + chalk.gray('Quit QTPI'));
    console.log('');
  }


  return {
    startThinking,
    stopThinking,
    streamToken,
    renderAssistant,
    renderToolCall,
    renderToolResult,
    renderWarning,
    renderError,
    renderWelcome,
  };
}