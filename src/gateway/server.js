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
import { createRuntime } from '../runtime/createRuntime.js';
import { createChannelRenderer } from '../channels/Channel.js';
import { createChannel, resolveEnabledChannels } from '../channels/registry.js';
import { createSessionManager } from './sessions.js';


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
export function createGateway({ workingDir, configWrapper, renderer, options = {} } = {}) {
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

  const runtime = createRuntime({
    workingDir: dir,
    configWrapper: config,
    renderer: channelRenderer,
    options: {
      provider: options.provider,
      memory: options.memory,
      approvalHandler: options.approvalHandler
        || ((toolName, args) => (activeChannel
          ? activeChannel.requestApproval(toolName, args)
          : Promise.resolve('rejected'))),
    },
  });

  const sessions = createSessionManager({
    agent: runtime.agent,
    maxSessions: options.maxSessions ?? num('gatewayMaxSessions'),
    idleTtlMs: options.idleTtlMs ?? num('gatewaySessionTtlMs'),
  });

  const channels = new Map();
  let started = false;

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

  // Wire a channel's inbound messages into the session manager.
  function bindChannel(channel) {
    channel.onMessage(async (message) => {
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
        sessions.reset(senderId);
        await reply('✓ Session and approval settings reset.');
        return;
      }

      // Retarget the shared renderer + approval gate at this message.
      channelRenderer.setTarget(message);
      activeChannel = channel;
      try {
        await sessions.run(senderId, text);
      } catch (error) {
        await reply(`❌ Execution Error: ${error.message}`);
      } finally {
        channelRenderer.setTarget(null);
        activeChannel = null;
      }
    });

    return channel;
  }

  async function start() {
    if (started) return gateway;

    const names = options.channels || resolveEnabledChannels(config);
    for (const name of names) {
      if (channels.has(name)) continue;
      const channel = createChannel(name, channelOptions(name));
      bindChannel(channel);
      await channel.start();
      channels.set(name, channel);
    }

    started = true;
    return gateway;
  }

  async function stop() {
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
    };
  }

  const gateway = {
    runtime,
    sessions,
    channels,
    bindChannel,
    start,
    stop,
    status,
    get started() { return started; },
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
