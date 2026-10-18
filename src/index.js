import chalk from 'chalk';
import { createInterface } from 'readline/promises';


import { getConfig, getAllConfig } from './config/configManager.js';
import { createProvider } from './providers/ProviderFactory.js';

//tools
import { createRegistry } from './tools/ToolRegistry.js';
import { registerFileTools } from './tools/fileManager.js';
import { registerTerminalTools } from './tools/TerminalRunner.js';
import { registerGitTools } from './tools/GitManager.js';
import { registerSearchTools } from './tools/searchTool.js';
import { registerWebSearchTools } from './tools/webSearchTool.js';
import { registerWebCrawlTools } from './tools/webCrawlTool.js';
import { createWebRuntime } from './tools/web/webRuntime.js';

// RAG/Qdrant tool
import { registerRepoSearchTool } from './rag/RepoSearch.js';
import { createVectorStore } from './rag/VectorStore.js';
import { indexRepository } from './rag/Indexer.js';

//memory
import { createLongTermMemory } from './memory/LongTermMemory.js';

//core agent
import { createAgent } from './core/Agent.js';

// modes
import { createAgentMode } from './modes/AgentMode.js';
import { createAskMode } from './modes/AskMode.js';
import { createPlanMode } from './modes/PlanMode.js';

// renderer ui
import { createRenderer } from './ui/Renderer.js';



export async function startAgent(options = {}) {
  const workingDir = process.cwd();
  const renderer = createRenderer();

  //  Provider (Brain Connection) 
  let provider;
  try {
    const configData = getAllConfig();
    provider = createProvider(configData);
    console.log(chalk.gray(`  Brain connected: ${provider.name} (${provider.model})`));
  } catch (error) {
    renderer.renderError(`Failed to initialize provider: ${error.message}`);
    process.exit(1);
  }

  //  Tool Registry (Hands) 
  const toolRegistry = createRegistry();

  registerFileTools(toolRegistry, workingDir);
  registerTerminalTools(toolRegistry, workingDir);
  registerGitTools(toolRegistry, workingDir);
  registerSearchTools(toolRegistry, workingDir);

  // Register RAG Qdrant search tool
  const configWrapper = { get: (key) => getConfig(key) };

  // Shared web services (SSRF policy, result cache, logger, limits).
  const webRuntime = createWebRuntime(configWrapper);

  registerWebSearchTools(toolRegistry, configWrapper, webRuntime);
  registerWebCrawlTools(toolRegistry, configWrapper, webRuntime);
  registerRepoSearchTool(toolRegistry, configWrapper, provider);

  //  Memory   
  const longTermMemory = createLongTermMemory(workingDir);

  // Register memory tools so AI can save/recall facts
  if (options.memory !== false) {
    longTermMemory.registerMemoryTools(toolRegistry);
  }

  //  Build Core Agent Brain 
  const agent = createAgent({
    provider,
    tools: toolRegistry,
    memory: longTermMemory,
    renderer,
    config: configWrapper,
    workingDir,
  });

  //  Initialize Modes 
  const modes = {
    agent: createAgentMode(agent),
    ask: createAskMode(agent),
    plan: createPlanMode(agent),
  };

  let currentMode = modes[options.mode] || modes.agent;

  //  One-Shot Mode 
  if (options.oneShot && options.initialQuestion) {
    try {
      await currentMode.processInput(options.initialQuestion);
    } catch (error) {
      renderer.renderError(error.message);
    }
    await agent.endSession();
    return;
  }

  //  Interactive Terminal REPL Loop 
  renderer.renderWelcome(currentMode.name);

  // Inquirer pauses stdin when its menu prompts close; resume it before
  // handing input to the interactive chat loop.
  if (!process.stdin.destroyed) process.stdin.resume();

  let rl = null;
  let interrupted = false;
  const handleInterrupt = () => { interrupted = true; rl?.close(); };
  process.on('SIGINT', handleInterrupt);

  const processInput = async (line) => {
    const input = line.trim();
    if (!input) return true;
    if (input.startsWith('/')) {
      const result = await handleSlashCommand(input, {
        modes,
        setCurrentMode: (mode) => { currentMode = mode; },
        agent,
        renderer,
        memory: longTermMemory,
        configWrapper,
        workingDir,
        provider,
      });
      return result !== 'exit';
    }
    try {
      await currentMode.processInput(input);
    } catch (error) {
      renderer.renderError(error.message);
    }
    return true;
  };

  try {
    if (options.initialQuestion) await processInput(options.initialQuestion);
    while (!interrupted) {
      // Recreate the reader for each turn. This prevents an input interface
      // closed by a previous prompt from ending the whole chat session.
      if (process.stdin.destroyed || process.stdin.readableEnded) break;
      process.stdin.resume();
      rl = createInterface({ input: process.stdin, output: process.stdout });
      let line;
      try {
        line = await rl.question(chalk.cyan('  You: '));
      } catch {
        if (interrupted || process.stdin.destroyed || process.stdin.readableEnded) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      } finally {
        if (rl && !rl.closed) rl.close();
        rl = null;
      }
      if (!(await processInput(line))) break;
    }
  } finally {
    process.off('SIGINT', handleInterrupt);
    if (rl && !rl.closed) rl.close();
    console.log(chalk.magenta('\n  QTPI is going to sleep. Sweet dreams!\n'));
    await agent.endSession();
  }
}


async function handleSlashCommand(input, context) {
  const { modes, setCurrentMode, agent, memory, configWrapper, workingDir, provider } = context;
  const command = input.toLowerCase().split(' ')[0];

  switch (command) {

    case '/ask':
      setCurrentMode(modes.ask);
      console.log(chalk.magenta('  ✓ Switched to Ask mode (read-only)\n'));
      break;

    case '/plan':
      setCurrentMode(modes.plan);
      console.log(chalk.magenta('  ✓ Switched to Plan mode\n'));
      break;

    case '/agent':
      setCurrentMode(modes.agent);
      console.log(chalk.magenta('  ✓ Switched to Agent mode (full access)\n'));
      break;

    case '/actions':
      // Calls ActionTracker summary!
      console.log('\n' + agent.getActionSummary() + '\n');
      break;

    case '/memory':
      const memories = memory.recall();
      if (memories) {
        console.log(chalk.magenta('\n  🧠 Long-Term Memory:\n'));
        console.log(memories.split('\n').map(l => '  ' + l).join('\n') + '\n');
      } else {
        console.log(chalk.gray('\n  No memories stored yet.\n'));
      }
      break;

    case '/clear':
      agent.conversation.clear();
      console.log(chalk.gray('  ✓ Conversation cleared.\n'));
      break;

    case '/index':
      try {
        console.log(chalk.magenta('\n  📇 Indexing repository into Qdrant...\n'));
        const vectorStore = createVectorStore(configWrapper);
        await indexRepository(workingDir, vectorStore, provider);
        console.log('');
      } catch (error) {
        console.log(chalk.red(`\n  ❌ Indexing failed: ${error.message}\n`));
      }
      break;

    case '/exit':
    case '/quit':
    case '/bye':
      return 'exit';

    case '/help':
      console.log(chalk.gray('\n  Available Commands:'));
      console.log(chalk.white('  /ask     ') + chalk.gray('Switch to Ask mode (read-only)'));
      console.log(chalk.white('  /plan    ') + chalk.gray('Switch to Plan mode'));
      console.log(chalk.white('  /agent   ') + chalk.gray('Switch to Agent mode (default)'));
      console.log(chalk.white('  /actions ') + chalk.gray('Show session actions log'));
      console.log(chalk.white('  /memory  ') + chalk.gray('Show long-term stored memories'));
      console.log(chalk.white('  /clear   ') + chalk.gray('Clear short-term chat history'));
      console.log(chalk.white('  /index   ') + chalk.gray('Index repository into Qdrant'));
      console.log(chalk.white('  /exit    ') + chalk.gray('Quit QTPI\n'));
      break;

    default:
      console.log(chalk.yellow(`  Unknown command: ${command}. Type /help for options.\n`));
  }

  return 'continue';
}
