// ================================================================
// FILE: src/runtime/createRuntime.js
// PURPOSE: Build the whole QTPi "brain + hands" stack in ONE place.
//
// Before this file, src/index.js (CLI) and src/channels/TelegramChannel.js
// each wired up their own provider + tools + memory + skills + agent.
// That duplication drifted: Telegram was missing the web, browser and
// skill tools. Now every entry point (CLI, Telegram, gateway, tests)
// calls createRuntime() and gets an identical, fully-featured stack.
//
// createRuntime() is deliberately UI-agnostic: it takes a `renderer`
// (the terminal Renderer, a Telegram renderer, a no-op test renderer…)
// and returns the assembled objects. It never touches readline, slash
// commands, or process.exit — those stay in the caller.
// ================================================================

import { getConfig } from '../config/configManager.js';
import { createProvider } from '../providers/ProviderFactory.js';
import { loadPlugins } from '../plugins/pluginLoader.js';

// tools
import { addToolSecrets, createRegistry } from '../tools/ToolRegistry.js';
import { registerFileTools } from '../tools/fileManager.js';
import { registerTerminalTools } from '../tools/TerminalRunner.js';
import { registerGitTools } from '../tools/GitManager.js';
import { registerSearchTools } from '../tools/searchTool.js';
import { registerWebSearchTools } from '../tools/webSearchTool.js';
import { registerWebCrawlTools } from '../tools/webCrawlTool.js';
import { createWebRuntime } from '../tools/web/webRuntime.js';

// browser control
import { registerBrowserTools } from '../tools/browserTool.js';
import { registerBrowserCommandTools } from '../tools/browserCommandTool.js';
import { createBrowserRuntime } from '../tools/browser/browserRuntime.js';

// skills system
import { createSkillRegistry } from '../skills/skillRegistry.js';
import { registerSkillTools } from '../tools/skillTool.js';

// RAG / Qdrant tool
import { registerRepoSearchTool } from '../rag/RepoSearch.js';

// memory
import { createLongTermMemory } from '../memory/LongTermMemory.js';

// core agent
import { createAgent } from '../core/Agent.js';


// ─────────────────────────────────────────────────────────────
// createRuntime({ workingDir, configWrapper, renderer, options })
//
//   workingDir     string   defaults to process.cwd()
//   configWrapper  { get }  defaults to { get: (k) => getConfig(k) }
//   renderer       object   the UI renderer (required by the agent)
//   options        object   {
//                    memory:   false  -> skip long-term memory + its tools
//                    provider: object -> inject a provider (tests / gateway)
//                    approvalHandler: async (toolName, args) => 'approved'|'rejected'
//                                     -> channel-specific approval gate
//                  }
//
// Returns:
//   { provider, toolRegistry, memory, skillRegistry, agent,
//     configWrapper, workingDir, webRuntime, browserRuntime }
//
// Throws if the provider cannot be created (caller decides how to
// report it — the CLI renders an error and exits, tests just fail).
// ─────────────────────────────────────────────────────────────
export function createRuntime({ workingDir, configWrapper, renderer, options = {} } = {}) {
  const dir = workingDir || process.cwd();
  const config = configWrapper || { get: (key) => getConfig(key) };

  // ── Provider (Brain Connection) ──────────────────────────────
  // A caller may inject a provider (used by tests and the gateway);
  // otherwise build one from the merged config.
  const toolRegistry = options.toolRegistry || createRegistry();
  addToolSecrets(toolRegistry, ['apiKey', 'searchApiKey', 'qdrantKey', 'telegramToken']
    .map((key) => config.get(key)));
  const plugins = options.plugins || { providers: new Map(), channels: new Map(), loaded: [] };
  const provider = options.provider || createProvider(config, plugins.providers);

  // ── Tool Registry (Hands) ────────────────────────────────────
  registerFileTools(toolRegistry, dir);
  registerTerminalTools(toolRegistry, dir, config);
  registerGitTools(toolRegistry, dir);
  registerSearchTools(toolRegistry, dir);

  // Shared web services (SSRF policy, result cache, logger, limits).
  const webRuntime = createWebRuntime(config);
  registerWebSearchTools(toolRegistry, config, webRuntime);
  registerWebCrawlTools(toolRegistry, config, webRuntime);

  // Shared browser services (one Chromium instance, one page map, one
  // logger, one SSRF policy). The browser launches lazily on first use,
  // so users who never touch these tools pay nothing.
  const browserRuntime = createBrowserRuntime(config, { logger: webRuntime.logger });
  registerBrowserTools(toolRegistry, config, browserRuntime);
  registerBrowserCommandTools(toolRegistry, config, browserRuntime);

  // Skills system: discover SKILL.md folders and expose them as tools.
  // The registry is also handed to the agent so the system prompt can
  // advertise the Level-1 catalog (name + description only).
  const skillRegistry = createSkillRegistry(config, { workingDir: dir });
  if (skillRegistry.enabled) {
    registerSkillTools(toolRegistry, config, skillRegistry);
  }

  // RAG / Qdrant semantic search tool.
  registerRepoSearchTool(toolRegistry, config, provider);

  // ── Memory ───────────────────────────────────────────────────
  const memory = createLongTermMemory(dir);
  if (options.memory !== false) {
    memory.registerMemoryTools(toolRegistry);
  }

  // ── Build Core Agent Brain ───────────────────────────────────
  const agent = createAgent({
    provider,
    tools: toolRegistry,
    memory,
    renderer,
    config,
    workingDir: dir,
    skills: skillRegistry,
    approvalHandler: options.approvalHandler,
  });

  return {
    provider,
    toolRegistry,
    memory,
    skillRegistry,
    agent,
    configWrapper: config,
    workingDir: dir,
    webRuntime,
    browserRuntime,
    plugins,
    renderer,
  };
}

/** Create a runtime after loading configured local plugins. */
export async function createRuntimeWithPlugins(args = {}) {
  const dir = args.workingDir || process.cwd();
  const config = args.configWrapper || { get: (key) => getConfig(key) };
  const toolRegistry = createRegistry();
  const plugins = await loadPlugins({ toolRegistry, config, workingDir: dir });
  return createRuntime({
    ...args,
    options: { ...(args.options || {}), toolRegistry, plugins },
  });
}
