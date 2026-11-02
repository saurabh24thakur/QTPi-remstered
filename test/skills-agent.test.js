// ================================================================
// FILE: test/skills-agent.test.js
// PURPOSE: Step 7 — end-to-end through the agent.
//
// Proves the full loop: registry → system prompt catalog → model
// calls skill_read → tool executes → result fed back → final answer.
// Uses a mock provider so no network/API key is required.
//
// Run:  node --test test/skills-agent.test.js
// ================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';

import { createAgent } from '../src/core/Agent.js';
import { createSkillRegistry } from '../src/skills/skillRegistry.js';
import { registerSkillTools } from '../src/tools/skillTool.js';
import { createRegistry, getToolDefinitions } from '../src/tools/ToolRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// A no-op renderer that satisfies the Agent's renderer contract.
function makeRenderer() {
  return {
    startThinking() {},
    stopThinking() {},
    streamToken() {},
    renderAssistant() {},
    renderToolCall() {},
    renderToolResult() {},
    renderWarning() {},
    renderError() {},
  };
}

// A scripted provider: returns queued responses in order.
function makeProvider(responses) {
  let i = 0;
  return {
    name: 'mock',
    model: 'mock-1',
    async chat() {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
  };
}

describe('Step 7: end-to-end through the agent', () => {
  test('system prompt advertises the skill catalog', () => {
    const config = { get: (k) => ({ skillsEnabled: true, skillsDirs: ['./.qtpi/skills'] }[k]) };
    const skills = createSkillRegistry(config, { workingDir: REPO_ROOT });

    const agent = createAgent({
      provider: makeProvider([{ content: 'hi', toolCalls: [] }]),
      tools: createRegistry(),
      memory: null,
      renderer: makeRenderer(),
      config,
      workingDir: REPO_ROOT,
      skills,
    });

    const system = agent.conversation.getMessages().find((m) => m.role === 'system');
    assert.ok(system, 'a system message should exist');
    assert.match(system.content, /## Available Skills/);
    assert.match(system.content, /- commit-message: Write a clean, conventional commit message/);
    // Level 1 only — the body must NOT be in the base prompt.
    assert.doesNotMatch(system.content, /Conventional Commits message for the currently staged/);
  });

  test('model can call skill_read and receive the body', async () => {
    const config = { get: (k) => ({ skillsEnabled: true, skillsDirs: ['./.qtpi/skills'] }[k]) };
    const skills = createSkillRegistry(config, { workingDir: REPO_ROOT });

    const tools = createRegistry();
    registerSkillTools(tools, config, skills);

    // Turn 1: model asks to read the skill. Turn 2: model answers.
    const provider = makeProvider([
      {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'skill_read', arguments: { name: 'commit-message' } }],
      },
      { content: 'Loaded the commit-message skill.', toolCalls: [] },
    ]);

    const agent = createAgent({
      provider,
      tools,
      memory: null,
      renderer: makeRenderer(),
      config,
      workingDir: REPO_ROOT,
      skills,
    });

    await agent.run('use the commit-message skill');

    const messages = agent.conversation.getMessages();
    const toolMsg = messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'a tool result should be in the conversation');
    assert.match(toolMsg.content, /# Skill: commit-message/);
    assert.match(toolMsg.content, /Conventional Commits message/);

    // The final assistant answer is present.
    const last = messages[messages.length - 1];
    assert.equal(last.role, 'assistant');
    assert.match(last.content, /Loaded the commit-message skill/);
  });

  test('skill tools are exposed to the provider as definitions', () => {
    const config = { get: (k) => ({ skillsEnabled: true, skillsDirs: ['./.qtpi/skills'] }[k]) };
    const skills = createSkillRegistry(config, { workingDir: REPO_ROOT });
    const tools = createRegistry();
    registerSkillTools(tools, config, skills);

    const names = getToolDefinitions(tools).map((d) => d.name);
    assert.ok(names.includes('skill_list'));
    assert.ok(names.includes('skill_read'));
  });
});
