import chalk from 'chalk';
import readline from 'readline';


import { getConfig, getAllConfig } from './config/configManager.js';
import { createProvider } from './providers/ProviderFactory.js';

//tools
import { createRegistry } from './tools/ToolRegistry.js';
import { registerFileTools } from './tools/fileManager.js';
import { registerTerminalTools } from './tools/TerminalRunner.js';
import { registerGitTools } from './tools/GitManager.js';
import { registerSearchTools } from './tools/SearchTool.js';

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

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('  You: '),
  });

  rl.prompt();

  // Handle line inputs
  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // Handle slash commands (/ask, /plan, /actions, /memory, etc.)
    if (input.startsWith('/')) {
      const result = await handleSlashCommand(input, {
        modes,
        setCurrentMode: (m) => { currentMode = m; },
        agent,
        renderer,
        memory: longTermMemory,
        configWrapper,
        workingDir,
        provider,
      });

      if (result === 'exit') {
        rl.close();
        return;
      }

      rl.prompt();
      return;
    }

    // Process normal prompt using current mode
    try {
      await currentMode.processInput(input);
    } catch (error) {
      renderer.renderError(error.message);
    }

    rl.prompt();
  });

  // Handle graceful exit (Ctrl+D or /exit)
  rl.on('close', async () => {
    console.log(chalk.magenta('\n  🧁 QTPI is going to sleep. Sweet dreams!\n'));
    await agent.endSession();
    process.exit(0);
  });

  // Handle Ctrl+C
  process.on('SIGINT', async () => {
    console.log(chalk.magenta('\n\n  🧁 QTPI is going to sleep. Sweet dreams!\n'));
    await agent.endSession();
    process.exit(0);
  });
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