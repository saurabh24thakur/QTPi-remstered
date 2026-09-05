
export function createOllamaProvider(model) {

  const baseUrl = 'http://localhost:11434';


  async function chat(messages, tools = [], onStream = null) {

    const request = {
      model: model,
      messages: messages,
      stream: false,
    };

  
    if (tools.length > 0) {
      request.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    // ── Make the HTTP request ──
    let response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch (error) {
      // This error means Ollama isn't running at all
      throw new Error(
        'Could not connect to Ollama.\n' +
        'Make sure Ollama is installed and running:\n' +
        '  Install: https://ollama.ai\n' +
        '  Start: ollama serve'
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // ── Normalize the response ──
    // Ollama's format is similar to OpenAI but slightly different
    return {
      content: data.message?.content || '',
      toolCalls: normalizeOllamaToolCalls(data.message?.tool_calls),
      finishReason: 'stop',
    };
  }


  async function embed(texts) {
    const embeddings = [];

    for (const text of texts) {
      const response = await fetch(`${baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model, prompt: text }),
      });

      if (!response.ok) {
        throw new Error('Ollama embeddings failed. Make sure your model supports embeddings.');
      }

      const data = await response.json();
      embeddings.push(data.embedding);
    }

    return embeddings;
  }


  return { name: 'ollama', model, chat, embed };
}



function normalizeOllamaToolCalls(rawToolCalls) {
  if (!rawToolCalls || rawToolCalls.length === 0) return [];

  return rawToolCalls.map(tc => ({
    id: `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: tc.function.name,
    // Handle both string and object arguments
    arguments: typeof tc.function.arguments === 'string'
      ? JSON.parse(tc.function.arguments)
      : tc.function.arguments,
  }));
}