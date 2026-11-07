// ================================================================
// FILE: test/gateway.test.js
// PURPOSE: Phase 2 — prove the persistent gateway isolates sessions.
//
//   1. Two senderIds driving the gateway keep SEPARATE conversations
//      (no context bleed) even though they share ONE agent/runtime.
//   2. A single sender keeps context across turns.
//   3. /reset clears only that sender's session.
//   4. The pidfile helpers round-trip and report liveness.
//   5. LRU + TTL eviction bound the session map.
//   6. The webhook channel drives the gateway end-to-end over HTTP.
//
// Run:  node --test test/gateway.test.js
// ================================================================

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createGateway, writePidFile, readPidFile, removePidFile, isProcessAlive } from '../src/gateway/server.js';
import { createSessionManager } from '../src/gateway/sessions.js';
import { createChannelRenderer } from '../src/channels/Channel.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpi-gateway-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));


function makeConfig(overrides = {}) {
  return { get: (key) => overrides[key] };
}


// A provider that echoes back what it saw so tests can inspect context.
function makeEchoProvider() {
  return {
    name: 'echo',
    model: 'echo-1',
    async chat(messages) {
      const userTurns = messages.filter((m) => m.role === 'user').map((m) => m.content);
      return { content: `seen:${userTurns.length}:${userTurns.at(-1)}`, toolCalls: [] };
    },
  };
}


// A minimal in-memory channel (contract-compliant).
function createFakeChannel(name = 'fake') {
  let handler = null;
  return {
    name,
    async start() {},
    async stop() {},
    async send() {},
    onMessage(h) { handler = h; },
    async requestApproval() { return 'approved'; },
    async emit(message) { return handler(message); },
  };
}


describe('Phase 2: session isolation', () => {
  test('two senders never share conversation context', async () => {
    const gateway = createGateway({
      workingDir: TMP,
      configWrapper: makeConfig(),
      renderer: createChannelRenderer(),
      options: { provider: makeEchoProvider(), memory: false, channels: [] },
    });

    const channel = createFakeChannel();
    gateway.bindChannel(channel);

    const aReplies = [];
    const bReplies = [];
    await channel.emit({ senderId: 'alice', text: 'hi-from-alice', reply: (t) => aReplies.push(t) });
    await channel.emit({ senderId: 'bob', text: 'hi-from-bob', reply: (t) => bReplies.push(t) });
    await channel.emit({ senderId: 'alice', text: 'second-from-alice', reply: (t) => aReplies.push(t) });

    // Alice's third turn should have seen exactly two of HER user turns —
    // never Bob's message. If context leaked, alice would show 3+.
    assert.match(aReplies.at(-1), /seen:2:second-from-alice/);
    assert.match(bReplies.at(-1), /seen:1:hi-from-bob/);

    // Two distinct sessions, isolated histories.
    assert.equal(gateway.sessions.size, 2);
    const alice = gateway.sessions.get('alice');
    const bob = gateway.sessions.get('bob');
    const aliceUsers = alice.conversation.getMessages().filter((m) => m.role === 'user').map((m) => m.content);
    assert.deepEqual(aliceUsers, ['hi-from-alice', 'second-from-alice']);
    assert.deepEqual(bob.conversation.getMessages().filter((m) => m.role === 'user').map((m) => m.content), ['hi-from-bob']);

    await gateway.stop();
  });

  test('/reset clears only the target sender', async () => {
    const gateway = createGateway({
      workingDir: TMP,
      configWrapper: makeConfig(),
      renderer: createChannelRenderer(),
      options: { provider: makeEchoProvider(), memory: false, channels: [] },
    });
    const channel = createFakeChannel();
    gateway.bindChannel(channel);

    await channel.emit({ senderId: 'alice', text: 'one', reply: () => {} });
    await channel.emit({ senderId: 'bob', text: 'two', reply: () => {} });

    const replies = [];
    await channel.emit({ senderId: 'alice', text: '/reset', reply: (t) => replies.push(t) });

    assert.match(replies.join('\n'), /reset/i);
    assert.equal(gateway.sessions.get('alice').conversation.getMessages().length, 1);
    assert.ok(gateway.sessions.get('bob').conversation.getMessages().length > 1);

    await gateway.stop();
  });
});


describe('Phase 2: session manager bounds', () => {
  test('LRU eviction caps live sessions', async () => {
    const agent = {
      conversation: null,
      async run() {},
      setConversation(c) { this.conversation = c; },
      getConversation() { return this.conversation; },
    };
    const sessions = createSessionManager({ agent, maxSessions: 2 });

    await sessions.run('a', '1');
    await sessions.run('b', '2');
    await sessions.run('c', '3'); // evicts least-recently-used (a)

    assert.equal(sessions.size, 2);
    assert.equal(sessions.get('a'), undefined);
    assert.ok(sessions.get('b'));
    assert.ok(sessions.get('c'));
  });

  test('TTL sweep drops idle sessions', () => {
    const agent = { async run() {}, setConversation() {}, getConversation() {} };
    let clock = 1_000;
    const sessions = createSessionManager({ agent, idleTtlMs: 100, now: () => clock });

    sessions.getOrCreate('a');
    clock += 50;
    sessions.getOrCreate('b');
    clock += 100; // 'a' is now 150ms idle, 'b' is 100ms idle

    const dropped = sessions.sweep();
    assert.equal(dropped, 1);
    assert.equal(sessions.get('a'), undefined);
    assert.ok(sessions.get('b'));
  });
});


describe('Phase 2: the injected configWrapper is authoritative', () => {
  test('webhookPort from the wrapper wins over the global default', async () => {
    const gateway = createGateway({
      workingDir: TMP,
      configWrapper: makeConfig({ webhookPort: 0, webhookHost: '127.0.0.1' }),
      renderer: createChannelRenderer(),
      options: { provider: makeEchoProvider(), memory: false, channels: ['webhook'] },
    });
    await gateway.start();
    const { port } = gateway.channels.get('webhook').address();
    // 0 means "ephemeral" — the OS assigns a free port. If the wrapper were
    // ignored we'd be pinned to the 8787 default instead.
    assert.notEqual(port, 8787);
    assert.ok(port > 0);
    await gateway.stop();
  });

  test('gatewayMaxSessions from the wrapper caps the session map', async () => {
    const gateway = createGateway({
      workingDir: TMP,
      configWrapper: makeConfig({ gatewayMaxSessions: 1 }),
      renderer: createChannelRenderer(),
      options: { provider: makeEchoProvider(), memory: false, channels: [] },
    });
    const channel = createFakeChannel();
    gateway.bindChannel(channel);

    await channel.emit({ senderId: 'a', text: 'one', reply: () => {} });
    await channel.emit({ senderId: 'b', text: 'two', reply: () => {} });

    assert.equal(gateway.sessions.size, 1);
    assert.equal(gateway.sessions.get('a'), undefined);
    assert.ok(gateway.sessions.get('b'));
    await gateway.stop();
  });
});


describe('Phase 2: pidfile helpers', () => {
  test('write/read/remove round-trip', () => {
    const pidFile = path.join(TMP, 'nested', 'gateway.pid');
    writePidFile(pidFile, 4321);
    assert.equal(readPidFile(pidFile), 4321);
    assert.equal(isProcessAlive(4321), false); // almost certainly not a real pid
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(removePidFile(pidFile), true);
    assert.equal(readPidFile(pidFile), null);
  });
});


describe('Phase 2: the gateway drives a real channel end-to-end', () => {
  test('webhook channel: HTTP POST → agent → JSON replies', async () => {
    const gateway = createGateway({
      workingDir: TMP,
      configWrapper: makeConfig({ webhookPort: 0, webhookHost: '127.0.0.1' }),
      renderer: createChannelRenderer(),
      options: { provider: makeEchoProvider(), memory: false, channels: ['webhook'] },
    });

    await gateway.start();
    const webhook = gateway.channels.get('webhook');
    assert.ok(webhook, 'webhook channel should be started');

    const { port } = webhook.address();
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ senderId: 'u-http', text: 'ping' }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.senderId, 'u-http');
    assert.match(body.replies.join('\n'), /seen:1:ping/);

    await gateway.stop();
  });
});
