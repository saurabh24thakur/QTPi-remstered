# 🏗️ QTPi Architecture

A complete map of how QTPi-Remastered is put together: the layers, the agentic
loop, the tool registry, the provider adapters, RAG, skills, and the web/browser
runtimes. Every diagram below is drawn from the actual source.

> **Want an editable diagram?** Use the `excalidraw` skill
> (`skill_read { name: "excalidraw" }`) to turn any of these flows into an
> `.excalidraw` scene you can open at <https://excalidraw.com>.
>
> 📐 A ready-made editable scene of this architecture lives at
> [`docs/diagrams/qtpi-architecture.excalidraw`](diagrams/qtpi-architecture.excalidraw)
> — open it at <https://excalidraw.com> (File → Open) or with the VS Code
> Excalidraw extension.

---

## 1. High-level layered architecture

```mermaid
graph TB
    subgraph Entry["🚪 Entry Layer"]
        BIN["bin/qtpi.js<br/>(Commander CLI)"]
    end

    subgraph Modes["🎛️ Modes"]
        AM["AgentMode<br/>full access"]
        ASKM["AskMode<br/>read-only wrapper"]
        PM["PlanMode<br/>plan → approve → execute"]
        PL["Planner<br/>createPlan / displayPlan"]
        PM --> PL
    end

    subgraph Core["🧠 Core Brain"]
        AG["Agent<br/>agentic loop (max 25)"]
        CONV["ConversationHistory<br/>short-term (50 msgs)"]
        ACT["ActionTracker<br/>.qtpi/actions.log"]
    end

    subgraph Providers["🔌 Provider Adapters"]
        PF["ProviderFactory"]
        OAI["openaiCompatible<br/>openai/openrouter/groq"]
        ANT["anthropic"]
        GEM["gemini"]
        OLL["ollama"]
        PF --> OAI & ANT & GEM & OLL
    end

    subgraph Tools["🖐️ Tool Registry (Map)"]
        TR["ToolRegistry<br/>register / definitions / execute"]
        FS["fileManager"]
        TERM["TerminalRunner"]
        GIT["GitManager"]
        SRCH["searchTool"]
        WEB["web tools"]
        BRW["browser tools"]
        SKL["skill tools"]
        RAG["RepoSearch"]
        MEMT["memory tools"]
    end

    subgraph Safety["🛡️ Safety"]
        GATE["ApprovalGate<br/>dangerous tools"]
    end

    subgraph Memory["💾 Memory"]
        LTM["LongTermMemory<br/>.qtpi/memory.json"]
    end

    subgraph RAGL["📇 RAG / Qdrant"]
        IDX["Indexer"]
        VS["VectorStore (Qdrant)"]
    end

    subgraph Skills["🧩 Skills"]
        SKREG["skillRegistry"]
        SKMAN["skillManifest"]
        SKCTX["skillContext"]
    end

    subgraph UI["🖥️ Presentation"]
        REN["Renderer<br/>chalk + ora + marked"]
    end

    subgraph Channels["📡 Channels"]
        CHREG["channels/registry<br/>name → factory"]
        CHC["channels/Channel<br/>contract + renderer + bind"]
        TG["TelegramChannel<br/>Telegraf"]
        WH["WebhookChannel<br/>built-in http"]
        TGA["TelegramApproval"]
        CHREG --> TG & WH
        TG --> TGA
        TG & WH -.implement.-> CHC
    end

    subgraph Config["⚙️ Config"]
        CM["configManager<br/>DEFAULTS + ENV_MAP"]
    end

    BIN --> Modes
    BIN --> AG
    BIN --> IDX
    Modes --> AG
    AG --> CONV & ACT & GATE
    AG -->|chat| PF
    AG -->|executeTool| TR
    AG -->|recall/save| LTM
    AG -->|inject catalog| SKCTX
    TR --> FS & TERM & GIT & SRCH & WEB & BRW & SKL & RAG & MEMT
    RAG --> VS
    IDX --> VS
    SKL --> SKREG --> SKMAN
    SKREG --> SKCTX
    TG --> AG
    CM -.feeds.-> PF & WEB & BRW & SKREG & VS
    REN -.used by.-> AG
```

---

## 2. Startup / wiring flow (`startAgent`)

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant CLI as bin/qtpi.js
    participant IDX as src/index.js
    participant CFG as configManager
    participant PROV as ProviderFactory
    participant REG as ToolRegistry
    participant WEB as createWebRuntime
    participant BRW as createBrowserRuntime
    participant SK as createSkillRegistry
    participant AG as createAgent

    U->>CLI: qtpi wakeup
    CLI->>CFG: isConfigured()
    CLI->>U: prompt channel (cli / telegram / exit)
    CLI->>U: prompt mode (agent / ask / plan)
    CLI->>IDX: startAgent({mode, memory})
    IDX->>CFG: getAllConfig()
    IDX->>PROV: createProvider(configData)
    PROV-->>IDX: {name, model, chat, embed}
    IDX->>REG: createRegistry() → Map
    IDX->>REG: registerFileTools / Terminal / Git / Search
    IDX->>WEB: createWebRuntime(configWrapper)
    WEB-->>IDX: {cache, logger, ssrf, limits}
    IDX->>REG: registerWebSearchTools / registerWebCrawlTools
    IDX->>BRW: createBrowserRuntime(cfg,{logger})  (lazy Chromium)
    IDX->>REG: registerBrowserTools / registerBrowserCommandTools
    IDX->>SK: createSkillRegistry(cfg,{workingDir})
    alt skillRegistry.enabled
        IDX->>REG: registerSkillTools
    end
    IDX->>REG: registerRepoSearchTool(cfg, provider)
    IDX->>REG: memory.registerMemoryTools (unless --no-memory)
    IDX->>AG: createAgent({provider, tools, memory, renderer, config, workingDir, skills})
    AG-->>IDX: agent {run, conversation, tracker, endSession...}
    IDX->>IDX: build modes {agent, ask, plan}
    IDX->>U: renderWelcome + REPL loop
```

> **Note:** `createWebRuntime(config)` has a side effect — it calls
> `configureHttpClient({ ssrf, logger })`, installing the SSRF policy globally on
> the shared HTTP layer.

---

## 3. The agentic loop

```mermaid
flowchart TD
    A["agent.run(userMessage)"] --> B["conversation.addUserMessage"]
    B --> C{"iterations < 25?"}
    C -- no --> W["renderWarning: max iterations"] --> Z["return"]
    C -- yes --> D["renderer.startThinking"]
    D --> E["provider.chat(messages, toolDefs, streamToken)"]
    E -->|error| E1["tracker.error + throw"]
    E --> F["renderer.stopThinking"]
    F --> G{"aiResponse.toolCalls?"}
    G -- yes --> H["render text if any"]
    H --> I["conversation.addAssistantMessage(content, toolCalls)"]
    I --> J["for each toolCall"]
    J --> K["renderer.renderToolCall + tracker.tool_call"]
    K --> L{"needsApproval?"}
    L -- yes --> M["askUserApproval (inquirer: approve / approve_all / reject / view_diff)"]
    M -->|rejected| N["toolResult = ❌ rejected"]
    M -->|approved| O["executeTool(registry,name,args)"]
    L -- no --> O
    O --> P["renderer.renderToolResult + tracker.tool_result"]
    P --> Q["conversation.addToolResult(id, result)"]
    Q --> R["continue → next iteration"]
    R --> C
    G -- no --> S{"aiResponse.content?"}
    S -- yes --> T["addAssistantMessage + renderAssistant"]
    T --> Z
    S -- no --> Z
```

### Tool execution contract (`ToolRegistry.executeTool`)

```mermaid
flowchart LR
    X["executeTool(reg, name, args)"] --> Y{"tool exists?"}
    Y -- no --> Y1["'Error: Unknown tool ... Available: ...'"]
    Y -- yes --> Z["await tool.handler(args)"]
    Z -->|throws| E["'Error executing name: msg'"]
    Z -->|string| S["return as-is"]
    Z -->|object| J["JSON.stringify(result, null, 2)"]
```

---

## 4. Tool catalog

```mermaid
graph LR
    subgraph File["📁 fileManager"]
        rf["read_file"]; wf["write_file"]; ef["edit_file"]; lf["list_files"]; df["delete_file"]
    end
    subgraph Term["⌨️ TerminalRunner"]
        rc["run_command"]
    end
    subgraph GitG["🔀 GitManager"]
        gs["git_status"]; gd["git_diff"]; gl["git_log"]; gc["git_commit"]
    end
    subgraph SearchG["🔍 searchTool"]
        sc["search_code"]; ff["find_files"]
    end
    subgraph WebG["🌐 web tools"]
        ws["web_search"]; wc["web_crawl"]
    end
    subgraph Brows["🖥️ browser tools"]
        br["browser"]; brc["browser_command"]
    end
    subgraph SkillsG["🧩 skillTool"]
        sl["skill_list"]; sr["skill_read"]; srun["skill_run (opt-in)"]
    end
    subgraph RAGG["📇 RAG"]
        srepo["search_repository"]
    end
    subgraph MemG["💾 memory"]
        sm["save_memory"]; rm["recall_memories"]
    end
```

**Dangerous tools (gated by `ApprovalGate`):** `write_file`, `edit_file`,
`delete_file`, `run_command`, `git_commit`.

---

## 5. Provider adapter layer

```mermaid
graph TD
    CHAT["provider.chat(messages, tools, onStream)"] --> NORM["normalized { content, toolCalls[], finishReason }"]
    EMB["provider.embed(texts[])"] --> VEC["embeddings[][]"]

    PF["createProvider()"] -->|"provider key"| SW{switch}
    SW -->|openai/openrouter/groq| OAI["OpenAI SDK<br/>+ BASE_URLS map"]
    SW -->|anthropic| ANT["Anthropic SDK<br/>system separated; tool_use blocks"]
    SW -->|gemini| GEM["GoogleGenerativeAI<br/>strips additionalProperties"]
    SW -->|ollama| OLL["fetch localhost:11434"]
```

| Provider | `chat` | `embed` |
|---|---|---|
| openai | ✅ (streaming + tool_calls glue) | ✅ `text-embedding-3-small` |
| openrouter / groq | ✅ | ❌ throws (use OpenAI/Gemini/Ollama) |
| anthropic | ✅ (`tool_use` / `tool_result`) | ❌ throws |
| gemini | ✅ (`functionCall`, role="model") | ✅ `text-embedding-004` |
| ollama | ✅ (non-streaming) | ✅ `/api/embeddings` |

---

## 6. RAG pipeline (`qtpi index` → `search_repository`)

```mermaid
flowchart LR
    subgraph Index["Indexing (one-time)"]
        F["walk repo<br/>skip node_modules/.git/.qtpi/..."] --> C["chunk: 100 lines each"]
        C --> B["batch 50 → provider.embed"]
        B --> VS[("Qdrant<br/>collection qtpi_&lt;hash(cwd)&gt;")]
    end
    subgraph Query["Query (tool call)"]
        Q["search_repository(query, topK)"] --> QE["provider.embed([query])"]
        QE --> VSS["VectorStore.search (cosine)"]
        VSS --> RES["filePath + lines + content + score"]
    end
```

`VectorStore` guards with `isIndexed()` (checks the collection exists **and**
`points_count > 0`) before searching.

---

## 7. Skills system (3-level progressive disclosure)

```mermaid
flowchart TD
    ROOTS["Discovery roots (last wins by name)<br/>1. builtin src/skills<br/>2. global ~/.qtpi/skills<br/>3. project ./.qtpi/skills"] --> SCAN["scan(): find dirs with SKILL.md"]
    SCAN --> PARSE["skillManifest.parseSkillManifest (frontmatter + body)"]
    PARSE --> REG["skillRegistry: Map name→manifest"]

    REG -->|Level 1| L1["formatSkillCatalog → injected into system prompt"]
    REG -->|Level 2| L2["skill_read → formatSkillBody"]
    REG -->|Level 3| L3["skill_read {resource} → formatSkillResource (path-traversal guarded)"]
    REG -->|opt-in| L4["skill_run → execFileSync, only scripts/ listed by skill"]
```

---

## 8. Web & browser runtimes (shared services)

```mermaid
graph LR
    subgraph WEBRT["webRuntime"]
        CACHE["cache"]; LOG["webLogger"]; SSRF["ssrf policy"]; LIM["limits"]
        HTTP["httpClient<br/>configureHttpClient(global)"]
    end
    WEBRT --> LONG["web_search<br/>searchProviders + DDG fallback"]
    WEBRT --> LCRAWL["web_crawl<br/>crawler + robots + extractor"]

    subgraph BRWRT["browserRuntime (lazy)"]
        LAUNCH["launch() Chromium"]; PAGES["pages Map"]; LOG2["logger (shared)"]
    end
    BRWRT --> B1["browser (one action)"]
    BRWRT --> B2["browser_command (≤25 steps)"]
```

---

## 9. Persistence map

```mermaid
graph TD
    H["~/.qtpi/"] --> HC["config.json (global)"]
    H --> HL["web.log / browser.log"]
    P["./.qtpi/ (workingDir)"] --> PC["config.json (project)"]
    P --> MEM["memory.json"]
    P --> LOGS["actions.log (JSONL)"]
    P --> DL["downloads/ (screenshots)"]
```

Config resolution priority: **env var → project config → global config →
built-in `DEFAULTS`** (`configManager.getConfig`).

---

## 10. Module dependency tree

```
bin/qtpi.js
├── src/index.js ────────────────► startAgent()   (CLI: renderer, modes, REPL, slash cmds)
│   ├── runtime/createRuntime.js ─► the shared "brain + hands" factory
│   │   ├── config/configManager.js
│   │   ├── providers/ProviderFactory.js
│   │   ├── tools/ToolRegistry.js
│   │   ├── tools/{fileManager,TerminalRunner,GitManager,searchTool}.js
│   │   ├── tools/{webSearchTool,webCrawlTool}.js ─► tools/web/webRuntime.js
│   │   ├── tools/{browserTool,browserCommandTool}.js ─► tools/browser/{browserRuntime,browserActions}.js
│   │   ├── skills/skillRegistry.js + tools/skillTool.js
│   │   ├── rag/RepoSearch.js
│   │   ├── memory/LongTermMemory.js
│   │   └── core/Agent.js
│   │       ├── memory/ConversationHistory.js
│   │       ├── core/ActionTracker.js
│   │       ├── tools/ToolRegistry.js
│   │       ├── tools/ApprovalGate.js
│   │       └── skills/skillContext.js
│   ├── modes/{AgentMode,AskMode,PlanMode}.js ─► core/Planner.js
│   ├── ui/Renderer.js
│   └── rag/{VectorStore,Indexer}.js   (used by the /index slash command)
├── src/channels/registry.js ─► { telegram, webhook }   (name → factory)
├── src/channels/Channel.js ─► contract + createChannelRenderer() + bindChannelToRuntime()
├── src/channels/TelegramChannel.js ─► runtime/createRuntime.js, TelegramApproval.js
├── src/channels/WebhookChannel.js ─► built-in http (no deps)
├── src/gateway/server.js ─► createGateway() (runtime + channel router + pidfile)
├── src/gateway/sessions.js ─► createSessionManager() (per-sender isolation + run lock)
└── src/providers/ProviderFactory.js
```

Both entry points (the CLI and every channel) build their stack through
`runtime/createRuntime.js`, so they share one identical, fully-featured tool set.
`createRuntime()` is UI-agnostic: it takes a `renderer` and returns
`{ provider, toolRegistry, memory, skillRegistry, agent, configWrapper,
workingDir, webRuntime, browserRuntime }`.

### The channel abstraction

A **channel** is any transport that carries a conversation to and from the
agent. Every channel implements the same six-member contract
(`src/channels/Channel.js`):

| member | purpose |
| --- | --- |
| `name` | stable channel id (`'telegram'`, `'webhook'`, …) |
| `start()` / `stop()` | begin / end listening |
| `send(target, text)` | push a message to a target |
| `onMessage(handler)` | register the inbound handler |
| `requestApproval(toolName, args)` | return `'approved'` \| `'rejected'` |

The handler receives `{ senderId, text, reply, sendTyping? }`. `assertChannel()`
validates the contract; `registry.createChannel(name, options)` builds one by
name; `resolveEnabledChannels(config)` reads `channelsEnabled`
(`QTPI_CHANNELS`, comma-separated).

`bindChannelToRuntime(channel, runtime, renderer)` glues a channel to ONE
shared runtime. `createChannelRenderer()` is a retargetable renderer: it forwards
agent output to the *current* conversation, so a single runtime can serve many
channels (the basis for the gateway). `/start` and `/reset` are handled
here without calling the agent.

Two channels ship today:

- **telegram** — Telegraf, with inline approve/reject buttons (`TelegramApproval.js`).
- **webhook** — a dependency-free HTTP channel: `POST /message`
  `{ senderId, text }` → `{ senderId, replies }`. Sensitive tools are rejected
  unless `autoApprove` is set (no interactive UI).

The CLI itself is not yet a channel object — it remains in `startAgent()` —
but the gateway runs every enabled channel against one runtime.

### The gateway

The **gateway** (`src/gateway/server.js` + `sessions.js`, CLI: `qtpi gateway
start|status|stop`) is the daemon that turns the channel abstraction into a
multi-user service. It builds the runtime **once**, lazy-starts every channel in
`channelsEnabled`, and routes each inbound message to a **per-`senderId`**
session.

| Concern | Where | Mechanism |
| --- | --- | --- |
| Per-sender isolation | `sessions.js` | one `ConversationHistory` per `senderId` |
| No concurrent agent use | `sessions.js` | `run()` is serialised behind a promise-chain lock |
| Bounded memory | `sessions.js` | LRU cap (`gatewayMaxSessions`) + idle TTL (`gatewaySessionTtlMs`) |
| Renderer/approval routing | `server.js` | the retargetable renderer + a single `approvalHandler` are pointed at the active channel per message |
| Lifecycle | `bin/qtpi.js` | pidfile (`gatewayPidFile`) write on start, SIGTERM/SIGINT teardown + remove on stop |

`run()` swaps the sender's history into the one agent slot with
`agent.setConversation()` / `agent.getConversation()`, so `setConversation()`
also (re)injects the system prompt (memory summary + skill catalog) per turn.
See [`GATEWAY.md`](GATEWAY.md) for the full contract, config table and e2e notes.

---

## ⚠️ Known issues / drift

1. ~~**Case-sensitive import bugs (Windows-only tolerance).**~~ **FIXED.** The
   `bin/qtpi.js` → `ConfigManager.js` and `TelegramChannel.js` → `SearchTool.js`
   case mismatches are gone; a repo-wide import-case scan now reports zero
   problems.
2. ~~**`createProvider` ignores its argument.**~~ **FIXED.** `createProvider()`
   takes no parameters and reads config internally; `createRuntime()` now calls
   it with no argument, so the misleading `configData` / `getAllConfig()` passes
   are gone.
3. ~~**Telegram channel is stale.**~~ **FIXED.** `TelegramChannel.js` now builds
   its stack via `runtime/createRuntime.js`, so Telegram gets the same web,
   browser, skill, RAG and memory tools as the CLI.
4. **`searchTool.js` `regex.test()` on a `/g` regex** with a manual
   `lastIndex = 0` reset — works, but fragile; `matchAll` per line would be safer.
5. **`search_repository` gates on `isIndexed()` first**, so it silently no-ops
   until `qtpi index` runs (by design, but the model may not know why).
