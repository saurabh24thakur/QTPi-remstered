import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const srcDir = path.join(__dirname, './src');

function getAllFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getAllFiles(filePath, fileList);
    } else if (file.endsWith('.js')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

async function checkImports() {
  const files = getAllFiles(srcDir);
  console.log(`Checking ${files.length} files...`);
  
  let hasError = false;
  for (const file of files) {
    try {
      await import(`file://${file}`);
    } catch (err) {
      console.error(`\nError importing ${file}:`);
      console.error(err.message);
      hasError = true;
    }
  }
  
  if (!hasError) {
    console.log('All files imported successfully!');
  }
}

checkImports();
