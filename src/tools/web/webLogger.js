// ================================================================
// FILE: src/tools/web/webLogger.js
// PURPOSE: Lightweight, opt-in logging for web_search / web_crawl.
//
// Every fetch and search is recorded with URL/query, status, duration,
// and outcome so users can debug why a crawl was slow or blocked.
//
// Design:
//   - zero dependencies; writes one JSON object per line (JSONL)
//   - disabled by default (enabled: false) → all calls are no-ops
//   - optional console echo for live debugging
//   - bounded in-memory ring buffer so `web_logs` can show recent
//     activity without reading the file
//   - never throws: logging must not break a crawl
// ================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_LOG_PATH = path.join(os.homedir(), '.qtpi', 'web.log');
const DEFAULT_RING_SIZE = 100;


// ─────────────────────────────────────────────────────────────
// createWebLogger(options)
//
// options:
//   enabled   bool    master switch (default false)
//   toFile    bool    append JSONL to `file` (default true)
//   toConsole bool    echo a one-line summary to stderr (default false)
//   file      string  log file path
//   ringSize  number  in-memory recent-entry cap (default 100)
//   now       fn      injectable clock (tests)
// ─────────────────────────────────────────────────────────────
export function createWebLogger(options = {}) {
  const {
    enabled = false,
    toFile = true,
    toConsole = false,
    file = DEFAULT_LOG_PATH,
    ringSize = DEFAULT_RING_SIZE,
    now = () => Date.now(),
  } = options;

  const ring = []; // most-recent-last

  // ───────────────────────────────────────────────────────────
  // record(event)
  // event: { type, url?, query?, status?, ok?, durationMs?, ... }
  // ───────────────────────────────────────────────────────────
  function record(event) {
    if (!enabled) return;

    const entry = {
      ts: new Date(now()).toISOString(),
      ...event,
    };

    // Ring buffer (bounded).
    ring.push(entry);
    while (ring.length > ringSize) ring.shift();

    if (toConsole) {
      const label = entry.type || 'event';
      const target = entry.url || entry.query || '';
      const status = entry.status != null ? ` ${entry.status}` : '';
      const ok = entry.ok === false ? ' ✗' : entry.ok === true ? ' ✓' : '';
      const ms = entry.durationMs != null ? ` ${entry.durationMs}ms` : '';
      // stderr so it never pollutes tool output on stdout.
      process.stderr.write(`[web] ${label}${ok}${status}${ms} ${target}\n`);
    }

    if (toFile) writeLine(entry);
  }


  // ───────────────────────────────────────────────────────────
  // writeLine(entry)
  // Best-effort JSONL append; swallows all filesystem errors.
  // ───────────────────────────────────────────────────────────
  function writeLine(entry) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Logging must never break the tool.
    }
  }


  // ───────────────────────────────────────────────────────────
  // startTimer()
  // Returns a function that yields elapsed ms when called.
  // ───────────────────────────────────────────────────────────
  function startTimer() {
    const start = now();
    return () => now() - start;
  }


  // ───────────────────────────────────────────────────────────
  // recent(n)
  // Last n in-memory entries (newest last).
  // ───────────────────────────────────────────────────────────
  function recent(n = ringSize) {
    return ring.slice(-n);
  }


  // ───────────────────────────────────────────────────────────
  // readFile(limit)
  // Reads the tail of the log file (best-effort, for `web_logs`).
  // ───────────────────────────────────────────────────────────
  function readFile(limit = 50) {
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


  return {
    enabled,
    record,
    startTimer,
    recent,
    readFile,
    get file() { return file; },
    clearRing: () => { ring.length = 0; },
  };
}
