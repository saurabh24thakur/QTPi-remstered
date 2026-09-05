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

let globalConfig = null;
let projectConfig = null;

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
}

// load key
export function getConfig(key) {
  // Load configs on first use
  if (globalConfig === null) loadConfigs();

  // ?? means: use left side unless it's null/undefined, then use right side
  return projectConfig[key] ?? globalConfig[key];
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

    // Hide most of the API key
    // Show only first 8 chars and last 4 chars
    if (key === 'apiKey' && typeof value === 'string' && value.length > 12) {
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
        { name: 'Google Gemini (gemini-2.0-flash)', value: 'gemini' },
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
      name: 'model',
      message: 'Which model do you want to use?',
      default: (previousAnswers) => {
        // Suggest a sensible default based on their provider choice
        const smartDefaults = {
          openai: 'gpt-4o',
          anthropic: 'claude-sonnet-4-20250514',
          ollama: 'llama3',
          openrouter: 'google/gemini-1.5-pro',
          gemini: 'gemini-1.5-pro',
          groq: 'llama3-70b-8192',
        };
        return smartDefaults[previousAnswers.provider];
      },
    },
  ]);

  // Save each answer to global config
  for (const [key, value] of Object.entries(answers)) {
    if (value) setConfig(key, value);
  }

  console.log(chalk.green('\n  ✓ QTPI is configured and ready!'));
  console.log(chalk.gray('  Run: qtpi wakeup\n'));
}