// ================================================================
// FILE: src/automation/scheduler.js
// PURPOSE: Run scheduled jobs (cron) through the shared QTPi runtime
// (Phase 4).
//
// The scheduler is deliberately thin. It owns three concerns:
//
//   1. TIMING   — node-cron tasks, one per enabled job.
//   2. ISOLATION — every run gets a FRESH conversation, so a job never
//                  sees (or pollutes) a user's chat history, and two
//                  jobs never see each other's context.
//   3. SAFETY   — a global lock (the agent has ONE conversation slot),
//                  a per-job overlap guard, and a wall-clock timeout.
//
// It knows nothing about cron internals beyond node-cron's API, and
// nothing about the agent beyond run/setConversation/getConversation.
// That keeps it trivially testable with a fake runtime.
// ================================================================

import cron from 'node-cron';
import { createConversation } from '../memory/ConversationHistory.js';
import { acquireAgentLock } from '../core/AgentLock.js';


// ─────────────────────────────────────────────────────────────
// createCollectingRenderer()
// A renderer that accumulates assistant text instead of printing it.
// Used by `qtpi jobs run` and the gateway so a scheduled run's output
// can be logged / returned rather than sprayed at a terminal.
// ─────────────────────────────────────────────────────────────
export function createCollectingRenderer() {
  const chunks = [];
  return {
    chunks,
    startThinking() {},
    stopThinking() {},
    streamToken() {},
    renderAssistant(text) { if (text) chunks.push(String(text)); },
    renderToolCall() {},
    renderToolResult() {},
    renderWarning(message) { if (message) chunks.push(`⚠️ ${message}`); },
    renderError(message) { if (message) chunks.push(`❌ ${message}`); },
    renderWelcome() {},
    getOutput() { return chunks.join('\n'); },
    reset() { chunks.length = 0; },
  };
}


// ─────────────────────────────────────────────────────────────
// createScheduler({ runtime, config, jobs, logger, now, ... })
//
//   runtime     { agent }   agent needs run/setConversation/getConversation
//   config      { get }     config wrapper (for timezone / autoApprove / timeout)
//   jobs        array       normalised jobs (see jobStore.resolveJobs)
//   logger      fn          optional (level, message, meta) sink
//   now         fn          injectable clock (tests)
//   timeoutMs   number      wall-clock cap per run (default from config)
//   autoApprove bool        default approval policy for runs
//
// Returns:
//   start()          → void      schedule every enabled job
//   stop()           → void      destroy every task
//   runNow(id)       → Promise   run one job immediately (ignores schedule)
//   list()           → array     job descriptors incl. nextRun / lastResult
//   get(id)          → job|undefined
//   status()         → { running, jobs, scheduled }
// ─────────────────────────────────────────────────────────────
export function createScheduler({
  runtime,
  config,
  jobs = [],
  logger = () => {},
  now = () => Date.now(),
  timeoutMs,
  autoApprove,
  deliver,
  renderer,
} = {}) {
  if (!runtime || !runtime.agent || typeof runtime.agent.run !== 'function') {
    throw new TypeError('createScheduler requires a runtime with an agent that has run()');
  }
  if (typeof runtime.agent.setConversation !== 'function') {
    throw new TypeError('createScheduler requires agent.setConversation()');
  }

  const cfg = (key) => (config && typeof config.get === 'function'
    ? config.get(key)
    : config?.[key]);

  const runTimeoutMs = Number.isFinite(timeoutMs)
    ? timeoutMs
    : (Number(cfg('automationRunTimeoutMs')) || 300000);

  const defaultAutoApprove = autoApprove === undefined
    ? Boolean(cfg('automationAutoApprove'))
    : Boolean(autoApprove);

  const globalTimezone = String(cfg('automationTimezone') || '').trim();

  // id → { job, task, running, lastRun, lastResult, nextRun }
  const entries = new Map();
  for (const job of jobs) {
    entries.set(job.id, {
      job,
      task: null,
      running: false,
      lastRun: null,
      lastResult: null,
      nextRun: null,
    });
  }

  let started = false;

  // Serialises runs: the agent has exactly one active conversation, so
  // two concurrent runs would corrupt each other's history.
  let lock = Promise.resolve();
  function withLock(fn) {
    const result = lock.then(() => fn());
    lock = result.then(() => undefined, () => undefined);
    return result;
  }

  // ── One job run ───────────────────────────────────────────────
  async function execute(entry, trigger) {
    const releaseAgent = await acquireAgentLock(runtime.agent);
    const { job } = entry;
    const startedAt = now();
    const previousRenderer = typeof runtime.agent.getRenderer === 'function'
      ? runtime.agent.getRenderer()
      : runtime.agent.renderer;
    const activeRenderer = renderer || runtime.renderer;
    if (activeRenderer && typeof runtime.agent.setRenderer === 'function') {
      runtime.agent.setRenderer(activeRenderer);
    }

    // Fresh conversation → full isolation from users and other jobs.
    const conversation = createConversation(50);
    runtime.agent.setConversation(conversation);

    // Per-job approval policy. A scheduled run has no interactive UI, so
    // the default is to REJECT sensitive tools; a job (or the global
    // automationAutoApprove flag) can opt into auto-approval.
    const canSwapApproval = typeof runtime.agent.setApprovalHandler === 'function'
      && typeof runtime.agent.getApprovalHandler === 'function';
    const previousApproval = canSwapApproval ? runtime.agent.getApprovalHandler() : undefined;
    if (canSwapApproval) {
      const approve = job.autoApprove === null ? defaultAutoApprove : job.autoApprove;
      runtime.agent.setApprovalHandler(approve ? async () => 'approved' : async () => 'rejected');
    }

    let timer = null;
    let cleanupDeferred = false;
    const abortController = new AbortController();
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (canSwapApproval) runtime.agent.setApprovalHandler(previousApproval);
      if (activeRenderer && typeof runtime.agent.setRenderer === 'function') {
        runtime.agent.setRenderer(previousRenderer);
      }
      entry.lastRun = now();
      entry.running = false;
      releaseAgent();
    };

    try {
      activeRenderer?.reset?.();
      const runPromise = Promise.resolve().then(() => runtime.agent.run(job.prompt, { signal: abortController.signal }));
      const runResult = runPromise.then(
        () => ({ type: 'complete' }),
        (error) => ({ type: 'error', error }),
      );
      const timeoutResult = new Promise((resolve) => {
        timer = setTimeout(() => {
          abortController.abort(new Error(`Job "${job.id}" exceeded ${runTimeoutMs}ms`));
          resolve({ type: 'timeout' });
        }, runTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      const outcome = await Promise.race([runResult, timeoutResult]);

      if (outcome.type === 'timeout') {
        // Keep the agent lock and temporary state until the aborted run unwinds.
        cleanupDeferred = true;
        runPromise.finally(cleanup).catch(() => {});
        const finishedAt = now();
        const result = {
          id: job.id,
          ok: false,
          trigger,
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
          error: `Job "${job.id}" exceeded ${runTimeoutMs}ms; cancellation requested and its agent slot remains locked until the run exits`,
        };
        entry.lastResult = result;
        logger('error', `job "${job.id}" timed out`, { trigger });
        return result;
      }
      if (outcome.type === 'error') throw outcome.error;

      const output = activeRenderer?.getOutput?.() || '';
      if (output && typeof deliver === 'function') await deliver(job, output, { trigger });
      const finishedAt = now();
      const result = {
        id: job.id,
        ok: true,
        trigger,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        error: null,
        output,
      };
      entry.lastResult = result;
      logger('info', `job "${job.id}" completed`, { durationMs: result.durationMs, trigger });
      return result;
    } catch (error) {
      const finishedAt = now();
      const result = {
        id: job.id,
        ok: false,
        trigger,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        error: error.message,
      };
      entry.lastResult = result;
      logger('error', `job "${job.id}" failed: ${error.message}`, { trigger });
      return result;
    } finally {
      if (!cleanupDeferred) cleanup();
    }
  }

  // ── Public: run one job now ───────────────────────────────────
  function runNow(id) {
    const entry = entries.get(id);
    if (!entry) return Promise.reject(new Error(`Unknown job "${id}"`));

    return withLock(async () => {
      if (entry.running) {
        return { id, ok: false, skipped: true, error: 'Job is already running' };
      }
      entry.running = true;
      return execute(entry, 'manual');
    });
  }

  // ── Public: schedule everything ───────────────────────────────
  function start() {
    if (started) return;
    started = true;

    for (const entry of entries.values()) {
      const { job } = entry;
      if (!job.enabled) continue;

      const timezone = job.timezone || globalTimezone || undefined;

      entry.task = cron.schedule(
        job.schedule,
        () => {
          // Fire-and-forget: cron must not await, or a slow job would
          // block the timer. Overlap is guarded inside runNow().
          runNow(job.id).catch((error) => {
            logger('error', `job "${job.id}" crashed: ${error.message}`);
          });
        },
        { timezone, name: job.id },
      );

      entry.nextRun = typeof entry.task.getNextRun === 'function'
        ? entry.task.getNextRun()
        : null;

      logger('info', `scheduled job "${job.id}" (${job.schedule})`, { timezone });
    }
  }

  function stop() {
    for (const entry of entries.values()) {
      if (entry.task) {
        try { entry.task.destroy(); } catch { /* already gone */ }
        entry.task = null;
      }
      entry.nextRun = null;
    }
    started = false;
  }

  // ── Introspection ─────────────────────────────────────────────
  function list() {
    return [...entries.values()].map((entry) => ({
      id: entry.job.id,
      name: entry.job.name,
      schedule: entry.job.schedule,
      enabled: entry.job.enabled,
      timezone: entry.job.timezone || globalTimezone || null,
      running: entry.running,
      nextRun: entry.nextRun,
      lastRun: entry.lastRun,
      lastResult: entry.lastResult,
    }));
  }

  function get(id) {
    return entries.get(id)?.job;
  }

  function status() {
    return {
      running: started,
      jobs: entries.size,
      scheduled: [...entries.values()].filter((e) => e.task).length,
    };
  }

  return { start, stop, runNow, list, get, status, get started() { return started; } };
}
