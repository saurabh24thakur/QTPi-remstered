# QTPi Gateway

The gateway turns QTPi from a terminal session into a **persistent daemon** that
serves many conversations at once — Telegram chats, HTTP callers, anything that
implements the channel contract.

It documents **Phases 2–4** of the channel architecture:

| Phase | What it delivered | Pieces |
| --- | --- | --- |
| 1 | The channel *contract* — one runtime, many transports | `Channel.js`, `registry.js`, `TelegramChannel.js`, `WebhookChannel.js` |
| 2 | The *gateway* — a daemon that runs every enabled channel with per-sender isolation | `gateway/server.js`, `gateway/sessions.js`, `qtpi gateway` CLI |
| 3 | The *control UI* — a local dashboard over the same runtime | `gateway/controlUi.js`, `qtpi dashboard` CLI |
| 4 | Scheduled automation — cron jobs on the shared runtime | `automation/`, `qtpi jobs` CLI |

Plugin loading and named runtimes are documented in
[`PLUGINS.md`](PLUGINS.md); security behavior is documented in
[`SECURITY.md`](SECURITY.md).

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
| `controlUiEnabled` | `QTPI_CONTROL_UI_ENABLED` | `false` | Serve the dashboard from the gateway |
| `controlUiPort` | `QTPI_CONTROL_UI_PORT` | `8788` | Dashboard listen port |
| `controlUiHost` | `QTPI_CONTROL_UI_HOST` | `127.0.0.1` | Dashboard bind host (loopback only by default) |
| `controlUiAutoApprove` | `QTPI_CONTROL_UI_AUTO_APPROVE` | `false` | Dashboard auto-approves sensitive tools |
| `automationEnabled` | `QTPI_AUTOMATION_ENABLED` | `false` | Start configured cron jobs with the gateway |
| `automationJobs` | `QTPI_AUTOMATION_JOBS` | `[]` | Inline job definitions (JSON array in the environment) |
| `automationJobsFile` | `QTPI_AUTOMATION_JOBS_FILE` | `''` | Path to a JSON jobs file |
| `automationAutoApprove` | `QTPI_AUTOMATION_AUTO_APPROVE` | `false` | Default approval policy for scheduled jobs |
| `automationTimezone` | `QTPI_AUTOMATION_TIMEZONE` | system timezone | Default cron timezone |
| `automationRunTimeoutMs` | `QTPI_AUTOMATION_RUN_TIMEOUT_MS` | `300000` | Timeout before cancellation is requested |
| `automationLogEnabled` | `QTPI_AUTOMATION_LOG_ENABLED` | `false` | Append job results to a JSONL log |
| `automationLogFile` | `QTPI_AUTOMATION_LOG_FILE` | `~/.qtpi/automation.log` | Automation log path |

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
| `control-ui` | `controlUiAutoApprove ? 'approved' : 'rejected'` |

---

## Control UI (Phase 3)

The control UI is a **local, dependency-free dashboard** served over Node's
built-in `http` — no framework, no build step. It is a *view* onto the same
gateway: a message typed into the dashboard is routed through
`gateway.routeMessage()`, so it is processed **exactly** like a Telegram or
webhook message (same runtime, same per-sender session, same approval gate).

```bash
qtpi dashboard                 # start + open http://127.0.0.1:8788
qtpi dashboard --port 9000     # custom port
qtpi dashboard --no-open       # do not launch a browser
qtpi dashboard --auto-approve  # allow sensitive tools from the dashboard
```

Or enable it on the gateway itself:

```bash
export QTPI_CONTROL_UI_ENABLED=true
qtpi gateway start
```

### HTTP surface

| Method | Route | Returns |
| --- | --- | --- |
| `GET` | `/` | The self-contained dashboard HTML |
| `GET` | `/api/status` | `{ started, channels, sessions, sessionList }` |
| `GET` | `/api/config` | The merged config with **secrets masked** (`maskConfig`) |
| `POST` | `/api/message` | `{ senderId, text }` → `{ senderId, replies }` |

### `createControlUi({ gateway, config, host, port, autoApprove })`

| Member | Description |
| --- | --- |
| `start()` / `stop()` | Bind / close the HTTP server |
| `address()` | `{ address, port }` once listening, else `null` |
| `handleMessage(senderId, text)` | Route one message, return the reply strings |
| `requestApproval(tool, args)` | The dashboard's approval gate |
| `running` | Whether the server is listening |

### Security posture

- **Loopback only.** Binds `127.0.0.1` by default; nothing is exposed to the LAN.
- **No secrets.** `/api/config` runs the merged config through `maskConfig`,
  so API keys and tokens never leave the process.
- **Closed gate.** A browser has no interactive approval prompt, so sensitive
  tools are **rejected** unless `controlUiAutoApprove=true` — the same posture
  as the webhook channel.
- **Request checks.** Dashboard posts require the page's CSRF token and a
  matching local origin/host. The server only accepts loopback hosts.

---

## Automation (Phase 4)

The gateway starts cron jobs only when `automationEnabled` is true. Define jobs
inline with `automationJobs` or in the JSON file set by `automationJobsFile`.
Each job needs an `id`, a cron `schedule`, and a `prompt`; `enabled`,
`timezone`, `autoApprove`, `senderId`, `channel`, and `target` are optional.
Inline jobs override file entries with the same ID. Set both `channel` and
`target` to deliver output through a channel that the gateway starts.

```bash
qtpi jobs list [--json]
qtpi jobs validate
qtpi jobs run <id> [--verbose]
```

Scheduled runs reject sensitive tools by default. `automationRunTimeoutMs`
requests cancellation; an in-flight tool may continue, and the shared agent
lock remains held until it exits. Detailed config keys are listed above.

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
npm run test:gateway      # gateway isolation, sessions, pidfile, webhook e2e
npm run test:channels     # Phase 1: contract + registry
npm test                  # the full Node test suite
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
