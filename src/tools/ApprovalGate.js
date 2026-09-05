import chalk from 'chalk';
import inquirer from 'inquirer';
import { diffLines } from 'diff';
import fs from 'fs';
import path from 'path';

const DANGEROUS_TOOLS = [
  'write_file',
  'edit_file',
  'delete_file',
  'run_command',
  'git_commit',
];


let approveAllMode = false;



export function needsApproval(toolName) {
  return DANGEROUS_TOOLS.includes(toolName);
}



export function resetApprovalMode() {
  approveAllMode = false;
}



export async function askUserApproval(toolName, args, workingDir) {

  // If user already picked "approve all", skip asking
  if (approveAllMode) {
    return 'approved';
  }

  console.log('');
  console.log(chalk.yellow('  ⚠️  QTPI wants to perform an action:'));
  console.log('');
  console.log(chalk.white(`  Action: ${chalk.bold(toolName)}`));

  showPreview(toolName, args);

  while (true) {
    const { choice } = await inquirer.prompt([
      {
        type: 'list',
        name: 'choice',
        message: 'What do you want to do?',
        choices: [
          { name: '✅ Approve this action', value: 'approve' },
          { name: '✅✅ Approve ALL remaining actions', value: 'approve_all' },
          { name: '❌ Reject this action', value: 'reject' },
          { name: '👁️  View full diff', value: 'view_diff' },
        ],
      },
    ]);

    if (choice === 'approve') {
      console.log(chalk.green('  ✓ Approved\n'));
      return 'approved';
    }

    if (choice === 'approve_all') {
      approveAllMode = true;
      console.log(chalk.green('  ✓ Approved ALL actions for this session\n'));
      return 'approved';
    }

    if (choice === 'reject') {
      console.log(chalk.red('  ✗ Rejected\n'));
      return 'rejected';
    }

    if (choice === 'view_diff') {
      showFullDiff(toolName, args, workingDir);
      // Loop back and show the menu again
      continue;
    }
  }
}


function showPreview(toolName, args) {

  if (toolName === 'write_file') {
    console.log(chalk.white(`  File:   ${chalk.cyan(args.filePath)}`));
    const lines = (args.content || '').split('\n').length;
    console.log(chalk.white(`  Type:   Creating/overwriting (${lines} lines)`));
  }

  if (toolName === 'edit_file') {
    console.log(chalk.white(`  File:   ${chalk.cyan(args.filePath)}`));
    console.log(chalk.white(`  Type:   Replacing text`));
    console.log('');

    // Mini diff (first 3 lines)
    const searchLines = (args.searchText || '').split('\n').slice(0, 3);
    const replaceLines = (args.replaceText || '').split('\n').slice(0, 3);

    for (const line of searchLines) {
      console.log(chalk.red(`    - ${line}`));
    }
    for (const line of replaceLines) {
      console.log(chalk.green(`    + ${line}`));
    }

    const totalSearch = (args.searchText || '').split('\n').length;
    if (totalSearch > 3) {
      console.log(chalk.gray(`    ... (${totalSearch - 3} more lines)`));
    }
  }

  if (toolName === 'delete_file') {
    console.log(chalk.white(`  File:   ${chalk.red(args.filePath)}`));
    console.log(chalk.red(`  ⚠ This cannot be undone!`));
  }

  if (toolName === 'run_command') {
    console.log(chalk.white(`  Command: ${chalk.cyan('$ ' + args.command)}`));
  }

  if (toolName === 'git_commit') {
    console.log(chalk.white(`  Message: ${chalk.cyan(args.message)}`));
  }

  console.log('');
}



function showFullDiff(toolName, args, workingDir) {

  console.log('');
  console.log(chalk.magenta('  ─── Full Diff ───'));
  console.log('');

  if (toolName === 'edit_file') {
    const fullPath = path.resolve(workingDir, args.filePath);

    try {
      if (fs.existsSync(fullPath)) {
        const original = fs.readFileSync(fullPath, 'utf-8');
        const updated = original.replace(
          args.searchText || '',
          args.replaceText || ''
        );

        const changes = diffLines(original, updated);

        for (const change of changes) {
          const lines = change.value.split('\n');
          for (const line of lines) {
            if (line === '') continue;
            if (change.added) console.log(chalk.green(`    + ${line}`));
            else if (change.removed) console.log(chalk.red(`    - ${line}`));
            else console.log(chalk.gray(`      ${line}`));
          }
        }
      } else {
        console.log(chalk.yellow('    File does not exist yet.'));
      }
    } catch (error) {
      console.log(chalk.yellow(`    Could not read file: ${error.message}`));
    }
  }

  if (toolName === 'write_file') {
    const fullPath = path.resolve(workingDir, args.filePath);
    const newContent = args.content || '';

    if (fs.existsSync(fullPath)) {
      const original = fs.readFileSync(fullPath, 'utf-8');
      const changes = diffLines(original, newContent);

      console.log(chalk.gray('    Comparing against existing file:'));
      console.log('');

      for (const change of changes) {
        const lines = change.value.split('\n');
        for (const line of lines) {
          if (line === '') continue;
          if (change.added) console.log(chalk.green(`    + ${line}`));
          else if (change.removed) console.log(chalk.red(`    - ${line}`));
          else console.log(chalk.gray(`      ${line}`));
        }
      }
    } else {
      const lines = newContent.split('\n');
      console.log(chalk.gray(`    New file (${lines.length} lines):`));
      console.log('');
      const preview = lines.slice(0, 30);
      for (const line of preview) {
        console.log(chalk.green(`    + ${line}`));
      }
      if (lines.length > 30) {
        console.log(chalk.gray(`    ... (${lines.length - 30} more lines)`));
      }
    }
  }

  if (toolName === 'delete_file') {
    const fullPath = path.resolve(workingDir, args.filePath);

    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      console.log(chalk.red(`    File has ${lines.length} lines. All will be deleted.`));
      console.log('');
      const preview = lines.slice(0, 10);
      for (const line of preview) {
        console.log(chalk.red(`    - ${line}`));
      }
      if (lines.length > 10) {
        console.log(chalk.gray(`    ... (${lines.length - 10} more lines)`));
      }
    }
  }

  if (toolName === 'run_command') {
    console.log(chalk.cyan(`    $ ${args.command}`));
  }

  if (toolName === 'git_commit') {
    console.log(chalk.cyan(`    Commit message: "${args.message}"`));
  }

  console.log('');
  console.log(chalk.magenta('  ─── End of Diff ───'));
  console.log('');
}