# QTPi

<p align="center">

<img src="https://img.shields.io/badge/AI-Agent-blue" />
<img src="https://img.shields.io/badge/RAG-Powered-green" />
<img src="https://img.shields.io/badge/Multi--Provider-AI-orange" />
<img src="https://img.shields.io/badge/Node.js-CLI-brightgreen" />

</p>


> **QTPi is an AI-powered developer assistant that understands your repository, retrieves relevant code context, creates implementation plans, and safely modifies projects through an approval-based agent workflow.**


QTPi combines:

- AI Agent workflows
- Retrieval-Augmented Generation (RAG)
- Vector database search
- AI SDK providers
- Tool calling
- Safe filesystem operations

to provide a powerful AI coding assistant directly inside your terminal.

---

# 🎥 Demo

## Watch QTPi in Action

Demo Video:

https://drive.google.com/file/d/1b1AeQtTKKtDzBtVrCAv_qb9wDNfXvXm9/view?usp=sharing


### Demo Includes

- Interactive CLI assistant
- Repository understanding
- RAG-powered code search
- AI planning
- Agent based modifications
- Approval workflow
- Telegram integration


---

# ✨ Features


## 🤖 AI Agent System

QTPi uses an autonomous agent architecture.

The agent can:

- Understand developer goals
- Analyze existing codebases
- Retrieve repository knowledge
- Use tools dynamically
- Generate implementation plans
- Propose code modifications


---

# 🔑 AI Provider Configuration


QTPi supports configurable AI providers.

Users can select their preferred AI provider and API key directly from the CLI.


Configure QTPi:

```bash
qtpi config
```


The configuration wizard allows:

- Selecting AI provider
- Adding API keys
- Selecting default models
- Saving provider configuration


Example:

```
$ qtpi config


? Select Provider

❯ OpenRouter


? Enter API Key

****************


? Select Model

openrouter/free


✓ Configuration saved
```


After configuration, QTPi automatically loads the selected provider.

Run:

```bash
qtpi wakeup
```


---

# Supported AI Providers


| Provider | Status |
|----------|--------|
| OpenRouter | ✅ Supported |
| OpenAI | ⚙️ Configurable |
| Other AI SDK providers | 🚧 Extensible |


---

# 🧠 Provider Architecture


```
                 qtpi config

                      |
                      ↓

             Provider Manager

                      |
                      ↓

               AI Config Layer

                      |
                      ↓

        --------------------------------

        |              |               |

        ↓              ↓               ↓

   OpenRouter      OpenAI        Other Providers


                      |

                      ↓

                     LLM
```


---

# 🔍 Retrieval Augmented Generation (RAG)


QTPi includes a repository-aware RAG pipeline.

Before answering repository questions, QTPi can retrieve relevant code context using semantic search.


## RAG Pipeline


```
Repository Files

        |

        ↓

Code Scanner

        |

        ↓

Code Chunking

        |

        ↓

Embedding Generation

        |

        ↓

LanceDB Vector Storage

        |

        ↓

Semantic Retrieval

        |

        ↓

Agent Context

```


Example:


```
User:

How does authentication work?


QTPi:

1. Searches repository vectors

2. Retrieves related files

3. Reads implementation

4. Generates explanation
```


---

# 🏗️ Architecture


```
                         User

                          |

                          ↓


                       QTPi CLI


                          |

        --------------------------------

        |                              |

        ↓                              ↓


    Agent Mode                   Ask / Plan Mode


        |

        ↓


 Agent Orchestrator


        |

        ↓


    Tool System


        |

 --------------------------------------

 |                 |                    |

 ↓                 ↓                    ↓


RAG            Filesystem             Shell


 |                 |                    |


 ↓                 ↓                    ↓


LanceDB        Staging System       Commands



                 |

                 ↓


          AI Provider Manager


                 |

                 ↓


                 LLM

```


---

# 🚀 Installation


Install QTPi globally:


```bash
npm install -g qtpi
```


Verify installation:


```bash
qtpi --version
```


---

# ⚙️ Manual Configuration


You can also configure using `.env`:


```env
OPENROUTER_KEY=your_api_key
```


Optional web tools configuration (see [`docs/WEB_TOOLS.md`](docs/WEB_TOOLS.md)):

```env
# Web search (DuckDuckGo works with no key; others are paid)
QTPI_SEARCH_PROVIDER=duckduckgo
QTPI_SEARCH_API_KEY=your_search_api_key

# Web crawler
QTPI_CRAWLER_MAX_PAGES=5
QTPI_CRAWLER_RESPECT_ROBOTS=true
```


Optional Telegram configuration:


```env
TELEGRAM_BOT_TOKEN=your_bot_token

TELEGRAM_ADMIN_ID=your_user_id
```


---

# ▶️ Running QTPi


Start QTPi:


```bash
qtpi wakeup
```


or:


```bash
node app.js wakeup
```


---

# 🖥️ CLI Modes


## Agent Mode


Agent mode can analyze and modify your project.


Example:

```
Refactor authentication module
```


Workflow:


```
User Request

      ↓

Agent Analysis

      ↓

RAG Retrieval

      ↓

Tool Execution

      ↓

Stage Changes

      ↓

User Approval

      ↓

Apply Changes

```


---

## Plan Mode


Creates implementation strategies without changing files.


Example:

```
Create caching system for API requests
```


Output:

- Required files
- Implementation steps
- Architecture decisions
- Development strategy


---

## Ask Mode


Repository-aware question answering.


Example:


```
How does approval flow work?
```


Process:


```
Question

 ↓

RAG Search

 ↓

Relevant Code Chunks

 ↓

LLM Reasoning

 ↓

Answer

```


---

# 📚 Repository Indexing


Before using RAG, index your repository:


```bash
qtpi ingest
```


The ingestion process:


```
Scan Repository

        ↓

Generate Chunks

        ↓

Create Embeddings

        ↓

Store in LanceDB

        ↓

Enable Semantic Search

```


Example:


```
Found 17 files

Generated 71 chunks

Generating embeddings...

Saved vectors to LanceDB
```


---

# 🔐 Approval Based Modification System


QTPi never directly modifies your files.


All modifications follow a controlled workflow:


```
Agent proposes change

          ↓

ActionTracker stores mutation

          ↓

User reviews changes

          ↓

Approval granted

          ↓

Changes applied

```


Supported actions:


- Create files
- Modify files
- Delete files
- Create folders
- Execute commands


---

# 🛠️ Agent Tools


| Tool | Purpose |
|-|-|
| read_file | Read source files |
| search_files | Search files |
| search_codebase | RAG semantic search |
| analyze_codebase | Repository analysis |
| create_file | Stage file creation |
| modify_file | Stage modifications |
| delete_file | Stage deletion |
| execute_shell | Run commands |
| list_skills | Skill discovery |
| web_search | Search the public web (title/url/snippet) |
| web_crawl | Fetch a page and extract readable content |

> 📖 Full parameter, return-shape, config, and cost/rate-limit reference:
> [`docs/WEB_TOOLS.md`](docs/WEB_TOOLS.md).
> Run the end-to-end demo with
> `node examples/web-tools-example.mjs "node.js fetch retry backoff"`.


---

# 📂 Project Structure


```
QTPi

├── app.js

├── ai/
│   ├── ai.config.js
│   └── providerManager.js


├── rag/
│   ├── indexer.js
│   ├── retriever.js
│   └── embeddings.js


├── modes/

│   ├── cli.js
│   ├── telegram.js

│   └── agents/

│       ├── orchestrator.js
│       ├── tool_executor.js
│       ├── actionTracker.js
│       └── approval.js


├── providers/

└── tui/

```


---

# 🧰 Tech Stack


## Backend

- Node.js
- JavaScript
- Commander.js


## AI

- AI SDK
- OpenRouter
- Tool Calling
- Agent Architecture


## RAG

- Embeddings
- LanceDB
- Vector Search
- Semantic Retrieval


## Interfaces

- CLI
- Telegram Bot API


---

# 🗺️ Roadmap


Future improvements:


- [ ] More AI providers
- [ ] Better code chunking
- [ ] Multi-language support
- [ ] Persistent memory
- [ ] Git integration
- [ ] Automated testing agent
- [ ] Plugin system
- [ ] Web dashboard
- [ ] Local LLM support


---

# 🤝 Contributing


Contributions are welcome.


Clone:


```bash
git clone https://github.com/username/qtpi.git

cd qtpi

npm install
```


Create branch:


```bash
git checkout -b feature-name
```


Submit pull request.


---

# 👨‍💻 Author


**Saurabh Thakur**


QTPi explores the future of AI-assisted software development by combining autonomous agents, retrieval systems, and developer-controlled workflows.


---

# 📄 License


MIT License
