// ================================================================
// FILE: src/gateway/sessions.js
// PURPOSE: Per-sender session isolation for the gateway.
//
// The gateway runs ONE runtime (one provider, one tool registry, one
// agent) but MANY conversations. The agent holds a single active
// conversation, so a session manager:
//
//   1. keeps a ConversationHistory per senderId,
//   2. swaps it into the agent before each run (agent.setConversation),
//   3. serialises runs through a lock so two senders can never
//      interleave inside the agent's single conversation slot.
//
// Without the lock, sender B's message could land in sender A's
// history mid-run. The lock is the correctness guarantee; the map is
// the isolation guarantee.
// ================================================================

import { createConversation } from '../memory/ConversationHistory.js';


// ─────────────────────────────────────────────────────────────
// createSessionManager({ agent, maxSessions, idleTtlMs, now })
//
//   agent        object  the runtime agent (needs run/setConversation)
//   maxSessions  number  LRU cap on live sessions (default 200)
//   idleTtlMs    number  drop sessions idle longer than this (0 = never)
//   now          fn      injectable clock (tests)
//
// Returns:
//   run(senderId, text)   → Promise<session>   run one turn in that session
//   get(senderId)         → session | undefined
//   getOrCreate(senderId) → session
//   reset(senderId)       → boolean            clear one session's history
//   remove(senderId)      → boolean            drop one session entirely
//   list()                → session[]          (most recently used last)
//   stats()               → { sessions, messages }
//   sweep()               → number             sessions dropped by TTL
//   clear()               → void               drop every session
//   size                  → number             live session count
// ─────────────────────────────────────────────────────────────
export function createSessionManager({
  agent,
  maxSessions = 200,
  idleTtlMs = 0,
  now = () => Date.now(),
} = {}) {
  if (!agent || typeof agent.run !== 'function') {
    throw new TypeError('createSessionManager requires an agent with run()');
  }
  if (typeof agent.setConversation !== 'function') {
    throw new TypeError('createSessionManager requires agent.setConversation()');
  }

  const sessions = new Map();

  // Serialises agent.run() calls: the agent has exactly one active
  // conversation, so concurrent runs would corrupt each other.
  let lock = Promise.resolve();

  function withLock(fn) {
    const result = lock.then(() => fn());
    // Keep the chain alive whether the run resolved or threw.
    lock = result.then(() => undefined, () => undefined);
    return result;
  }

  function normalizeId(senderId) {
    const id = senderId == null ? '' : String(senderId).trim();
    return id || 'anonymous';
  }

  function createSession(id) {
    const timestamp = now();
    return {
      id,
      conversation: createConversation(),
      createdAt: timestamp,
      lastUsedAt: timestamp,
      messageCount: 0,
    };
  }

  // Drop the least-recently-used session, never the one just created.
  function evictIfNeeded(keepId) {
    while (sessions.size > maxSessions) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, session] of sessions) {
        if (id === keepId) continue;
        if (session.lastUsedAt < oldestAt) {
          oldestAt = session.lastUsedAt;
          oldestId = id;
        }
      }
      if (oldestId === null) break;
      sessions.delete(oldestId);
    }
  }

  function sweep() {
    if (!idleTtlMs || idleTtlMs <= 0) return 0;
    const cutoff = now() - idleTtlMs;
    let dropped = 0;
    for (const [id, session] of sessions) {
      if (session.lastUsedAt < cutoff) {
        sessions.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  function getOrCreate(senderId) {
    const id = normalizeId(senderId);
    let session = sessions.get(id);

    if (!session) {
      sweep();
      session = createSession(id);
      sessions.set(id, session);
      evictIfNeeded(id);
    }

    return session;
  }

  function get(senderId) {
    return sessions.get(normalizeId(senderId));
  }

  // Run one turn inside the sender's own conversation.
  function run(senderId, text) {
    return withLock(async () => {
      const session = getOrCreate(senderId);

      session.lastUsedAt = now();
      session.messageCount += 1;

      // Swap this sender's history into the agent's single slot.
      agent.setConversation(session.conversation);

      try {
        await agent.run(text);
      } finally {
        // Keep whatever the agent ended up with (it may have replaced
        // the object) so the next turn resumes the same history.
        session.conversation = agent.getConversation();
        session.lastUsedAt = now();
      }

      return session;
    });
  }

  function reset(senderId) {
    const session = get(senderId);
    if (!session) return false;
    session.conversation.clear();
    session.messageCount = 0;
    session.lastUsedAt = now();
    return true;
  }

  function remove(senderId) {
    return sessions.delete(normalizeId(senderId));
  }

  function list() {
    return [...sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  }

  function stats() {
    let messages = 0;
    for (const session of sessions.values()) {
      messages += session.conversation.getMessages().length;
    }
    return { sessions: sessions.size, messages };
  }

  function clear() {
    sessions.clear();
  }

  return {
    run,
    get,
    getOrCreate,
    reset,
    remove,
    list,
    stats,
    sweep,
    clear,
    get size() { return sessions.size; },
  };
}
