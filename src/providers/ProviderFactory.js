import { createOpenAICompatible } from './openaiCompatible.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createOllamaProvider } from './ollama.js';
import { getConfig } from '../config/configManager.js';

export function createProvider() {
  const providerName = getConfig('provider');
  const apiKey = getConfig('apiKey');
  const model = getConfig('model');

  if (!providerName) {
    throw new Error('No provider configured. Run `qtpi config` first.');
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