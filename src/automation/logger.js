// ================================================================
// FILE: src/automation/logger.js
// PURPOSE: Opt-in logging for scheduled jobs (Phase 4).
//
// Mirrors src/tools/web/webLogger.js: zero dependencies, JSONL on
// disk, an in-memory ring buffer, and it never throws. Disabled by
// default, so a scheduler built without a logger costs nothing.
//
// A log line records one job run:
//   { ts, level, message, id?, durationMs?, trigger?, ...meta }
// ================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_LOG_PATH = path.join(os.homedir(), '.qtpi', 'automation.log');
const DEFAULT_RING_SIZE = 200;


// ─────────────────────────────────────────────────────────────
// createAutomationLogger(options)
//
// options:
//   enabled   bool    master switch (default false)
//   toFile    bool    append JSONL to `file` (default true)
//   toConsole bool    echo a one-line summary to stderr (default false)
//   file      string  log file path
//   ringSize  number  in-memory recent-entry cap (default 200)
//   now       fn      injectable clock (tests)
//
// Returns a `logger(level, message, meta)` function with extra
// helpers attached (recent / readFile / file / enabled).
// ─────────────────────────────────────────────────────────────
export function createAutomationLogger(options = {}) {
  const {
    enabled = false,
    toFile = true,
    toConsole = false,
    file = DEFAULT_LOG_PATH,
    ringSize = DEFAULT_RING_SIZE,
    now = () => Date.now(),
  } = options;

  const ring = []; // most-recent-last

  function writeLine(entry) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Logging must never break a scheduled run.
    }
  }

  function logger(level, message, meta = {}) {
    if (!enabled) return;

    const entry = {
      ts: new Date(now()).toISOString(),
      level: level || 'info',
      message: String(message ?? ''),
      ...meta,
    };

    ring.push(entry);
    while (ring.length > ringSize) ring.shift();

    if (toConsole) {
      const id = entry.id ? ` [${entry.id}]` : '';
      const ms = entry.durationMs != null ? ` ${entry.durationMs}ms` : '';
      // stderr so it never pollutes structured output on stdout.
      process.stderr.write(`[automation] ${entry.level}${id}${ms} ${entry.message}\n`);
    }

    if (toFile) writeLine(entry);
  }

  function recent(n = ringSize) {
    return ring.slice(-n);
  }

  function readFile(limit = 100) {
    try {
      if (!fs.existsSync(file)) return [];
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      return lines.slice(-limit).map((line) => {
        try { return JSON.parse(line); } catch { return { raw: line }; }
      });
    } catch {
      return [];
    }
  }

  logger.enabled = enabled;
  logger.recent = recent;
  logger.readFile = readFile;
  logger.file = file;
  logger.clearRing = () => { ring.length = 0; };

  return logger;
}


// ─────────────────────────────────────────────────────────────
// createAutomationLoggerFromConfig(config)
// Builds a logger from the config wrapper's automationLog* keys.
// ─────────────────────────────────────────────────────────────
export function createAutomationLoggerFromConfig(config) {
  const get = (key) => (config && typeof config.get === 'function'
    ? config.get(key)
    : config?.[key]);

  const bool = (value, fallback = false) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return value === undefined || value === null ? fallback : Boolean(value);
  };

  return createAutomationLogger({
    enabled: bool(get('automationLogEnabled'), false),
    toFile: true,
    toConsole: false,
    file: String(get('automationLogFile') || '') || DEFAULT_LOG_PATH,
  });
}
