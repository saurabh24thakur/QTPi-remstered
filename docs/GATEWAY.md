# QTPi Gateway

The gateway turns QTPi from a terminal session into a **persistent daemon** that
serves many conversations at once — Telegram chats, HTTP callers, anything that
implements the channel contract.

It is **Phase 2** of the channel architecture:

| Phase | What it delivered | Pieces |
| --- | --- | --- |
| 1 | The channel *contract* — one runtime, many transports | `Channel.js`, `registry.js`, `TelegramChannel.js`, `WebhookChannel.js` |
| 2 | The *gateway* — a daemon that runs every enabled channel with per-sender isolation | `gateway/server.js`, `gateway/sessions.js`, `qtpi gateway` CLI |

> Phase 1 docs live in the **Channels** section of the README and the
> *channel abstraction* section of [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## The problem it solves

A channel alone is not enough. The agent holds **one** active conversation. If
two people message the bot at the same time against a single conversation:

- their messages interleave into one history,
- each sees the other's context,
- tool results land in the wrong turn.

The gateway fixes this with two guarantees:

1. **Isolation** — one `ConversationHistory` per `senderId`.
2. **Serialisation** — a lock around `agent.run()`, so the single agent slot is
   never driven concurrently.

Together: *many senders, one agent, no context bleed.*

---

## Quick start

```bash
# Enable a channel
export QTPI_CHANNELS=webhook
export QTPI_WEBHOOK_PORT=8787

# Run in the foreground
qtpi gateway start

# Or detach into the background
qtpi gateway start --detach

# Inspect / stop
qtpi gateway status
qtpi gateway stop
```

Then talk to it:

```bash
curl -s http://127.0.0.1:8787/message \
  -H 'content-type: application/json' \
  -d '{"senderId":"alice","text":"What does src/gateway/server.js do?"}'
```

```json
{ "senderId": "alice", "replies": ["…agent reply…"] }
```

Two different `senderId`s get two different conversations. Reusing `alice`
resumes her history.

Like every QTPi command, the gateway respects the standard config precedence:
**env var → project `./.qtpi/config.json` → global `~/.qtpi/config.json` → default.**

---

## CLI

```
qtpi gateway start [--detach]   Start the gateway (foreground by default)
qtpi gateway status             Report whether it is running + the pidfile path
qtpi gateway stop               Send SIGTERM and remove the pidfile
```

`start` refuses to launch if a live gateway already holds the pidfile, and it
refuses when no channels are enabled (it tells you which key to set).

`--detach` re-launches the process with `--foreground` via `spawn(..., {
detached: true })` and exits, so you get a background daemon without a
supervisor. `stop` is just `process.kill(pid, 'SIGTERM')` — the foreground
process tears the channels down on `SIGINT`/`SIGTERM` and deletes the pidfile.

---

## Configuration

| Key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `channelsEnabled` | `QTPI_CHANNELS` | `[]` | Channels to start (array or comma string) |
| `gatewayEnabled` | `QTPI_GATEWAY_ENABLED` | `false` | Master switch |
| `gatewayPidFile` | `QTPI_GATEWAY_PID_FILE` | `''` → `~/.qtpi/gateway.pid` | Where the pid is written |
| `gatewayMaxSessions` | `QTPI_GATEWAY_MAX_SESSIONS` | `200` | LRU cap on live sessions |
| `gatewaySessionTtlMs` | `QTPI_GATEWAY_SESSION_TTL_MS` | `0` | Drop sessions idle longer than this (`0` = never) |
| `webhookPort` | `QTPI_WEBHOOK_PORT` | `8787` | Webhook listen port |
| `webhookHost` | `QTPI_WEBHOOK_HOST` | `127.0.0.1` | Webhook bind host |
| `webhookPath` | `QTPI_WEBHOOK_PATH` | `/message` | Webhook route |
| `webhookAutoApprove` | `QTPI_WEBHOOK_AUTO_APPROVE` | `false` | Auto-approve sensitive tools (no interactive UI) |
| `telegramToken` | `QTPI_TELEGRAM_TOKEN` | — | Telegram bot token |

---

## Architecture

```
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │  Telegram    │   │   Webhook    │   │  (future)    │
        └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
               │ onMessage        │                  │
               └──────────┬───────┴──────────────────┘
                          ▼
                 ┌─────────────────┐
                 │   gateway.js    │  bindChannel() → route each message
                 │  createGateway  │
                 └────────┬────────┘
                          ▼
                 ┌─────────────────┐
                 │ sessionManager  │  senderId → ConversationHistory (+ lock)
                 └────────┬────────┘
                          ▼
                 ┌─────────────────┐
                 │  ONE runtime    │  provider + tools + memory + skills + agent
                 └─────────────────┘
```

### `createGateway({ workingDir, configWrapper, renderer, options })`

Builds the runtime **once**, then lazy-starts channels on `start()`.

Returns:

| Member | Description |
| --- | --- |
| `runtime` | The shared runtime from `createRuntime()` |
| `sessions` | The session manager (see below) |
| `channels` | `Map<name, channel>` of started channels |
| `bindChannel(channel)` | Wire a channel into the session router |
| `start()` / `stop()` | Start / stop every enabled channel |
| `status()` | `{ started, channels, sessions }` |

### `createSessionManager({ agent, maxSessions, idleTtlMs, now })`

Keeps an LRU-capped map of sessions. Each session owns its own conversation and
timestamps.

| Member | Description |
| --- | --- |
| `run(senderId, text)` | Swap the sender's history into the agent, run, save it back (locked) |
| `getOrCreate(senderId)` | Fetch or create a session |
| `get(senderId)` | Fetch without creating |
| `reset(senderId)` | Clear one session's history |
| `remove(senderId)` | Drop one session entirely |
| `list()` | All sessions, most-recently-used last |
| `stats()` | `{ sessions, messages }` |
| `sweep()` | Drop sessions past `idleTtlMs`; returns how many |
| `size` | Live session count |

**Why a lock?** The agent has exactly one `conversation` slot. `run()` swaps the
sender's history in, awaits the agent, then reads the (possibly replaced)
conversation back out. If two `run()` calls interleaved, sender B's
`setConversation` would fire while sender A's loop is still appending tool
results. The lock serialises `run()` calls into a promise chain, so each turn
sees its own history start to finish.

The swap uses the agent's purpose-built API:

```js
agent.setConversation(session.conversation);
try { await agent.run(text); }
finally { session.conversation = agent.getConversation(); }
```

`setConversation()` also (re)injects the system prompt (memory summary + skill
catalog), so every conversation starts fully equipped.

### Special messages

Handled in the gateway before the agent is touched:

- `/start` — welcome reply, resets approval state.
- `/reset` — clears **only that sender's** conversation and approval state.

---

## How the approval gate routes

The renderer and the approval handler are **retargeted** per message:

```js
channelRenderer.setTarget(message);   // renderer now replies into this chat
activeChannel = channel;              // approval handler now calls this channel
try { await sessions.run(senderId, text); }
finally { channelRenderer.setTarget(null); activeChannel = null; }
```

Because `run()` is serialised, exactly one channel is active at a time, so a
single `approvalHandler` can serve every transport. Concrete behaviour:

| Channel | `requestApproval()` |
| --- | --- |
| `telegram` | Inline approve / approve-all / reject buttons |
| `webhook` | `webhookAutoApprove ? 'approved' : 'rejected'` |

---

## Adding a channel

1. Implement the contract in `src/channels/YourChannel.js` and return
   `assertChannel(channel)`.
2. Register a factory in `src/channels/registry.js`.
3. Add its option keys to `configManager.js` (`DEFAULTS` + `ENV_MAP`).
4. Map its option keys in `channelOptions()` in `src/gateway/server.js`.
5. Add the name to `channelsEnabled` / `QTPI_CHANNELS`.

The gateway needs no other changes — `bindChannel()` wires it up.

---

## Testing

```bash
npm run test:gateway      # 8 tests: isolation, LRU, TTL, pidfile, HTTP e2e, wrapper authority
npm run test:channels     # Phase 1: contract + registry
npm test                  # the whole suite (116 tests)
```

`test/gateway.test.js` proves, against a stubbed provider:

- two senders keep **separate** conversations (no context bleed),
- `/reset` clears only the target sender,
- LRU eviction and TTL sweeping bound the session map,
- pidfile write/read/remove round-trips,
- the **real webhook channel** drives the gateway end-to-end over HTTP.

Run `node examples/gateway-example.mjs` for a live two-sender demo that prints
each sender's isolated transcript.

---

## Operational notes

- **State is in-memory.** Sessions do not survive a restart. Persisting them is
  a future step (the session objects are plain data and easy to serialise).
- **One gateway per pidfile.** A second `start` exits rather than fighting for
  the same channels/ports.
- **Sensitive tools.** Webhook callers have no interactive UI; they are
  *rejected* unless `webhookAutoApprove=true`. Prefer Telegram for workflows
  that need per-action consent.
- **Sessions are LRU-capped.** At `gatewayMaxSessions` (200 default) the
  least-recently-used sender is evicted. Set `gatewaySessionTtlMs` to also drop
  long-idle conversations.