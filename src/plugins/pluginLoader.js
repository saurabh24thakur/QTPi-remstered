import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { registerTool } from '../tools/ToolRegistry.js';

function read(config, key) {
  return config && typeof config.get === 'function' ? config.get(key) : config?.[key];
}

function parseDirs(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  if (raw.trimStart().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* accept comma-separated paths below */ }
  }
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function resolveDir(dir, workingDir) {
  const expanded = dir.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(workingDir, expanded);
}

function discoverPlugins(dirs, workingDir) {
  const files = new Set();
  for (const configuredDir of dirs) {
    const root = resolveDir(configuredDir, workingDir);
    if (!fs.existsSync(root)) continue;
    const stat = fs.statSync(root);
    if (stat.isFile()) {
      if (/\.(?:mjs|cjs|js)$/.test(root)) files.add(root);
      continue;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && /^index\.(?:mjs|cjs|js)$/.test(entry.name)) {
        files.add(path.join(root, entry.name));
      } else if (entry.isDirectory()) {
        for (const name of ['index.js', 'index.mjs', 'index.cjs']) {
          const candidate = path.join(root, entry.name, name);
          if (fs.existsSync(candidate)) {
            files.add(candidate);
            break;
          }
        }
      }
    }
  }
  return [...files].sort();
}

/** Load trusted local plugins into a runtime's tool/provider/channel registries. */
export async function loadPlugins({ toolRegistry, config, workingDir = process.cwd() } = {}) {
  if (!(toolRegistry instanceof Map)) throw new TypeError('loadPlugins requires a tool registry Map');
  const providers = new Map();
  const channels = new Map();
  const api = {
    tools: toolRegistry,
    registerTool: (name, definition, handler, options) => registerTool(toolRegistry, name, definition, handler, options),
    registerProvider(name, factory) {
      if (!name || typeof factory !== 'function') throw new TypeError('registerProvider requires a name and factory');
      providers.set(String(name), factory);
    },
    registerChannel(name, factory) {
      if (!name || typeof factory !== 'function') throw new TypeError('registerChannel requires a name and factory');
      channels.set(String(name), factory);
    },
    providers,
    channels,
  };

  const loaded = [];
  for (const file of discoverPlugins(parseDirs(read(config, 'pluginsDirs')), workingDir)) {
    const module = await import(pathToFileURL(file).href);
    const plugin = module.default ?? module;
    if (!plugin || typeof plugin.register !== 'function') {
      throw new TypeError(`Plugin ${file} must export register(registry, config)`);
    }
    await plugin.register(api, config);
    loaded.push({ file, name: plugin.name || path.basename(path.dirname(file)) });
  }

  return { ...api, loaded };
}
