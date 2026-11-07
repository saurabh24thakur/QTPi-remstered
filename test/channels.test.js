// ================================================================
// FILE: test/channels.test.js
// PURPOSE: Phase 1 — prove the channel abstraction.
//
//   1. The contract validator accepts good channels, rejects bad ones.
//   2. The registry maps names → factories and returns contract-compliant
//      channels (telegram, webhook).
//   3. A fake channel drives runtime.agent.run() end-to-end with a
//      stubbed provider — including the approval gate.
//
// Run:  node --test test/channels.test.js
// ================================================================

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  assertChannel,
  createChannelRenderer,
  bindChannelToRuntime,
  CHANNEL_METHODS,
} from '../src/channels/Channel.js';
import { createChannel, listChannels, resolveEnabledChannels } from '../src/channels/registry.js';
import { createRuntime } from '../src/runtime/createRuntime.js';

// Isolated workspace so the runtime never touches the real project.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpi-channels-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// A syntactically valid Telegram bot token (Telegraf validates the shape).
const TELEGRAM_TOKEN = '123456789:' + 'A'.repeat(35);


function makeConfig(overrides = {}) {
  return { get: (key) => overrides[key] };
}


function makeProvider(reply = 'Hello from QTPI') {
  return {
    name: 'mock',
    model: 'mock-1',
    async chat() {
      return { content: reply, toolCalls: [] };
    },
  };
}


// A minimal in-memory channel that satisfies the contract.
function createFakeChannel() {
  let handler = null;
  const sent = [];
  return {
    name: 'fake',
    sent,
    async start() {},
    async stop() {},
    async send(target, text) { sent.push({ target, text }); },
    onMessage(h) { handler = h; },
    async requestApproval() { return 'approved'; },
    async emit(message) { return handler(message); },
  };
}


describe('Phase 1: the channel contract', () => {
  test('assertChannel accepts a well-formed channel', () => {
    const channel = createFakeChannel();
    assert.equal(assertChannel(channel), channel);
  });

  test('assertChannel rejects a channel missing required members', () => {
    assert.throws(() => assertChannel({ name: 'broken' }), /missing method start/);
    assert.throws(() => assertChannel({}), /non-empty string "name"/);
    assert.throws(() => assertChannel(null), /must be an object/);
  });

  test('CHANNEL_METHODS lists the required members', () => {
    assert.deepEqual(CHANNEL_METHODS, ['start', 'stop', 'send', 'onMessage', 'requestApproval']);
  });
});


describe('Phase 1: the channel registry', () => {
  test('lists the built-in channels', () => {
    const names = listChannels();
    assert.ok(names.includes('telegram'), 'telegram should be registered');
    assert.ok(names.includes('webhook'), 'webhook should be registered');
  });

  test('createChannel returns contract-compliant channels', () => {
    const telegram = createChannel('telegram', { token: TELEGRAM_TOKEN });
    assert.equal(telegram.name, 'telegram');
    assert.doesNotThrow(() => assertChannel(telegram));

    const webhook = createChannel('webhook', { port: 0 });
    assert.equal(webhook.name, 'webhook');
    assert.doesNotThrow(() => assertChannel(webhook));
  });

  test('createChannel throws on an unknown name', () => {
    assert.throws(() => createChannel('carrier-pigeon'), /Unknown channel/);
  });

  test('resolveEnabledChannels parses arrays and comma strings', () => {
    assert.deepEqual(resolveEnabledChannels({ get: () => ['telegram', 'webhook'] }), ['telegram', 'webhook']);
    assert.deepEqual(resolveEnabledChannels({ get: () => 'telegram, webhook' }), ['telegram', 'webhook']);
    assert.deepEqual(resolveEnabledChannels({ get: () => undefined }), []);
  });
});


describe('Phase 1: a channel drives the runtime end-to-end', () => {
  test('inbound message → agent.run → reply', async () => {
    const renderer = createChannelRenderer();
    const runtime = createRuntime({
      workingDir: TMP,
      configWrapper: makeConfig(),
      renderer,
      options: { provider: makeProvider('Hello from QTPI'), memory: false },
    });

    const channel = createFakeChannel();
    bindChannelToRuntime(channel, runtime, renderer);

    const replies = [];
    await channel.emit({ senderId: 'u1', text: 'hi there', reply: (t) => replies.push(t) });

    assert.match(replies.join('\n'), /Hello from QTPI/);
    const last = runtime.agent.conversation.getMessages().at(-1);
    assert.equal(last.role, 'assistant');
    assert.equal(last.content, 'Hello from QTPI');
  });

  test('/reset clears the conversation', async () => {
    const renderer = createChannelRenderer();
    const runtime = createRuntime({
      workingDir: TMP,
      configWrapper: makeConfig(),
      renderer,
      options: { provider: makeProvider('ok'), memory: false },
    });

    const channel = createFakeChannel();
    bindChannelToRuntime(channel, runtime, renderer);

    const replies = [];
    await channel.emit({ senderId: 'u1', text: 'hello', reply: (t) => replies.push(t) });
    assert.ok(runtime.agent.conversation.getMessages().length > 1);

    await channel.emit({ senderId: 'u1', text: '/reset', reply: (t) => replies.push(t) });
    const messages = runtime.agent.conversation.getMessages();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'system');
    assert.match(replies.join('\n'), /reset/i);
  });

  test('the approval gate is consulted for sensitive tools', async () => {
    const channel = createFakeChannel();
    let asked = null;
    channel.requestApproval = async (toolName, args) => {
      asked = { toolName, args };
      return 'rejected';
    };

    const renderer = createChannelRenderer();
    const runtime = createRuntime({
      workingDir: TMP,
      configWrapper: makeConfig(),
      renderer,
      options: {
        memory: false,
        approvalHandler: (toolName, args) => channel.requestApproval(toolName, args),
        provider: {
          name: 'mock',
          model: 'mock-1',
          async chat(messages) {
            const alreadyRanTool = messages.some((m) => m.role === 'tool');
            if (!alreadyRanTool) {
              return {
                content: '',
                toolCalls: [{
                  id: 'call_1',
                  name: 'write_file',
                  arguments: { filePath: 'should-not-exist.txt', content: 'nope' },
                }],
              };
            }
            return { content: 'done', toolCalls: [] };
          },
        },
      },
    });

    bindChannelToRuntime(channel, runtime, renderer);

    const replies = [];
    await channel.emit({ senderId: 'u1', text: 'write a file', reply: (t) => replies.push(t) });

    assert.ok(asked, 'requestApproval should have been called');
    assert.equal(asked.toolName, 'write_file');
    assert.equal(fs.existsSync(path.join(TMP, 'should-not-exist.txt')), false);
    assert.match(replies.join('\n'), /done/);
  });
});
