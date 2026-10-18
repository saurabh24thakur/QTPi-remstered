
export function createAskMode(agent) {
  const name = 'ask';
  const description = 'Ask questions - read-only, makes no code modifications';

  async function processInput(input) {
    // Wrap the prompt with a clear read-only constraint
    const safeInput = 
      `[ASK MODE - READ-ONLY CONSTRAINTS ACTIVE]\n` +
      `You are in read-only mode. You may read files and search code, ` +
      `but do NOT write, edit, delete files, or run commands that modify anything. ` +
      `Provide answers and explanations only.\n\n` +
      `User Question: ${input}`;

    await agent.run(safeInput);
  }

  return {
    name,
    description,
    processInput,
  };
}