
export function createAgentMode(agent) {
  const name = 'agent';
  const description = 'Full agent - can read, write, edit, and execute commands';

  async function processInput(input) {
    // Passes input straight through to the agent brain
    await agent.run(input);
  }

  return {
    name,
    description,
    processInput,
  };
}