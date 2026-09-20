
import chalk from 'chalk';


export function createPlanner(agent) {

 
  async function createPlan(task) {
    const planPrompt =
      `Create a detailed step-by-step plan for this task. ` +
      `DO NOT execute any tools yet - plan only.\n\n` +
      `Task: ${task}\n\n` +
      `Respond in this EXACT format:\n` +
      `## Plan: [Brief Title]\n\n` +
      `### Step 1: [Step Title]\n` +
      `[Description of what to do]\n\n` +
      `### Step 2: [Step Title]\n` +
      `[Description of what to do]\n\n` +
      `### Summary\n` +
      `[Brief overview of what this plan achieves]`;

    agent.conversation.addUserMessage(planPrompt);

 
    const response = await agent.provider.chat(
      agent.conversation.getMessages(),
      []
    );

    agent.conversation.addAssistantMessage(response.content);

   
    agent.tracker.track('plan', { task: task.slice(0, 100) });

    return parsePlanText(response.content);
  }


  function parsePlanText(text) {
    const plan = {
      title: '',
      steps: [],
      summary: '',
      rawText: text,
    };

    const lines = text.split('\n');
    let currentStep = null;
    let inSummary = false;

    for (const line of lines) {
      if (line.startsWith('## Plan:')) {
        plan.title = line.replace('## Plan:', '').trim();
        continue;
      }

      const stepMatch = line.match(/^###\s+Step\s+(\d+):\s*(.+)/i);
      if (stepMatch) {
        if (currentStep) plan.steps.push(currentStep);

        currentStep = {
          number: parseInt(stepMatch[1]),
          title: stepMatch[2].trim(),
          description: '',
          status: 'pending', 
        };
        inSummary = false;
        continue;
      }

      if (line.match(/^###\s+Summary/i)) {
        if (currentStep) {
          plan.steps.push(currentStep);
          currentStep = null;
        }
        inSummary = true;
        continue;
      }

      if (currentStep) {
        currentStep.description += line + '\n';
      } else if (inSummary) {
        plan.summary += line + '\n';
      }
    }

    if (currentStep) plan.steps.push(currentStep);

    for (const step of plan.steps) {
      step.description = step.description.trim();
    }
    plan.summary = plan.summary.trim();

    return plan;
  }


  
  function displayPlan(plan) {
    console.log(chalk.magenta(`\n  📋 Plan: ${plan.title || 'Untitled Plan'}\n`));

    for (const step of plan.steps) {
      const statusIcon = {
        pending: '⬜',
        running: '🔄',
        done: '✅',
        failed: '❌',
        skipped: '⏭',
      }[step.status] || '⬜';

      console.log(chalk.white(`  ${statusIcon} Step ${step.number}: ${step.title}`));

      if (step.description) {
        const firstLine = step.description.split('\n')[0].slice(0, 80);
        console.log(chalk.gray(`     ${firstLine}`));
      }
    }

    if (plan.summary) {
      console.log(chalk.gray(`\n  Summary: ${plan.summary.split('\n')[0]}`));
    }
    console.log('');
  }


  return {
    createPlan,
    displayPlan,
  };
}