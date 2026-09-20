
import { createConversation } from '../memory/ConversationHistory.js';
import { createActionTracker } from './ActionTracker.js';
import { executeTool } from '../tools/ToolRegistry.js';
import { needsApproval, askUserApproval } from '../tools/ApprovalGate.js';


export function createAgent({ provider, tools, memory, renderer, config, workingDir }) {


  const conversation = createConversation(50);

  // Action tracker (logs to .qtpi/actions.log)
  const tracker = createActionTracker(workingDir);

  // Safety limit to prevent infinite tool loops
  const maxIterations = 25;

  // Initialize the AI's identity
  initializeSystemPrompt();


 
  function initializeSystemPrompt() {
    const pastMemories = memory ? memory.recall() : '';

    const systemPrompt = `You are QTPI (pronounced "cutie pie"), an expert AI coding agent that lives in the user's terminal. You write clean, precise, and production-ready code.

## Your Capabilities
You can read/write files, edit code, run shell commands, perform git actions, search code, and query repository embeddings.

## Working Rules
1. **READ BEFORE EDITING**: Always read files before making changes to understand existing code.
2. **TARGETED EDITS**: Use edit_file for small changes instead of rewriting entire files.
3. **VERIFY YOUR WORK**: Run tests or checks after making changes when appropriate.
4. **SAVE LEARNINGS**: Use save_memory when you learn key project facts or architecture decisions.

## Project Context
- Working Directory: ${workingDir}

${pastMemories ? `## Long-Term Memory (Past Sessions)\n${pastMemories}` : '## Memory: First session on this project.'}`;

    conversation.addSystemMessage(systemPrompt);
  }


  
  
  // THE AGENTIC LOOP

  async function run(userMessage) {

    // Record user input in short-term memory
    conversation.addUserMessage(userMessage);

    let iterations = 0;

    // Loop until AI gives a text-only response or hits safety limit
    while (iterations < maxIterations) {
      iterations++;

      // Show spinner while waiting for AI
      renderer.startThinking();

      let aiResponse;
      try {
        aiResponse = await provider.chat(
          conversation.getMessages(),
          tools ? tools.getDefinitions() : [],
          (token) => renderer.streamToken(token) //streming response
        );
      } catch (error) {
        renderer.stopThinking();
        tracker.track('error', { message: error.message });
        throw error;
      }

      renderer.stopThinking();

      // AI wants to use tools
      if (aiResponse.toolCalls && aiResponse.toolCalls.length > 0) {

        // Render assistant text if it accompanied the tool calls
        if (aiResponse.content) {
          renderer.renderAssistant(aiResponse.content);
        }

        // Add assistant message with tool calls to conversation
        conversation.addAssistantMessage(
          aiResponse.content || '',
          aiResponse.toolCalls
        );

        // Execute each requested tool call
        for (const toolCall of aiResponse.toolCalls) {

          // Render tool execution notice
          renderer.renderToolCall(toolCall.name, toolCall.arguments);

          // Track tool execution attempt
          tracker.track('tool_call', {
            tool: toolCall.name,
            args: toolCall.arguments,
          });

          let toolResult = '';

          // ═══ APPROVAL GATE CHECK ═══
          if (needsApproval(toolCall.name)) {
            const approval = await askUserApproval(
              toolCall.name,
              toolCall.arguments,
              workingDir
            );

            if (approval === 'rejected') {
              toolResult = '❌ Action rejected by user. Do not try this action again. Find another approach or ask the user.';
            } else {
              // Approved → execute tool
              toolResult = await executeTool(tools, toolCall.name, toolCall.arguments);
            }
          } else {
            // Safe tool → execute immediately
            toolResult = await executeTool(tools, toolCall.name, toolCall.arguments);
          }

          // Render tool completion
          renderer.renderToolResult(toolCall.name, toolResult);

          // Track tool result
          tracker.track('tool_result', {
            tool: toolCall.name,
            result: toolResult.slice(0, 200),
          });

          // Feed tool result back into conversation
          conversation.addToolResult(toolCall.id, toolResult);
        }

        // Continue loop: AI processes tool results
        continue;
      }

      // ── CASE 2: AI gave a final answer (no tools) ──
      if (aiResponse.content) {
        conversation.addAssistantMessage(aiResponse.content);
        renderer.renderAssistant(aiResponse.content);
      }

      // Done with loop!
      break;
    }

    if (iterations >= maxIterations) {
      renderer.renderWarning(
        `Reached max iterations (${maxIterations}). Loop stopped for safety.`
      );
    }
  }


  
  function getActionSummary() {
    return tracker.getSummary();
  }


 
  async function endSession() {
    const sessionActions = tracker.getActions();

    if (sessionActions.length > 0 && memory) {
      const toolNames = sessionActions
        .filter(a => a.type === 'tool_call')
        .map(a => a.details.tool);

      const uniqueTools = [...new Set(toolNames)];
      const summary = `Session: ${sessionActions.length} actions taken. Tools used: ${uniqueTools.join(', ') || 'none'}`;

      memory.saveSessionSummary(summary);
    }
  }


  return {
    run,
    conversation,
    tracker,
    getActionSummary,
    endSession,
    provider,
    tools,
    memory,
    renderer,
    config,
    workingDir,
  };
}