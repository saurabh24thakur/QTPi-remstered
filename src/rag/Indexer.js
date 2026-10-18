import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

export async function indexRepository(workingDir, store, provider) {
  const SKIP = [
    'node_modules', '.git', '.qtpi', 'dist', 'build', 
    '.next', '__pycache__', '.venv', 'venv', 'coverage',
    '.DS_Store'
  ];
  
  function getFiles(dir) {
    const results = [];
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (SKIP.includes(item.name)) continue;
      
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        results.push(...getFiles(fullPath));
      } else {
        const ext = path.extname(item.name);
        if (['.js', '.jsx', '.ts', '.tsx', '.py', '.md', '.json', '.html', '.css', '.txt'].includes(ext)) {
          results.push(fullPath);
        }
      }
    }
    return results;
  }
  
  const files = getFiles(workingDir);
  console.log(chalk.cyan(`  Found ${files.length} files to index.`));
  
  const chunks = [];
  
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (e) {
      continue;
    }
    
    const lines = content.split('\n');
    const relativePath = path.relative(workingDir, file).replace(/\\/g, '/');
    
    const chunkSize = 100;
    for (let i = 0; i < lines.length; i += chunkSize) {
      const chunkLines = lines.slice(i, i + chunkSize);
      const chunkContent = chunkLines.join('\n');
      
      if (chunkContent.trim().length === 0) continue;
      
      chunks.push({
        filePath: relativePath,
        content: chunkContent,
        startLine: i + 1,
        endLine: i + chunkLines.length,
      });
    }
  }
  
  if (chunks.length === 0) {
    console.log(chalk.yellow(`  No chunks found to index.`));
    return;
  }
  
  console.log(chalk.cyan(`  Generated ${chunks.length} chunks. Generating embeddings...`));
  
  if (typeof provider.embed !== 'function') {
    throw new Error(`Current provider (${provider.name}) does not support embeddings. Use OpenAI, Gemini, or Ollama.`);
  }

  const BATCH_SIZE = 50;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map(c => `File: ${c.filePath}\nLines: ${c.startLine}-${c.endLine}\n\n${c.content}`);
    
    try {
      const embeddings = await provider.embed(texts);
      for (let j = 0; j < batch.length; j++) {
        batch[j].embedding = embeddings[j];
      }
    } catch (error) {
      console.log(chalk.red(`  Failed to embed batch: ${error.message}`));
      throw error;
    }
    console.log(chalk.gray(`  Embedded ${Math.min(i + BATCH_SIZE, chunks.length)} / ${chunks.length} chunks`));
  }
  
  console.log(chalk.cyan(`  Saving chunks to Vector Store...`));
  await store.saveChunks(chunks);
  console.log(chalk.green(`  ✅ Successfully indexed ${chunks.length} chunks from ${files.length} files.`));
}