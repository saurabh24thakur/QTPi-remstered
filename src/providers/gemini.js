
import { GoogleGenerativeAI } from '@google/generative-ai';


export function createGeminiProvider(apiKey, model) {

  const genAI = new GoogleGenerativeAI(apiKey);


  async function chat(messages, tools = [], onStream = null) {

    const systemMsg = messages.find(m => m.role === 'system');
    const systemText = systemMsg ? systemMsg.content : '';

    
    const geminiHistory = messages
      .filter(m => m.role !== 'system')
      .map(m => convertToGeminiFormat(m));


    const modelConfig = {
      model: model,
      systemInstruction: systemText || undefined,
    };

    if (tools.length > 0) {
      modelConfig.tools = [{
        functionDeclarations: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: cleanParametersForGemini(tool.parameters),
        })),
      }];
    }

    const geminiModel = genAI.getGenerativeModel(modelConfig);

    if (onStream) {
      return await handleStreaming(geminiModel, geminiHistory, onStream);
    }

    const result = await geminiModel.generateContent({ contents: geminiHistory });
    const response = result.response;

    return parseGeminiResponse(response);
  }



  async function embed(texts) {
    const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const embeddings = [];

    for (const text of texts) {
      const result = await embeddingModel.embedContent(text);
      embeddings.push(result.embedding.values);
    }

    return embeddings;
  }


  return { name: 'gemini', model, chat, embed };
}



function convertToGeminiFormat(msg) {
  // Case 1: Tool result
  if (msg.role === 'tool') {
    return {
      role: 'user', 
      parts: [{
        functionResponse: {
          name: msg.tool_call_id, 
          response: { result: msg.content },
        },
      }],
    };
  }

  //  Assistant message with tool calls
  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    const parts = [];

    if (msg.content) {
      parts.push({ text: msg.content });
    }

    for (const tc of msg.toolCalls) {
      parts.push({
        functionCall: {
          name: tc.name,
          args: tc.arguments,
        },
      });
    }

    return { role: 'model', parts }; // "model" not "assistant"!
  }

  //  Normal text message
  return {
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  };
}




function parseGeminiResponse(response) {
  let content = '';
  let toolCalls = [];

  // Get the parts from the first candidate
  const parts = response.candidates?.[0]?.content?.parts || [];

  for (const part of parts) {
    if (part.text) {
      content += part.text;
    }

    if (part.functionCall) {
      toolCalls.push({
        id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args || {},
      });
    }
  }

  const finishReason = response.candidates?.[0]?.finishReason || 'STOP';

  return { content, toolCalls, finishReason };
}



function cleanParametersForGemini(parameters) {
  if (!parameters) return undefined;

  // Gemini doesn't like "additionalProperties" in schemas
  const cleaned = JSON.parse(JSON.stringify(parameters));
  removeKey(cleaned, 'additionalProperties');

  return cleaned;
}

// Helper: recursively remove a key from an object
function removeKey(obj, keyToRemove) {
  if (typeof obj !== 'object' || obj === null) return;
  delete obj[keyToRemove];
  for (const value of Object.values(obj)) {
    removeKey(value, keyToRemove);
  }
}



async function handleStreaming(geminiModel, history, onStream) {
  const result = await geminiModel.generateContentStream({ contents: history });

  let content = '';
  let toolCalls = [];

  for await (const chunk of result.stream) {
    const parts = chunk.candidates?.[0]?.content?.parts || [];

    for (const part of parts) {
      if (part.text) {
        content += part.text;
        onStream(part.text);
      }

      if (part.functionCall) {
        toolCalls.push({
          id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args || {},
        });
      }
    }
  }

  return { content, toolCalls, finishReason: 'stop' };
}