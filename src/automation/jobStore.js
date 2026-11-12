// ================================================================
// FILE: src/automation/jobStore.js
// PURPOSE: Load, normalise and validate scheduled jobs (Phase 4).
//
// A "job" is a cron expression plus a prompt to feed the agent:
//
//   {
//     id:          "nightly-triage",   // required, unique
//     name:        "Nightly triage",   // optional, defaults to id
//     schedule:    "0 3 * * *",        // required, cron expression
//     prompt:      "Summarise new issues and open a draft PR",
//     enabled:     true,               // optional, default true
//     timezone:    "Europe/London",    // optional, overrides the global tz
//     autoApprove: false,              // optional, overrides the global flag
//     senderId:    "job:nightly",      // optional, defaults to `job:<id>`
//   }
//
// Jobs come from two places, merged by id (inline wins):
//   1. config `automationJobsFile` — a JSON file: [ … ] or { "jobs": [ … ] }
//   2. config `automationJobs`     — an inline array (or a JSON string via
//                                    the QTPI_AUTOMATION_JOBS env var)
//
// This module is pure: it never schedules anything. The scheduler
// (scheduler.js) consumes the normalised list.
// ================================================================

import fs from 'fs';
import path from 'path';
import cron from 'node-cron';


// ─────────────────────────────────────────────────────────────
// parseJobList(raw)
// Accepts an array, a JSON string, or a single object and returns
// a plain array of raw job objects. Never throws.
// ─────────────────────────────────────────────────────────────
export function parseJobList(raw) {
  if (raw == null || raw === '') return [];

  if (Array.isArray(raw)) return raw;

  if (typeof raw === 'object') {
    // { jobs: [ … ] } or a single job object
    if (Array.isArray(raw.jobs)) return raw.jobs;
    return [raw];
  }

  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    try {
      return parseJobList(JSON.parse(text));
    } catch {
      return [];
    }
  }

  return [];
}


// ─────────────────────────────────────────────────────────────
// normalizeJob(raw, index)
// Coerces one raw entry into the canonical job shape.
// Returns { job, warnings } — job is null when the entry is
// unusable (missing id / schedule / prompt).
// ─────────────────────────────────────────────────────────────
export function normalizeJob(raw, index = 0, { validate = cron.validate } = {}) {
  const warnings = [];

  if (!raw || typeof raw !== 'object') {
    return { job: null, warnings: [`Job #${index} is not an object — skipped`] };
  }

  const id = String(raw.id ?? raw.name ?? '').trim();
  if (!id) {
    return { job: null, warnings: [`Job #${index} has no "id" — skipped`] };
  }

  const schedule = String(raw.schedule ?? raw.cron ?? '').trim();
  if (!schedule) {
    return { job: null, warnings: [`Job "${id}" has no "schedule" — skipped`] };
  }
  if (!validate(schedule)) {
    return { job: null, warnings: [`Job "${id}" has an invalid cron schedule "${schedule}" — skipped`] };
  }

  const prompt = String(raw.prompt ?? raw.task ?? '').trim();
  if (!prompt) {
    return { job: null, warnings: [`Job "${id}" has no "prompt" — skipped`] };
  }

  const job = {
    id,
    name: String(raw.name ?? id).trim() || id,
    schedule,
    prompt,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    timezone: raw.timezone ? String(raw.timezone).trim() : '',
    autoApprove: raw.autoApprove === undefined ? null : Boolean(raw.autoApprove),
    senderId: String(raw.senderId ?? `job:${id}`).trim() || `job:${id}`,
    channel: raw.channel == null ? '' : String(raw.channel).trim(),
    target: raw.target == null ? '' : String(raw.target).trim(),
  };

  return { job, warnings };
}


// ─────────────────────────────────────────────────────────────
// readJobsFile(filePath)
// Reads a JSON jobs file. Returns { jobs, warnings }.
// ─────────────────────────────────────────────────────────────
export function readJobsFile(filePath) {
  if (!filePath) return { jobs: [], warnings: [] };

  const resolved = filePath.startsWith('~')
    ? path.join(process.env.HOME || process.env.USERPROFILE || '', filePath.slice(1))
    : filePath;

  try {
    if (!fs.existsSync(resolved)) {
      return { jobs: [], warnings: [`Jobs file not found: ${resolved}`] };
    }
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    return { jobs: parseJobList(parsed), warnings: [] };
  } catch (error) {
    return { jobs: [], warnings: [`Could not read jobs file ${resolved}: ${error.message}`] };
  }
}


// ─────────────────────────────────────────────────────────────
// resolveJobs(config, { validate })
// Merge the jobs file + inline config into a validated, de-duped
// list. `config` is a wrapper ({ get }) or a plain object.
//
// Returns { jobs, warnings } where jobs is the normalised list
// (later entries override earlier ones with the same id).
// ─────────────────────────────────────────────────────────────
export function resolveJobs(config, { validate = cron.validate } = {}) {
  const get = (key) => (config && typeof config.get === 'function'
    ? config.get(key)
    : config?.[key]);

  const warnings = [];

  const fileResult = readJobsFile(get('automationJobsFile'));
  warnings.push(...fileResult.warnings);

  const inlineRaw = parseJobList(get('automationJobs'));

  const byId = new Map();

  for (const raw of [...fileResult.jobs, ...inlineRaw]) {
    const { job, warnings: jobWarnings } = normalizeJob(raw, byId.size, { validate });
    warnings.push(...jobWarnings);
    if (job) byId.set(job.id, job);
  }

  return { jobs: [...byId.values()], warnings };
}
