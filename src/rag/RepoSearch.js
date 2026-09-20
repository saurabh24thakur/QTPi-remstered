// ================================================================
// FILE: src/rag/RepoSearch.js
// PURPOSE: Register the search_repository tool that uses Qdrant
//
// FLOW:
//   1. AI calls search_repository with a text query
//   2. We generate an embedding for the query
//   3. We search Qdrant for similar vectors
//   4. Return the matching chunks
// ================================================================

import { registerTool } from '../tools/ToolRegistry.js';
import { createVectorStore } from './VectorStore.js';



export function registerRepoSearchTool(registry, config, provider) {

  const store = createVectorStore(config);

  registerTool(registry, 'search_repository', {
    description: 'Semantically search the entire repository using vector embeddings. Finds code by meaning, not just keywords. Great for finding "authentication logic" even when the code uses different words. Repository must be indexed first with `qtpi index`.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for (natural language or code pattern)',
        },
        topK: {
          type: 'number',
          description: 'How many results to return (default: 5)',
        },
      },
      required: ['query'],
    },
  }, async ({ query, topK = 5 }) => {

    // Check if repository is indexed
    const indexed = await store.isIndexed();
    if (!indexed) {
      return (
        '⚠️ Repository is not indexed yet.\n' +
        'Run `qtpi index` in the terminal to enable semantic search.\n' +
        'You can still use `search_code` for basic text search.'
      );
    }

    // Check provider supports embeddings
    if (typeof provider.embed !== 'function') {
      return `⚠️ Current provider (${provider.name}) does not support embeddings. Use OpenAI, Gemini, or Ollama for semantic search.`;
    }

    try {
      // Generate embedding for the query
      const [queryEmbedding] = await provider.embed([query]);

      // Search Qdrant
      const results = await store.search(queryEmbedding, topK);

      if (results.length === 0) {
        return `🔍 No relevant code found for: "${query}"`;
      }

      // Format results
      const formatted = results.map((result, i) => {
        return [
          `━━━ Result ${i + 1} [Similarity: ${(result.score * 100).toFixed(1)}%] ━━━`,
          `📄 File: ${result.filePath} (lines ${result.startLine}-${result.endLine})`,
          ``,
          result.content,
          ``,
        ].join('\n');
      }).join('\n');

      return `🔍 Found ${results.length} relevant code sections for "${query}":\n\n${formatted}`;
    } catch (error) {
      return `❌ Search failed: ${error.message}`;
    }
  });
}