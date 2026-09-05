
import Anthropic from '@anthropic-ai/sdk';


export function createAnthropicProvider(apiKey, model) {

  const client = new Anthropic({ apiKey });


  
  async function chat(messages, tools = [], onStream = null) {

    const systemMsg = messages.find(m => m.role === 'system');
    const systemText = systemMsg ? systemMsg.content : '';

    // Convert remaining messages to Anthropic format 
    const anthropicMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => convertToAnthropicFormat(m));

    // Build the request 
    const request = {
      model: model,
      max_tokens: 8096,
      system: systemText,
      messages: anthropicMessages,
    };

    // Add tools (Anthropic format) 
    if (tools.length > 0) {
      request.tools = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters, 
      }));
    }

  
    if (onStream) {
      return await handleStreaming(client, request, onStream);
    }

    const response = await client.messages.create(request);

    // Parse the response 
    return parseAnthropicResponse(response);
  }
  // embed() — Anthropic doesn't have an embeddings API
  
  async function embed() {
    throw new Error(
      'Anthropic does not have an embeddings API. ' +
      'Use OpenAI for RAG indexing or use keyword-based search.'
    );
  }


  return { name: 'anthropic', model, chat, embed };
}


function convertToAnthropicFormat(msg) {

  // Case 1: Tool result
  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content,
      }],
    };
  }

  // Case 2: Assistant message that includes tool calls
  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    const contentBlocks = [];

    // Add text block if there's any text
    if (msg.content) {
      contentBlocks.push({ type: 'text', text: msg.content });
    }

    // Add a tool_use block for each tool call
    for (const tc of msg.toolCalls) {
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.arguments, // Anthropic calls it "input", and it's already an object
      });
    }

    return { role: 'assistant', content: contentBlocks };
  }

  // Case 3: Normal text message — no conversion needed
  return { role: msg.role, content: msg.content };
}



function parseAnthropicResponse(response) {
  let content = '';
  let toolCalls = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      content += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input, // Already an object, no JSON.parse needed!
      });
    }
  }

  return {
    content,
    toolCalls,
    finishReason: response.stop_reason,
  };
}



async function handleStreaming(client, request, onStream) {
  const stream = await client.messages.stream(request);

  let content = '';
  let toolCalls = [];
  let currentToolBlock = null;
  let currentToolInput = '';

  for await (const event of stream) {

    // Text chunk arrived
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      content += event.delta.text;
      onStream(event.delta.text);
    }

    // Tool input chunk arrived (comes in pieces like OpenAI)
    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      currentToolInput += event.delta.partial_json;
    }

    // New tool_use block started
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      currentToolBlock = event.content_block;
      currentToolInput = '';
    }

    // Block finished — save the complete tool call
    if (event.type === 'content_block_stop' && currentToolBlock) {
      toolCalls.push({
        id: currentToolBlock.id,
        name: currentToolBlock.name,
        arguments: currentToolInput ? JSON.parse(currentToolInput) : {},
      });
      currentToolBlock = null;
      currentToolInput = '';
    }
  }

  return { content, toolCalls, finishReason: 'stop' };
}