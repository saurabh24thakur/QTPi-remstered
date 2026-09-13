import fs from 'fs';
import path from 'path';
import chalk from 'chalk';


export function createActionTracker(projectDir) {

  // Where to save the log file
  const logDir = path.join(projectDir, '.qtpi');
  const logPath = path.join(logDir, 'actions.log');

  // temp holding actions
  let actions = [];

  // Unique ID for this session
  const sessionId = Date.now().toString(36);

  // Make sure the .qtpi folder exists if not it will create it

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }



  function track(type, details, result = null) {
    const action = {
      id: `${sessionId}-${actions.length}`,
      timestamp: new Date().toISOString(),
      type: type,
      details: details,
      result: result ? result.slice(0, 500) : null,
    };

    actions.push(action);

  
    try {
      const line = JSON.stringify(action) + '\n';
      fs.appendFileSync(logPath, line, 'utf-8');
    } catch {
      // If logging fails, don't crash the app
    }

    return action;
  }


  // ───────────────────────────────────────────────────────
  // getActions()
  // Return all actions from this session
  // ───────────────────────────────────────────────────────
  function getActions() {
    return actions;
  }


  // ───────────────────────────────────────────────────────
  // getSummary()
  // Return a pretty summary for the user
  // Called when user types /actions
  // ───────────────────────────────────────────────────────
  function getSummary() {
    if (actions.length === 0) {
      return '  No actions taken this session.';
    }

    const lines = actions.map(action => {
      const icon = getIcon(action.type);
      const time = new Date(action.timestamp).toLocaleTimeString();
      const detail = formatDetail(action);
      return `  ${icon} [${time}] ${detail}`;
    });

    return `  Session Actions (${actions.length} total):\n\n${lines.join('\n')}`;
  }


  
  function getIcon(type) {
    const icons = {
      tool_call: '🔧',
      tool_result: '📋',
      plan: '📌',
      error: '❌',
      complete: '✅',
    };
    return icons[type] || '▸';
  }



  function formatDetail(action) {
    if (action.type === 'tool_call') {
      const tool = action.details.tool || 'unknown';
      const args = JSON.stringify(action.details.args || {}).slice(0, 60);
      return `Called ${chalk.cyan(tool)}(${args})`;
    }

    if (action.type === 'error') {
      return chalk.red(`Error: ${action.details.message}`);
    }

    if (action.type === 'plan') {
      return `Created plan: ${action.details.name}`;
    }

    return JSON.stringify(action.details).slice(0, 80);
  }


  return {
    track,
    getActions,
    getSummary,
  };
}