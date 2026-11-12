// ================================================================
// FILE: src/gateway/server.js
// PURPOSE: The persistent QTPi gateway (Phase 2).
//
// A long-lived process that:
//   1. builds ONE runtime via createRuntime() (provider + all tools +
//      memory + skills + agent),
//   2. starts every channel listed in config `channelsEnabled`,
//   3. routes each inbound message to a per-sender session so two
//      chats never share context (see sessions.js).
//
// The gateway is transport-agnostic: it knows nothing about Telegram
// or HTTP beyond the channel contract (src/channels/Channel.js). Add a
// channel to the registry and it becomes available here for free.
//
// Lifecycle helpers (pidfile) let `qtpi gateway start|status|stop`
// manage a detached process without a supervisor.
// ================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';

import { getConfig, getConfigNumber, getConfigBool } from '../config/configManager.js';
import { createRuntimeWithPlugins } from '../runtime/createRuntime.js';
import { createChannelRenderer } from '../channels/Channel.js';
import { createChannel, resolveEnabledChannels } from '../channels/registry.js';
import { createSessionManager } from './sessions.js';
import { createControlUi } from './controlUi.js';
import { createAutomation } from '../automation/createAutomation.js';
import { createCollectingRenderer } from '../automation/scheduler.js';
import { acquireAgentLock } from '../core/AgentLock.js';

function normalizeStrings(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function parseAgents(raw) {
  if (Array.isArray(raw)) return raw.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
  } catch {
    throw new TypeError('The agents config must be a JSON array of agent definitions');
  }
}


// ─────────────────────────────────────────────────────────────
// createGateway({ workingDir, configWrapper, renderer, options })
//
//   workingDir     string   defaults to process.cwd()
//   configWrapper  { get }  defaults to { get: (k) => getConfig(k) }
//   renderer       object   defaults to a channel renderer
//   options        object   {
//                    provider, memory, approvalHandler,  // → createRuntime
//                    maxSessions, idleTtlMs,             // → session manager
//                    channels: ['webhook'],              // override config
//                  }
//
// Returns:
//   { runtime, sessions, channels, start, stop, status, bindChannel }
// ─────────────────────────────────────────────────────────────
export async function createGateway({ workingDir, configWrapper, renderer, options = {} } = {}) {
  const dir = workingDir || process.cwd();
  const config = configWrapper || { get: (key) => getConfig(key) };
  const channelRenderer = renderer || createChannelRenderer();

  // The channel whose message is currently being processed. Runs are
  // serialised by the session lock, so exactly one channel is "active"
  // at a time — this is how a single approvalHandler routes to the
  // right transport.
  let activeChannel = null;

  // Coerce through the injected wrapper (NOT the global getConfig* helpers)
  // so a caller-supplied configWrapper is authoritative. This is what lets
  // tests and examples pin e.g. webhookPort: 0 for an ephemeral port.
  const num = (key) => {
    const value = Number(config.get(key));
    return Number.isFinite(value) ? value : getConfigNumber(key);
  };
  const bool = (key) => {
    const value = config.get(key);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    if (value === undefined || value === null) return getConfigBool(key);
    return Boolean(value);
  };

  const runtimeOptions = {
    provider: options.provider,
    memory: options.memory,
  };
  const runtimeArgs = {
    workingDir: dir,
    configWrapper: config,
    renderer: channelRenderer,
    options: {
      ...runtimeOptions,
      approvalHandler: options.approvalHandler
        || ((toolName, args) => (activeChannel
          ? activeChannel.requestApproval(toolName, args)
          : Promise.resolve('rejected'))),
    },
  };

  const configuredAgents = parseAgents(config.get('agents'));
  const runtimeEntries = new Map();
  if (configuredAgents.length === 0) {
    runtimeEntries.set('default', {
      definition: { name: 'default', workspace: dir, channels: [], senders: [] },
      runtime: await createRuntimeWithPlugins(runtimeArgs),
    });
  } else {
    for (const definition of configuredAgents) {
      const name = String(definition.name || `agent-${runtimeEntries.size + 1}`);
      const workspace = path.resolve(dir, definition.workspace || '.');
      const scopedConfig = {
        get(key) {
          if (Object.prototype.hasOwnProperty.call(definition, key)) return definition[key];
          return config.get(key);
        },
      };
      const runtime = await createRuntimeWithPlugins({
        ...runtimeArgs,
        workingDir: workspace,
        configWrapper: scopedConfig,
      });
      runtimeEntries.set(name, {
        definition: {
          ...definition,
          name,
          workspace,
          channels: normalizeStrings(definition.channels),
          senders: normalizeStrings(definition.senders),
        },
        runtime,
      });
    }
  }
  const primary = runtimeEntries.values().next().value;
  const runtime = primary.runtime;

  for (const entry of runtimeEntries.values()) {
    entry.sessions = createSessionManager({
      agent: entry.runtime.agent,
      maxSessions: options.maxSessions ?? num('gatewayMaxSessions'),
      idleTtlMs: options.idleTtlMs ?? num('gatewaySessionTtlMs'),
    });
  }
  const sessions = primary.sessions;
  let routeLock = Promise.resolve();
  const channels = new Map();

  // Automation uses the same agent behind the shared execution lock,
  // while swapping in a collecting renderer for configured delivery.
  const automationRenderer = createCollectingRenderer();
  const automation = createAutomation({
    runtime,
    config,
    options: {
      enabled: options.automation,
      jobs: options.jobs,
      timeoutMs: options.automationTimeoutMs,
      autoApprove: options.automationAutoApprove,
      renderer: automationRenderer,
      deliver: async (job, output) => {
        if (!job.channel && !job.target) return;
        if (!job.channel || !job.target) {
          throw new Error(`Job "${job.id}" needs both channel and target to deliver output`);
        }
        const channel = channels.get(job.channel);
        if (!channel) throw new Error(`Job "${job.id}" references channel "${job.channel}" which is not running`);
        await channel.send(job.target, output);
      },
    },
  });

  let started = false;
  let controlUi = null;

  // Build the control UI (Phase 3) if enabled by config or options.
  function buildControlUi() {
    const enabled = options.controlUi ?? bool('controlUiEnabled');
    if (!enabled) return null;
    return createControlUi({
      gateway,
      config,
      host: options.controlUiHost || config.get('controlUiHost') || '127.0.0.1',
      port: options.controlUiPort ?? num('controlUiPort'),
      autoApprove: options.controlUiAutoApprove ?? bool('controlUiAutoApprove'),
    });
  }

  // Build the constructor options for a named channel from config.
  function channelOptions(name) {
    if (name === 'telegram') {
      return { token: config.get('telegramToken') };
    }
    if (name === 'webhook') {
      return {
        port: num('webhookPort'),
        host: config.get('webhookHost'),
        path: config.get('webhookPath'),
        autoApprove: bool('webhookAutoApprove'),
      };
    }
    return {};
  }

  // Route ONE inbound message through the shared runtime. Every channel
  // AND the control UI call this, so a dashboard message is processed
  // exactly like a Telegram/webhook message: same sessions, same gate.
  function selectRuntime(senderId, channelName) {
    const id = String(senderId ?? 'anonymous');
    for (const entry of runtimeEntries.values()) {
      if (entry.definition.senders.includes(id)) return entry;
    }
    const channelMatches = [...runtimeEntries.values()].filter((entry) =>
      entry.definition.channels.includes(channelName));
    return channelMatches[0] || primary;
  }

  async function routeMessage(message, channel) {
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    const reply = typeof message?.reply === 'function' ? message.reply : async () => {};
    if (!text) return;

    const senderId = message.senderId;

    if (text === '/start') {
      if (typeof channel.resetApproval === 'function') channel.resetApproval();
      await reply('🧁 QTPI is online! Send me any task or question for your codebase.');
      return;
    }

    if (text === '/reset') {
      if (typeof channel.resetApproval === 'function') channel.resetApproval();
      selectRuntime(senderId, channel?.name).sessions.reset(senderId);
      await reply('✓ Session and approval settings reset.');
      return;
    }

    const entry = selectRuntime(senderId, channel?.name);
    const run = routeLock.then(async () => {
      const releaseAgent = await acquireAgentLock(entry.runtime.agent);
      try {
        channelRenderer.setTarget(message);
        activeChannel = channel;
        await entry.sessions.run(senderId, text);
      } catch (error) {
        await reply(`❌ Execution Error: ${error.message}`);
      } finally {
        channelRenderer.setTarget(null);
        activeChannel = null;
        releaseAgent();
      }
    });
    routeLock = run.then(() => undefined, () => undefined);
    await run;
  }

  // Wire a channel's inbound messages into the shared router.
  function bindChannel(channel) {
    channel.onMessage((message) => routeMessage(message, channel));
    return channel;
  }

  async function start() {
    if (started) return gateway;

    const names = options.channels || resolveEnabledChannels(config);
    for (const name of names) {
      if (channels.has(name)) continue;
      const channel = createChannel(name, channelOptions(name), runtime.plugins.channels);
      bindChannel(channel);
      await channel.start();
      channels.set(name, channel);
    }

    // Control UI (Phase 3): a local dashboard over the same runtime.
    if (!controlUi) {
      controlUi = buildControlUi();
      if (controlUi) await controlUi.start();
    }

    // Automation (Phase 4): schedule jobs once the runtime is live.
    automation.start();

    started = true;
    return gateway;
  }

  async function stop() {
    automation.stop();
    if (controlUi) {
      try { await controlUi.stop(); } catch { /* ignore */ }
      controlUi = null;
    }
    for (const channel of channels.values()) {
      try {
        await channel.stop();
      } catch {
        // A channel that fails to stop must not block the others.
      }
    }
    channels.clear();
    started = false;
  }

  function status() {
    return {
      started,
      channels: [...channels.keys()],
      sessions: sessions.stats(),
      agents: [...runtimeEntries.keys()],
      controlUi: controlUi
        ? { running: controlUi.running, address: controlUi.address() }
        : null,
      automation: automation.status(),
    };
  }

  const gateway = {
    runtime,
    runtimes: runtimeEntries,
    sessions,
    channels,
    automation,
    bindChannel,
    routeMessage,
    start,
    stop,
    status,
    get started() { return started; },
    get controlUi() { return controlUi; },
  };

  return gateway;
}


// ─────────────────────────────────────────────────────────────
// Pidfile helpers — let `qtpi gateway status|stop` find a detached
// gateway process. Default location: ~/.qtpi/gateway.pid
// ─────────────────────────────────────────────────────────────

export function defaultPidFile() {
  return path.join(os.homedir(), '.qtpi', 'gateway.pid');
}

export function resolvePidFile(configWrapper) {
  const configured = configWrapper && typeof configWrapper.get === 'function'
    ? configWrapper.get('gatewayPidFile')
    : undefined;
  return configured || defaultPidFile();
}

export function writePidFile(pidFile, pid = process.pid) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(pid), 'utf-8');
  return pid;
}

export function readPidFile(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function removePidFile(pidFile) {
  try {
    fs.unlinkSync(pidFile);
    return true;
  } catch {
    return false;
  }
}

// Is a process with this pid alive? (signal 0 probes without killing.)
export function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we can't signal it.
    return error.code === 'EPERM';
  }
}

export function gatewayStatus(pidFile = defaultPidFile()) {
  const pid = readPidFile(pidFile);
  const running = isProcessAlive(pid);
  return { pid, running, pidFile };
}
