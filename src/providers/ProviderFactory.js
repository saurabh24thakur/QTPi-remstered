import { createOpenAICompatible } from './openaiCompatible.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createOllamaProvider } from './ollama.js';
import { getConfig } from '../config/configManager.js';

export function createProvider(config = { get: getConfig }, extensions = new Map()) {
  const read = (key) => config && typeof config.get === 'function' ? config.get(key) : config?.[key] ?? getConfig(key);
  const providerName = read('provider');
  const apiKey = read('apiKey');
  const model = read('model');

  if (!providerName) {
    throw new Error('No provider configured. Run `qtpi config` first.');
  }

  if (extensions.has(providerName)) {
    return extensions.get(providerName)({ config, providerName, apiKey, model });
  }

  switch (providerName) {
    case 'openai':
    case 'openrouter':
    case 'groq':
      return createOpenAICompatible(providerName, apiKey, model);
    case 'anthropic':
      return createAnthropicProvider(apiKey, model);
    case 'gemini':
      return createGeminiProvider(apiKey, model);
    case 'ollama':
      return createOllamaProvider(model);
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}
