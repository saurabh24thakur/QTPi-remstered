import { createRegistry, executeTool } from './src/tools/toolsRegistory.js';
import { registerFileTools } from './src/tools/fileManager.js';
import { registerTerminalTools } from './src/tools/TerminalRunner.js';
import { registerGitTools } from './src/tools/GitManager.js';
import { registerSearchTools } from './src/tools/searchTool.js';

async function runTests() {
  const registry = createRegistry();
  const workingDir = process.cwd();

  console.log("Registering tools...");
  registerFileTools(registry, workingDir);
  registerTerminalTools(registry, workingDir);
  registerGitTools(registry, workingDir);
  registerSearchTools(registry, workingDir);

  console.log(`Registered ${registry.size} tools.`);
  
  try {
    console.log("\n--- Testing list_files ---");
    const listRes = await executeTool(registry, 'list_files', { dirPath: '.', maxDepth: 1 });
    console.log(listRes.substring(0, 300) + '...');

    console.log("\n--- Testing read_file ---");
    const readRes = await executeTool(registry, 'read_file', { filePath: 'package.json', startLine: 1, endLine: 5 });
    console.log(readRes);

    console.log("\n--- Testing run_command ---");
    const cmdRes = await executeTool(registry, 'run_command', { command: 'echo Hello from Terminal' });
    console.log(cmdRes);

    console.log("\n--- Testing search_code ---");
    const searchRes = await executeTool(registry, 'search_code', { pattern: 'createRegistry', filePattern: 'src/**/*.js' });
    console.log(searchRes);

    console.log("\n✅ All tool tests passed!");
  } catch (err) {
    console.error("\n❌ Tool test failed:", err);
  }
}

runTests();
