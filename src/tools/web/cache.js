// ================================================================
// FILE: src/tools/web/cache.js
// PURPOSE: TTL cache for web_search / web_crawl results.
//
// Why: search APIs cost money and crawls cost time. Repeating the same
// query/URL within a short window should be free.
//
// Features:
//   - in-memory Map with per-entry TTL (default: none / 0 = disabled)
//   - optional on-disk persistence (JSON files under ~/.qtpi/web-cache)
//   - hit/miss stats for logging and the `web_cache_stats` view
//   - namespaced keys ("search:..." vs "crawl:...") with hashed filenames
//   - LRU-ish cap on entries so memory can't grow unbounded
//
// The cache is safe to leave off: everything degrades to a no-op when
// `enabled` is false or `ttlMs <= 0`.
// ================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const DEFAULT_MAX_ENTRIES = 500;
const CACHE_DIR = path.join(os.homedir(), '.qtpi', 'web-cache');


// ─────────────────────────────────────────────────────────────
// createWebCache(options)
//
// options:
//   enabled    bool    master switch (default false)
//   ttlMs      number  entry lifetime in ms (default 0 → disabled)
//   persist    bool    also write entries to disk (default false)
//   maxEntries number  in-memory cap before eviction (default 500)
//   dir        string  override the on-disk directory
// ─────────────────────────────────────────────────────────────
export function createWebCache(options = {}) {
  const {
    enabled = false,
    ttlMs = 0,
    persist = false,
    maxEntries = DEFAULT_MAX_ENTRIES,
    dir = CACHE_DIR,
  } = options;

  const active = enabled && Number(ttlMs) > 0;
  const memory = new Map(); // key -> { value, expiresAt, createdAt }

  const stats = { hits: 0, misses: 0, sets: 0, evictions: 0 };

  if (active && persist) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // If we can't create the dir, fall back to memory-only.
    }
  }


  // ───────────────────────────────────────────────────────────
  // cacheKey(namespace, key)
  // Deterministic, filesystem-safe key: "<ns>-<sha1(prefix)>".
  // ───────────────────────────────────────────────────────────
  function cacheKey(namespace, key) {
    const hash = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 16);
    return { id: `${namespace}-${hash}`, hash, namespace };
  }


  // ───────────────────────────────────────────────────────────
  // diskPath(id)
  // ───────────────────────────────────────────────────────────
  function diskPath(id) {
    return path.join(dir, `${id}.json`);
  }


  // ───────────────────────────────────────────────────────────
  // get(namespace, key)
  // Returns the cached value or null when missing/expired/disabled.
  // ───────────────────────────────────────────────────────────
  function get(namespace, key) {
    if (!active) return null;

    const { id } = cacheKey(namespace, key);
    const now = Date.now();

    const entry = memory.get(id);
    if (entry) {
      if (entry.expiresAt > now) {
        // Refresh recency so hot entries survive eviction.
        memory.delete(id);
        memory.set(id, entry);
        stats.hits++;
        return entry.value;
      }
      memory.delete(id);
    }

    // Fall back to disk when persistence is on.
    if (persist) {
      const fromDisk = readDisk(id, now);
      if (fromDisk !== null) {
        memory.set(id, fromDisk);
        stats.hits++;
        return fromDisk.value;
      }
    }

    stats.misses++;
    return null;
  }


  // ───────────────────────────────────────────────────────────
  // set(namespace, key, value)
  // Stores a value for ttlMs; optionally mirrors it to disk.
  // ───────────────────────────────────────────────────────────
  function set(namespace, key, value) {
    if (!active) return;

    const { id } = cacheKey(namespace, key);
    const now = Date.now();
    const entry = { value, createdAt: now, expiresAt: now + ttlMs };

    memory.set(id, entry);
    stats.sets++;
    evictIfNeeded();

    if (persist) writeDisk(id, entry);
  }


  // ───────────────────────────────────────────────────────────
  // evictIfNeeded()
  // Drops the oldest entries (Map preserves insertion order) once we
  // exceed maxEntries, so memory stays bounded on long sessions.
  // ───────────────────────────────────────────────────────────
  function evictIfNeeded() {
    while (memory.size > maxEntries) {
      const oldest = memory.keys().next().value;
      memory.delete(oldest);
      stats.evictions++;
    }
  }


  // ───────────────────────────────────────────────────────────
  // readDisk(id, now)
  // Loads + validates a persisted entry. Deletes expired/corrupt files.
  // ───────────────────────────────────────────────────────────
  function readDisk(id, now) {
    const file = diskPath(id);
    try {
      if (!fs.existsSync(file)) return null;
      const entry = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!entry || typeof entry !== 'object' || !('value' in entry)) {
        fs.unlinkSync(file);
        return null;
      }
      if (entry.expiresAt <= now) {
        fs.unlinkSync(file);
        return null;
      }
      return entry;
    } catch {
      // Corrupt file → best-effort delete, treat as a miss.
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      return null;
    }
  }


  // ───────────────────────────────────────────────────────────
  // writeDisk(id, entry)
  // Best-effort persistence — never throws into the caller.
  // ───────────────────────────────────────────────────────────
  function writeDisk(id, entry) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(diskPath(id), JSON.stringify(entry), 'utf-8');
    } catch {
      // Ignore disk errors (read-only FS, permissions, ...).
    }
  }


  // ───────────────────────────────────────────────────────────
  // clear()
  // Wipes memory (and disk files when persisting).
  // ───────────────────────────────────────────────────────────
  function clear() {
    memory.clear();
    if (persist) {
      try {
        if (fs.existsSync(dir)) {
          for (const file of fs.readdirSync(dir)) {
            if (file.endsWith('.json')) {
              try { fs.unlinkSync(path.join(dir, file)); } catch { /* ignore */ }
            }
          }
        }
      } catch {
        // Ignore.
      }
    }
  }


  return {
    enabled: active,
    get,
    set,
    clear,
    key: cacheKey,
    get size() { return memory.size; },
    getStats: () => ({ ...stats, size: memory.size, enabled: active }),
    // Wrap an async producer: return the cached value or compute+store.
    async remember(namespace, key, producer) {
      if (!active) return producer();
      const cached = get(namespace, key);
      if (cached !== null) return cached;
      const value = await producer();
      if (value !== undefined && value !== null) set(namespace, key, value);
      return value;
    },
  };
}
