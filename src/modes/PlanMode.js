import chalk from 'chalk';
import inquirer from 'inquirer';
import { createPlanner } from '../core/Planner.js';

export function createPlanMode(agent) {
  const name = 'plan';
  const description = 'Plan first, then execute step-by-step with approval';
  const planner = createPlanner(agent);

  async function processInput(input) {
    console.log(chalk.magenta('\n  📋 Generating step-by-step plan...\n'));

    // Step 1: Generate plan via Planner
    const plan = await planner.createPlan(input);

    // Step 2: Show plan in terminal
    planner.displayPlan(plan);

    // Step 3: Present arrow-key choices using inquirer
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do with this plan?',
        choices: [
          { name: '✅ Execute entire plan', value: 'execute_all' },
          { name: '📌 Execute step-by-step (confirm each)', value: 'step_by_step' },
          { name: '✏️  Revise the plan', value: 'revise' },
          { name: '❌ Cancel', value: 'cancel' },
        ],
      },
    ]);

    // Handle user choice
    if (action === 'cancel') {
      console.log(chalk.gray('\n  Plan execution cancelled.\n'));
      return;
    }

    if (action === 'revise') {
      const { revision } = await inquirer.prompt([
        {
          type: 'input',
          name: 'revision',
          message: 'How should the plan be revised?',
        },
      ]);
      // Re-run planning with revision request
      await processInput(`${input}\n\nRequested revisions: ${revision}`);
      return;
    }

    if (action === 'execute_all') {
      await agent.run(
        `Execute this complete plan:\n\n${plan.rawText}\n\nOriginal Request: ${input}`
      );
    }

    if (action === 'step_by_step') {
      for (const step of plan.steps) {
        console.log(chalk.magenta(`\n  📌 Step ${step.number}: ${step.title}`));
        console.log(chalk.gray(`     ${step.description.split('\n')[0]}\n`));

        const { proceed } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'proceed',
            message: `Execute Step ${step.number}?`,
            default: true,
          },
        ]);

        if (!proceed) {
          step.status = 'skipped';
          console.log(chalk.yellow('  ⏭ Step skipped.'));
          continue;
        }

        step.status = 'running';
        await agent.run(
          `Execute Step ${step.number} of plan: ${step.title}\n` +
          `Step Details: ${step.description}\n` +
          `Task Context: ${input}`
        );
        step.status = 'done';
      }

      console.log(chalk.green('\n  ✅ Plan execution complete!\n'));
    }
  }

  return {
    name,
    description,
    processInput,
  };
}