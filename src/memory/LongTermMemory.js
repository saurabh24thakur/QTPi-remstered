

import fs from 'fs';
import path from 'path';
import { registerTool } from '../tools/ToolRegistry.js';


export function createLongTermMemory(projectDir) {

  // Where to save the memory file
  const memoryPath = path.join(projectDir, '.qtpi', 'memory.json');

  // Load existing memories from disk (or start empty)
  let memories = loadFromDisk();



  function loadFromDisk() {
    try {
      if (fs.existsSync(memoryPath)) {
        const raw = fs.readFileSync(memoryPath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch {
      // File is broken — start fresh
    //   return throw error("file is not there")
    }

    return {
      projectFacts: [],
      userPreferences: [],
      decisions: [],
      sessionSummaries: [],
    };
  }


  function saveToDisk() {
    const dir = path.dirname(memoryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(memoryPath, JSON.stringify(memories, null, 2), 'utf-8');
  }


  // ───────────────────────────────────────────────────────
  // remember(category, content)
  // Save a new memory
  //
  // Example: remember('projectFacts', 'Uses React 18')
  // ───────────────────────────────────────────────────────
  function remember(category, content) {
    if (!memories[category]) {
      memories[category] = [];
    }

    // Don't save duplicates
    const alreadyExists = memories[category].some(
      m => m.content.toLowerCase() === content.toLowerCase()
    );
    if (alreadyExists) return;

    // Add the memory
    memories[category].push({
      content: content,
      createdAt: new Date().toISOString(),
    });

    // Keep max 50 per category
    if (memories[category].length > 50) {
      memories[category] = memories[category].slice(-50);
    }

    saveToDisk();
  }


 
  function saveSessionSummary(summary) {
    memories.sessionSummaries.push({
      content: summary,
      createdAt: new Date().toISOString(),
    });

    // Keep only last 20 summaries
    if (memories.sessionSummaries.length > 20) {
      memories.sessionSummaries = memories.sessionSummaries.slice(-20);
    }

    saveToDisk();
  }


 
  function recall() {
    const sections = [];

    if (memories.projectFacts.length > 0) {
      sections.push(
        '**Project Facts:**\n' +
        memories.projectFacts.map(m => `- ${m.content}`).join('\n')
      );
    }

    if (memories.userPreferences.length > 0) {
      sections.push(
        '**User Preferences:**\n' +
        memories.userPreferences.map(m => `- ${m.content}`).join('\n')
      );
    }

    if (memories.decisions.length > 0) {
      sections.push(
        '**Decisions Made:**\n' +
        memories.decisions.map(m => `- ${m.content}`).join('\n')
      );
    }

    if (memories.sessionSummaries.length > 0) {
      const recent = memories.sessionSummaries.slice(-3);
      sections.push(
        '**Recent Sessions:**\n' +
        recent.map(m => `- [${m.createdAt.split('T')[0]}] ${m.content}`).join('\n')
      );
    }

    return sections.join('\n\n');
  }

  function registerMemoryTools(registry) {

    // Tool: AI saves a memory
    registerTool(registry, 'save_memory', {
      description: 'Save an important fact to long-term memory so you remember it in future sessions. Use when you learn something about the project, user preferences, or important decisions.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['projectFacts', 'userPreferences', 'decisions'],
            description: 'What kind of memory',
          },
          content: {
            type: 'string',
            description: 'What to remember (be concise)',
          },
        },
        required: ['category', 'content'],
      },
    }, async ({ category, content }) => {
      remember(category, content);
      return `🧠 Saved to memory: "${content}"`;
    });

    // Tool: AI recalls memories
    registerTool(registry, 'recall_memories', {
      description: 'Recall all stored memories from previous sessions.',
      parameters: { type: 'object', properties: {} },
    }, async () => {
      return recall() || 'No memories stored yet.';
    });
  }


  return {
    remember,
    recall,
    saveSessionSummary,
    registerMemoryTools,
  };
}