// ================================================================
// FILE: src/channels/Channel.js
// PURPOSE: The channel contract + the glue that binds a channel to a
// runtime.
//
// A "channel" is any transport that can carry a conversation to and
// from the agent: the terminal CLI, Telegram, a webhook, Discord…
// Every channel implements the same six-member contract so the
// gateway (Phase 2) can start them uniformly and route every inbound
// message into ONE shared runtime.
//
// CONTRACT
//   name                             string   stable channel id
//   start()                          Promise  begin listening
//   stop()                           Promise  stop listening
//   send(target, text)               Promise  push a message to a target
//   onMessage(handler)               void     register the inbound handler
//   requestApproval(toolName, args)  Promise  'approved' | 'rejected'
//
// The handler passed to onMessage receives a ChannelMessage:
//   { senderId, text, reply, sendTyping? }
//     senderId    string   stable id for the conversation partner
//     text        string   the inbound message
//     reply(text) fn       send a message back to this conversation
//     sendTyping  fn?      optional "typing…" indicator
//
// Channels MAY expose extra members (e.g. resetApproval(), sendTyping())
// — the contract is a minimum, not a maximum.
// ================================================================

/**
 * @typedef {Object} ChannelMessage
 * @property {string} senderId
 * @property {string} text
 * @property {(text: string) => (void|Promise<void>)} reply
 * @property {() => (void|Promise<void>)} [sendTyping]
 */

/**
 * @typedef {Object} Channel
 * @property {string} name
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(target: string, text: string) => Promise<void>} send
 * @property {(handler: (message: ChannelMessage) => (void|Promise<void>)) => void} onMessage
 * @property {(toolName: string, args: object) => Promise<'approved'|'rejected'>} requestApproval
 */

// The members every channel must implement.
export const CHANNEL_METHODS = ['start', 'stop', 'send', 'onMessage', 'requestApproval'];


// ─────────────────────────────────────────────────────────────
// assertChannel(channel)
// Throws a TypeError if `channel` does not satisfy the contract.
// Returns the channel so factories can `return assertChannel(ch)`.
// ─────────────────────────────────────────────────────────────
export function assertChannel(channel) {
  if (!channel || typeof channel !== 'object') {
    throw new TypeError('Channel must be an object');
  }
  if (typeof channel.name !== 'string' || channel.name.length === 0) {
    throw new TypeError('Channel must have a non-empty string "name"');
  }
  for (const method of CHANNEL_METHODS) {
    if (typeof channel[method] !== 'function') {
      throw new TypeError(`Channel "${channel.name}" is missing method ${method}()`);
    }
  }
  return channel;
}


// ─────────────────────────────────────────────────────────────
// createChannelRenderer()
// A renderer (the UI adapter the Agent talks to) that forwards every
// message to the *current* conversation target. bindChannelToRuntime()
// sets the target before each agent.run() and clears it afterwards.
//
// This is what lets ONE runtime serve MANY channels: the renderer is
// retargeted per inbound message instead of being hard-wired to one
// transport.
// ─────────────────────────────────────────────────────────────
export function createChannelRenderer() {
  let target = null;

  const reply = (text) => {
    if (target && typeof target.reply === 'function') return target.reply(text);
  };

  return {
    setTarget(next) { target = next || null; },

    startThinking() {
      if (target && typeof target.sendTyping === 'function') target.sendTyping();
    },
    stopThinking() {},
    streamToken() {},

    renderAssistant(text) { reply(text); },
    renderToolCall(name) { reply(`🔧 Tool Call: ${name}`); },
    renderToolResult() {},
    renderWarning(message) { reply(`⚠️ ${message}`); },
    renderError(message) { reply(`❌ Error: ${message}`); },
    renderWelcome() {},
  };
}


// ─────────────────────────────────────────────────────────────
// bindChannelToRuntime(channel, runtime, renderer)
// Wires a channel's inbound messages to runtime.agent.run().
//
//   - `/start`  → welcome reply (no agent call)
//   - `/reset`  → clear the conversation + reset approval state
//   - anything else → agent.run(text), output rendered via `renderer`
//
// Returns the channel (for chaining).
// ───────────────���─────────────────────────────────────────────
export function bindChannelToRuntime(channel, runtime, renderer) {
  assertChannel(channel);
  if (!runtime || !runtime.agent) {
    throw new TypeError('bindChannelToRuntime requires a runtime with an agent');
  }

  const setTarget = typeof renderer?.setTarget === 'function'
    ? (value) => renderer.setTarget(value)
    : () => {};

  channel.onMessage(async (message) => {
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    const reply = typeof message?.reply === 'function' ? message.reply : async () => {};
    if (!text) return;

    if (text === '/start') {
      if (typeof channel.resetApproval === 'function') channel.resetApproval();
      await reply('🧁 QTPI is online! Send me any task or question for your codebase.');
      return;
    }

    if (text === '/reset') {
      if (typeof channel.resetApproval === 'function') channel.resetApproval();
      runtime.agent.conversation.clear();
      await reply('✓ Session and approval settings reset.');
      return;
    }

    setTarget(message);
    try {
      await runtime.agent.run(text);
    } catch (error) {
      await reply(`❌ Execution Error: ${error.message}`);
    } finally {
      setTarget(null);
    }
  });

  return channel;
}
