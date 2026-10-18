import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';

const GLOBAL_DIR = path.join(os.homedir(), '.qtpi');
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_DIR, 'config.json');

// process.cwd() = the folder where the user ran the command
const PROJECT_DIR = path.join(process.cwd(), '.qtpi');
const PROJECT_CONFIG_PATH = path.join(PROJECT_DIR, 'config.json');

// ─────────────────────────────────────────────────────────────
// DEFAULTS
// Fallback values used when a key is not set in either the
// project or global config. Keeps tools working out-of-the-box
// (e.g. web_search falls back to keyless DuckDuckGo).
// ─────────────────────────────────────────────────────────────
const DEFAULTS = {
  // Web search
  searchProvider: 'duckduckgo',   // 'duckduckgo' | 'brave' | 'tavily' | 'serpapi'
  searchApiKey: '',               // required only for paid providers
  searchTimeout: 15000,           // milliseconds per search request

  // Web crawler
  crawlerUserAgent: 'QTPi/1.0 (+https://qtpi.dev)',
  crawlerTimeout: 15000,          // milliseconds
  crawlerMaxPages: 5,             // hard ceiling across a single crawl
  crawlerRespectRobots: true,     // honor robots.txt
  crawlerMaxDepth: 1,             // how many link-hops from the start URL
  crawlerSameDomainOnly: true,    // keep the crawl on the starting host
  crawlerPerDomainDelay: 1000,    // ms to wait between hits to the same host
  crawlerConcurrency: 3,          // max in-flight page fetches
  crawlerMaxResponseSize: 2000000,// bytes; guard against huge responses
  crawlerMaxRedirects: 5,         // redirect chain limit per request

  // Web safety / caching / limits (Step 7)
  webSsrfProtection: true,        // block private/loopback/link-local targets
  webAllowPrivateHosts: false,    // escape hatch: allow internal hosts (testing)
  webMaxResponseBytes: 2000000,   // hard byte cap per fetched page
  webMaxPages: 10,                // hard ceiling on pages per crawl
  webMaxDepth: 5,                 // hard ceiling on crawl depth
  webTotalTimeoutMs: 60000,       // wall-clock budget for a whole crawl
  webCacheEnabled: false,         // cache search/crawl results
  webCacheTtlMs: 0,               // entry lifetime (0 = disabled)
  webCachePersist: false,         // also persist cache to disk
  webCacheMaxEntries: 500,        // in-memory entry cap
  webLogEnabled: false,           // log each fetch/search
  webLogToFile: true,             // append JSONL to webLogFile
  webLogToConsole: false,         // echo one-line summaries to stderr
  webLogFile: '',                 // '' -> ~/.qtpi/web.log
};

let globalConfig = null;
let projectConfig = null;
let envConfig = null;

// ─────────────────────────────────────────────────────────────
// ENV_MAP
// Maps config keys to environment variables. Env vars take the
// highest priority so CI / one-off runs can override config
// without editing any file. Example:
//   QTPI_SEARCH_PROVIDER=brave QTPI_SEARCH_API_KEY=xxx qtpi wakeup
// ─────────────────────────────────────────────────────────────
const ENV_MAP = {
  searchProvider: 'QTPI_SEARCH_PROVIDER',
  searchApiKey: 'QTPI_SEARCH_API_KEY',
  searchTimeout: 'QTPI_SEARCH_TIMEOUT',
  crawlerUserAgent: 'QTPI_CRAWLER_USER_AGENT',
  crawlerTimeout: 'QTPI_CRAWLER_TIMEOUT',
  crawlerMaxPages: 'QTPI_CRAWLER_MAX_PAGES',
  crawlerRespectRobots: 'QTPI_CRAWLER_RESPECT_ROBOTS',
  crawlerMaxDepth: 'QTPI_CRAWLER_MAX_DEPTH',
  crawlerSameDomainOnly: 'QTPI_CRAWLER_SAME_DOMAIN_ONLY',
  crawlerPerDomainDelay: 'QTPI_CRAWLER_PER_DOMAIN_DELAY',
  crawlerConcurrency: 'QTPI_CRAWLER_CONCURRENCY',
  crawlerMaxResponseSize: 'QTPI_CRAWLER_MAX_RESPONSE_SIZE',
  crawlerMaxRedirects: 'QTPI_CRAWLER_MAX_REDIRECTS',
  webSsrfProtection: 'QTPI_WEB_SSRF_PROTECTION',
  webAllowPrivateHosts: 'QTPI_WEB_ALLOW_PRIVATE_HOSTS',
  webMaxResponseBytes: 'QTPI_WEB_MAX_RESPONSE_BYTES',
  webMaxPages: 'QTPI_WEB_MAX_PAGES',
  webMaxDepth: 'QTPI_WEB_MAX_DEPTH',
  webTotalTimeoutMs: 'QTPI_WEB_TOTAL_TIMEOUT_MS',
  webCacheEnabled: 'QTPI_WEB_CACHE_ENABLED',
  webCacheTtlMs: 'QTPI_WEB_CACHE_TTL_MS',
  webCachePersist: 'QTPI_WEB_CACHE_PERSIST',
  webCacheMaxEntries: 'QTPI_WEB_CACHE_MAX_ENTRIES',
  webLogEnabled: 'QTPI_WEB_LOG_ENABLED',
  webLogToFile: 'QTPI_WEB_LOG_TO_FILE',
  webLogToConsole: 'QTPI_WEB_LOG_TO_CONSOLE',
  webLogFile: 'QTPI_WEB_LOG_FILE',
};

function makeSureFolderExists(folderPath) {
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
}


function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const rawText = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(rawText);
    }
  } catch (error) {
    // File exists but is corrupted — start fresh
    console.log(chalk.yellow(`  ⚠ Could not read ${filePath}, starting fresh`));
  }
  return {};
}

function writeJsonFile(filePath, data) {
  makeSureFolderExists(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function loadConfigs() {
  makeSureFolderExists(GLOBAL_DIR);
  globalConfig = readJsonFile(GLOBAL_CONFIG_PATH);
  projectConfig = readJsonFile(PROJECT_CONFIG_PATH);

  // Collect any config values supplied via environment variables
  envConfig = {};
  for (const [key, envName] of Object.entries(ENV_MAP)) {
    const raw = process.env[envName];
    if (raw !== undefined && raw !== '') envConfig[key] = raw;
  }
}

// load key
export function getConfig(key) {
  // Load configs on first use
  if (globalConfig === null) loadConfigs();

  // ?? means: use left side unless it's null/undefined, then use right side
  // Priority: env var → project config → global config → built-in default
  return envConfig[key] ?? projectConfig[key] ?? globalConfig[key] ?? DEFAULTS[key];
}

// ─────────────────────────────────────────────────────────────
// getConfigNumber(key)
// Same as getConfig but coerces the value to a number and
// falls back to the default if the value is missing or invalid.
// Used for things like crawlerTimeout / crawlerMaxPages.
// ─────────────────────────────────────────────────────────────
export function getConfigNumber(key) {
  const value = Number(getConfig(key));
  return Number.isFinite(value) ? value : DEFAULTS[key];
}

// ─────────────────────────────────────────────────────────────
// getConfigBool(key)
// Coerces string/bool config values ("true", "false", true, 1)
// into a real boolean. Used for crawlerRespectRobots.
// ─────────────────────────────────────────────────────────────
export function getConfigBool(key) {
  const value = getConfig(key);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return Boolean(value ?? DEFAULTS[key]);
}


// setting the key for project
export function setProjectConfig(key, value) {
  if (projectConfig === null) loadConfigs();

  projectConfig[key] = value;
  writeJsonFile(PROJECT_CONFIG_PATH, projectConfig);
}

// setting the key globally
export function setConfig(key, value) {
  if (globalConfig === null) loadConfigs();

  globalConfig[key] = value;
  writeJsonFile(GLOBAL_CONFIG_PATH, globalConfig);
}


export function getAllConfig() {
  if (globalConfig === null) loadConfigs();

  // Spread syntax: project values override global values
  return { ...globalConfig, ...projectConfig };
}

export function isConfigured() {
  const provider = getConfig('provider');
  const apiKey = getConfig('apiKey');

  
  if (provider === 'ollama') return true;

  
  return !!(provider && apiKey);
}


export function showConfig() {
  const config = getAllConfig();

  console.log(chalk.magenta('\n  🧁 QTPI Configuration:\n'));

  // If nothing is configured yet, tell the user
  if (Object.keys(config).length === 0) {
    console.log(chalk.gray('  No configuration found.'));
    console.log(chalk.gray('  Run: qtpi config\n'));
    return;
  }

  // Show each key-value pair
  for (const [key, value] of Object.entries(config)) {
    let displayValue = value;

    // Hide most of the secret keys
    // Show only first 8 chars and last 4 chars
    const SECRET_KEYS = ['apiKey', 'searchApiKey', 'qdrantKey'];
    if (SECRET_KEYS.includes(key) && typeof value === 'string' && value.length > 12) {
      displayValue = value.slice(0, 8) + '...' + value.slice(-4);
    }

    console.log(chalk.white(`  ${key}: `) + chalk.cyan(displayValue));
  }

  console.log('');
}


// ─────────────────────────────────────────────────────────────
// interactiveSetup()
// Walk the user through setup with nice prompts
// Called when they run `qtpi config` with no arguments
// ─────────────────────────────────────────────────────────────
export async function interactiveSetup() {
  console.log(chalk.magenta('\n  🧁 Let\'s set up QTPI!\n'));

  // inquirer.prompt asks a series of questions and returns answers
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Choose your AI provider:',
      choices: [
  { name: 'OpenAI (GPT-4o, GPT-4)', value: 'openai' },
        { name: 'OpenRouter (100+ models, one key)', value: 'openrouter' },
        { name: 'Groq (Ultra-fast inference)', value: 'groq' },
        { name: 'Anthropic (Claude Sonnet, Opus)', value: 'anthropic' },
        { name: 'Google Gemini (gemini-3.6-flash)', value: 'gemini' },
        { name: 'Ollama (Local, Free, Private)', value: 'ollama' },
      ],
    },
    {
      type: 'password',
      name: 'apiKey',
      message: 'Enter your API key:',
      // Only ask for API key if they picked a cloud provider
      when: (previousAnswers) => previousAnswers.provider !== 'ollama',
      validate: (input) => {
        if (input.length > 10) return true;
        return 'That doesn\'t look like a valid API key';
      },
    },
    
{
  type: 'input',
  name: 'qdrantUrl',
  message: 'Qdrant URL (for RAG search):',
  default: 'http://localhost:6333',
},
{
  type: 'password',
  name: 'qdrantKey',
  message: 'Qdrant API key (leave empty for local Docker):',
  when: (answers) => !answers.qdrantUrl.includes('localhost'),
},
    // ── Web tools (optional) ──
    {
      type: 'list',
      name: 'searchProvider',
      message: 'Web search provider (for the web_search tool):',
      default: 'duckduckgo',
      choices: [
        { name: 'DuckDuckGo (free, no API key)', value: 'duckduckgo' },
        { name: 'Brave Search (API key required)', value: 'brave' },
        { name: 'Tavily (API key required)', value: 'tavily' },
        { name: 'SerpAPI (API key required)', value: 'serpapi' },
      ],
    },
    {
      type: 'password',
      name: 'searchApiKey',
      message: 'Search API key (leave empty for DuckDuckGo):',
      when: (previousAnswers) => previousAnswers.searchProvider !== 'duckduckgo',
    },
    {
      type: 'input',
      name: 'crawlerUserAgent',
      message: 'Crawler User-Agent:',
      default: 'QTPi/1.0 (+https://qtpi.dev)',
    },
    {
      type: 'number',
      name: 'crawlerTimeout',
      message: 'Crawler timeout (ms):',
      default: 15000,
    },
    {
      type: 'confirm',
      name: 'crawlerRespectRobots',
      message: 'Respect robots.txt when crawling?',
      default: true,
    },
    {
      type: 'input',
      name: 'model',
      message: 'Which model do you want to use?',
      default: (previousAnswers) => {
        // Suggest a sensible default based on their provider choice
        const smartDefaults = {
          openai: 'gpt-4o',
          anthropic: 'claude-sonnet-4-20250514',
          ollama: 'llama3',
          openrouter: 'google/gemini-1.5-pro',
          gemini: 'gemini-3.6-flash',
          groq: 'llama3-70b-8192',
        };
        return smartDefaults[previousAnswers.provider];
      },
    },
  ]);

  // Save each answer to global config
  for (const [key, value] of Object.entries(answers)) {
    // Keep `false`/`0` values (e.g. crawlerRespectRobots: false),
    // only skip empty strings / undefined / null.
    if (value === undefined || value === null || value === '') continue;
    setConfig(key, value);
  }

  console.log(chalk.green('\n  ✓ QTPI is configured and ready!'));
  console.log(chalk.gray('  Run: qtpi wakeup\n'));
}