// ================================================================
// FILE: src/automation/createAutomation.js
// PURPOSE: Assemble the Phase 4 automation stack from config.
//
// One call wires together the three pieces:
//   jobStore.resolveJobs()  → validated job list
//   logger.js               → opt-in run log
//   scheduler.js            → cron tasks over the shared runtime
//
// The gateway (and `qtpi jobs`) call this so both entry points share
// exactly one scheduler and one job list.
// ================================================================

import { resolveJobs } from './jobStore.js';
import { createScheduler } from './scheduler.js';
import { createAutomationLoggerFromConfig } from './logger.js';


// ─────────────────────────────────────────────────────────────
// createAutomation({ runtime, config, logger, options })
//
//   runtime   { agent }   the shared runtime (from createRuntime)
//   config    { get }     config wrapper
//   logger    fn          optional pre-built logger (else from config)
//   options   object      { jobs, timeoutMs, autoApprove, now }
//
// Returns:
//   { enabled, scheduler, jobs, warnings, logger, start, stop, status }
// ─────────────────────────────────────────────────────────────
export function createAutomation({ runtime, config, logger, options = {} } = {}) {
  const get = (key) => (config && typeof config.get === 'function'
    ? config.get(key)
    : config?.[key]);

  const bool = (value, fallback = false) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return value === undefined || value === null ? fallback : Boolean(value);
  };

  const enabled = options.enabled === undefined
    ? bool(get('automationEnabled'), false)
    : Boolean(options.enabled);

  const { jobs, warnings } = options.jobs
    ? { jobs: options.jobs, warnings: [] }
    : resolveJobs(config);

  const runLogger = logger || createAutomationLoggerFromConfig(config);

  const scheduler = createScheduler({
    runtime,
    config,
    jobs,
    logger: runLogger,
    now: options.now,
    timeoutMs: options.timeoutMs,
    autoApprove: options.autoApprove,
    deliver: options.deliver,
    renderer: options.renderer,
  });

  function start() {
    if (!enabled) return false;
    scheduler.start();
    return true;
  }

  function stop() {
    scheduler.stop();
  }

  function status() {
    return {
      enabled,
      warnings,
      ...scheduler.status(),
      jobs: scheduler.list(),
    };
  }

  return {
    enabled,
    scheduler,
    jobs,
    warnings,
    logger: runLogger,
    start,
    stop,
    status,
  };
}
