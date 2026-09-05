
import OpenAI from 'openai';


const BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
};


export function createOpenAICompatible(providerName, apiKey, model) {

  // Create the OpenAI client pointed at the right URL
  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: BASE_URLS[providerName],
    // OpenRouter likes to know which app is calling
    defaultHeaders: providerName === 'openrouter'
      ? { 'HTTP-Referer': 'https://qtpi.dev', 'X-Title': 'QTPI' }
      : {},
  });

  
  async function chat(messages, tools = [], onStream = null) {

    // Build the request body
    const request = {
      model: model,
      messages: messages,
      temperature: 0.1, // Low = focused, high = creative
    };

    // Add tools if we have any
    if (tools.length > 0) {
      request.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      request.tool_choice = 'auto'; // Let AI decide whether to use tools
    }

    // ── Streaming path ──
    if (onStream) {
      return await handleStreaming(client, request, onStream);
    }

    // ── Normal (non-streaming) path ──
    const response = await client.chat.completions.create(request);
    const message = response.choices[0].message;

    return {
      content: message.content || '',
      toolCalls: normalizeToolCalls(message.tool_calls),
      finishReason: response.choices[0].finish_reason,
    };
  }


 //vector embeddings

  async function embed(texts) {
    if (providerName !== 'openai') {
      throw new Error(
        `${providerName} doesn't support embeddings. ` +
        `Use OpenAI for RAG indexing or use keyword-based search.`
      );
    }

    const response = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });

    return response.data.map(item => item.embedding);
  }


  // Return the provider object
  return { name: providerName, model, chat, embed };
}


function normalizeToolCalls(rawToolCalls) {
  if (!rawToolCalls || rawToolCalls.length === 0) return [];

  return rawToolCalls.map(tc => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments), // String → Object
  }));
}



async function handleStreaming(client, request, onStream) {
  request.stream = true;

  const stream = await client.chat.completions.create(request);

  let content = '';
  let toolCallPieces = []; 

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;

    // ── Text content arrived ──
    if (delta?.content) {
      content += delta.content;
      onStream(delta.content); 
    }

    // ── Tool call piece arrived ──
    if (delta?.tool_calls) {
      for (const piece of delta.tool_calls) {
        const index = piece.index;

        // Initialize this tool call slot if it's new
        if (!toolCallPieces[index]) {
          toolCallPieces[index] = { id: '', name: '', arguments: '' };
        }

        // Glue the pieces together
        if (piece.id) toolCallPieces[index].id = piece.id;
        if (piece.function?.name) toolCallPieces[index].name = piece.function.name;
        if (piece.function?.arguments) toolCallPieces[index].arguments += piece.function.arguments;
      }
    }
  }

  // Parse the glued-together argument strings into objects
  const toolCalls = toolCallPieces
    .filter(tc => tc.name) // Remove empty slots
    .map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments ? JSON.parse(tc.arguments) : {},
    }));

  return { content, toolCalls, finishReason: 'stop' };
}