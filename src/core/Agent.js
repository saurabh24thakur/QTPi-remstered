
import { createConversation } from '../memory/ConversationHistory.js';
import { createActionTracker } from './ActionTracker.js';
import { createCapabilityRegistry, executeTool, getToolDefinitions } from '../tools/ToolRegistry.js';
import { needsApproval, askUserApproval } from '../tools/ApprovalGate.js';
import { formatSkillCatalog } from '../skills/skillContext.js';


export function createAgent({ provider, tools, memory, renderer, config, workingDir, skills, approvalHandler }) {
  let currentRenderer = renderer;

  // `approvalHandler` is swap-in-able: the gateway sets a per-channel
  // handler, the scheduler sets a per-job policy (auto-approve or reject).
  let currentApprovalHandler = approvalHandler;


  // `let` (not `const`) so the gateway can swap in a per-sender
  // conversation via setConversation() — one agent, many isolated chats.
  let conversation = createConversation(50);

  // Action tracker (logs to .qtpi/actions.log)
  const tracker = createActionTracker(workingDir);

  // Safety limit to prevent infinite tool loops
  const maxIterations = 25;

  initializeSystemPrompt();

  // Rebuild the system prompt and (re)install it into the current
  // conversation. Called on init and whenever the conversation is swapped.
  function initializeSystemPrompt() {
    conversation.addSystemMessage(buildSystemPrompt());
  }


 
  function buildSystemPrompt() {
    const pastMemories = memory ? memory.recall() : '';

    // Level-1 skill catalog (name + description only) — keeps the base
    // prompt small while telling the model which skills it can load.
    const skillCatalog = skills && skills.enabled ? formatSkillCatalog(skills) : '';

    return `You are QTPI (pronounced "cutie pie"), an expert AI coding agent that lives in the user's terminal. You write clean, precise, and production-ready code.

## Your Capabilities
You can read/write files, edit code, run shell commands, perform git actions, search code, and query repository embeddings.
You can also search the public web (web_search) and fetch/crawl web pages (web_crawl) when you need information that is not in the local repository — e.g. library docs, error messages, or current best practices. Prefer web_search to find a page, then web_crawl to read it.

## Working Rules
1. **READ BEFORE EDITING**: Always read files before making changes to understand existing code.
2. **TARGETED EDITS**: Use edit_file for small changes instead of rewriting entire files.
3. **VERIFY YOUR WORK**: Run tests or checks after making changes when appropriate.
4. **SAVE LEARNINGS**: Use save_memory when you learn key project facts or architecture decisions.

## Project Context
- Working Directory: ${workingDir}

${pastMemories ? `## Long-Term Memory (Past Sessions)\n${pastMemories}` : '## Memory: First session on this project.'}${skillCatalog ? `\n\n${skillCatalog}` : ''}`;
  }


  
  
  // THE AGENTIC LOOP

  async function run(userMessage, runOptions = {}) {

    const signal = runOptions.signal;
    const throwIfAborted = () => {
      if (signal?.aborted) {
        throw signal.reason || new DOMException('The operation was aborted', 'AbortError');
      }
    };
    throwIfAborted();

    // Capability scoping applies to both provider-visible tools and
    // execution, so a forged hidden tool call cannot bypass read-only mode.
    const runTools = Array.isArray(runOptions.capabilities)
      ? createCapabilityRegistry(tools || new Map(), runOptions.capabilities)
      : tools;

    // Record user input in short-term memory
    conversation.addUserMessage(userMessage);

    let iterations = 0;

    // Loop until AI gives a text-only response or hits safety limit
    while (iterations < maxIterations) {
      throwIfAborted();
      iterations++;

      // Show spinner while waiting for AI
      currentRenderer.startThinking();

      let aiResponse;
      try {
        aiResponse = await provider.chat(
          conversation.getMessages(),
          runTools ? getToolDefinitions(runTools) : [],
          (token) => currentRenderer.streamToken(token), //streming response
          { signal }
        );
      } catch (error) {
        currentRenderer.stopThinking();
        tracker.track('error', { message: error.message });
        throw error;
      }

      currentRenderer.stopThinking();
      throwIfAborted();

      // AI wants to use tools
      if (aiResponse.toolCalls && aiResponse.toolCalls.length > 0) {

        // Render assistant text if it accompanied the tool calls
        if (aiResponse.content) {
          currentRenderer.renderAssistant(aiResponse.content);
        }

        // Add assistant message with tool calls to conversation
        conversation.addAssistantMessage(
          aiResponse.content || '',
          aiResponse.toolCalls
        );

        // Execute each requested tool call
        for (const toolCall of aiResponse.toolCalls) {
          throwIfAborted();

          // Render tool execution notice
          currentRenderer.renderToolCall(toolCall.name, toolCall.arguments);

          // Track tool execution attempt
          tracker.track('tool_call', {
            tool: toolCall.name,
            args: toolCall.arguments,
          });

          let toolResult = '';

          // ═══ APPROVAL GATE CHECK ═══
          if (!runTools?.has(toolCall.name)) {
            // Reject hidden/disallowed tools before any approval prompt.
            toolResult = await executeTool(runTools, toolCall.name, toolCall.arguments);
          } else if (needsApproval(toolCall.name)) {
            // A channel (Telegram, webhook, …) can supply its own approval
            // handler; otherwise fall back to the interactive terminal gate.
            const approval = currentApprovalHandler
              ? await currentApprovalHandler(toolCall.name, toolCall.arguments)
              : await askUserApproval(toolCall.name, toolCall.arguments, workingDir);

            if (approval === 'rejected') {
              toolResult = '❌ Action rejected by user. Do not try this action again. Find another approach or ask the user.';
            } else {
              // Approved → execute tool
              toolResult = await executeTool(runTools, toolCall.name, toolCall.arguments);
            }
          } else {
            // Safe tool → execute immediately
            toolResult = await executeTool(runTools, toolCall.name, toolCall.arguments);
          }
          throwIfAborted();

          // Render tool completion
          currentRenderer.renderToolResult(toolCall.name, toolResult);

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
        currentRenderer.renderAssistant(aiResponse.content);
      }

      // Done with loop!
      break;
    }

    if (iterations >= maxIterations) {
      currentRenderer.renderWarning(
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


  // ── Conversation swapping (gateway session isolation) ──
  // The gateway keeps one agent but swaps in a per-sender conversation
  // so two chats never share context. Swapping re-installs the system
  // prompt (with memory + skill catalog) into the new conversation.
  function getConversation() {
    return conversation;
  }

  function setConversation(next) {
    conversation = next;
    initializeSystemPrompt();
    return conversation;
  }

  // ── Approval-policy swapping (gateway channels / scheduled jobs) ──
  // A caller can override the approval gate for the duration of a run
  // (e.g. auto-approve inside a trusted scheduled job, or reject
  // everything in a headless channel with no interactive UI).
  function getApprovalHandler() {
    return currentApprovalHandler;
  }

  function getRenderer() {
    return currentRenderer;
  }

  function setRenderer(next) {
    currentRenderer = next || renderer;
    return currentRenderer;
  }

  function setApprovalHandler(next) {
    currentApprovalHandler = next || undefined;
    return currentApprovalHandler;
  }


  return {
    run,
    get conversation() { return conversation; },
    getConversation,
    setConversation,
    getApprovalHandler,
    setApprovalHandler,
    tracker,
    getActionSummary,
    endSession,
    provider,
    tools,
    memory,
    get renderer() { return currentRenderer; },
    getRenderer,
    setRenderer,
    config,
    workingDir,
  };
}
