
export function createConversation(maxMessages = 50) {
  let messages = [];


  function addSystemMessage(content) {

    const existingIndex = messages.findIndex(m => m.role === 'system');

    if (existingIndex >= 0) {
      // Replace the old one
      messages[existingIndex].content = content;
    } else {
      // Add new one at the very beginning
      messages.unshift({ role: 'system', content });
    }
  }


  
  function addUserMessage(content) {
    messages.push({ role: 'user', content });
    trimOldMessages();
  }


  
  function addAssistantMessage(content, toolCalls = []) {
    const message = { role: 'assistant', content };

    // If AI wants to use tools, include that info
    if (toolCalls.length > 0) {
      message.toolCalls = toolCalls;

      // OpenAI format needs this specific structure
      message.tool_calls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));
    }

    messages.push(message);
    trimOldMessages();
  }



  function addToolResult(toolCallId, content) {
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: content,
    });
  }



  function getMessages() {
    return messages;
  }



  function clear() {
    const systemMsg = messages.find(m => m.role === 'system');
    messages = systemMsg ? [systemMsg] : [];
  }


 
  function trimOldMessages() {
    if (messages.length <= maxMessages) return;

    // Always keep the system message
    const systemMsg = messages.find(m => m.role === 'system');

    // Keep only the most recent messages
    const recent = messages
      .filter(m => m.role !== 'system')
      .slice(-maxMessages);

    messages = systemMsg ? [systemMsg, ...recent] : recent;
  }


  // Return all the functions
  return {
    addSystemMessage,
    addUserMessage,
    addAssistantMessage,
    addToolResult,
    getMessages,
    clear,
  };
}