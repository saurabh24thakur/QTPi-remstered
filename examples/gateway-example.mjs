// ================================================================
// FILE: examples/gateway-example.mjs
// PURPOSE: Live demo of the Phase 2 gateway — two senders, one agent,
// isolated conversations.
//
// Run:  node examples/gateway-example.mjs
//
// It boots a gateway with the webhook channel on an ephemeral port,
// then drives two different senderIds over HTTP and prints each
// sender's transcript to prove their contexts never mix.
//
// No API key needed: it uses a tiny echo provider so the demo is
// deterministic and offline.
// ================================================================

import { createGateway } from '../src/gateway/server.js';
import { createChannelRenderer } from '../src/channels/Channel.js';

const PORT = 0; // ephemeral — the OS picks a free port

// A deterministic provider: it reports how many of THIS sender's user
// turns it has seen, which is exactly what context bleed would corrupt.
const echoProvider = {
  name: 'echo',
  model: 'echo-1',
  async chat(messages) {
    const userTurns = messages.filter((m) => m.role === 'user').map((m) => m.content);
    return {
      content: `I have seen ${userTurns.length} message(s) from you. Latest: "${userTurns.at(-1)}"`,
      toolCalls: [],
    };
  },
};

function line(char = '─') {
  return char.repeat(64);
}

async function post(port, senderId, text) {
  const res = await fetch(`http://127.0.0.1:${port}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ senderId, text }),
  });
  return res.json();
}

async function main() {
  console.log(`\n${line('═')}`);
  console.log('  🧁 QTPi Gateway — Phase 2 demo (session isolation)');
  console.log(`${line('═')}\n`);

  const gateway = createGateway({
    workingDir: process.cwd(),
    configWrapper: { get: (key) => ({ webhookPort: PORT, webhookHost: '127.0.0.1' }[key]) },
    renderer: createChannelRenderer(),
    options: { provider: echoProvider, memory: false, channels: ['webhook'] },
  });

  await gateway.start();
  const { port } = gateway.channels.get('webhook').address();
  console.log(`  ✓ Gateway online — webhook listening on http://127.0.0.1:${port}/message\n`);

  // Two senders, interleaved on purpose.
  const script = [
    ['alice', 'Hi, my name is Alice.'],
    ['bob', 'Hi, my name is Bob.'],
    ['alice', 'What is my name?'],
    ['bob', 'What is my name?'],
  ];

  for (const [senderId, text] of script) {
    const body = await post(port, senderId, text);
    console.log(`  ${senderId.padEnd(6)} → "${text}"`);
    console.log(`         ← ${body.replies.join(' ')}\n`);
  }

  console.log(line());
  console.log('  Session state:');
  for (const session of gateway.sessions.list()) {
    const users = session.conversation.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
    console.log(`    • ${session.id.padEnd(6)} ${users.length} user turn(s): ${JSON.stringify(users)}`);
  }
  console.log(`\n  ${gateway.sessions.stats().sessions} isolated sessions, one shared agent.`);
  console.log(`  Notice each sender only ever sees their OWN turns — no context bleed.\n`);

  await gateway.stop();
  console.log('  ✓ Gateway stopped.\n');
}

main().catch((error) => {
  console.error('Gateway demo failed:', error);
  process.exit(1);
});
