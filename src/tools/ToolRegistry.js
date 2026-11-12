
export function createRegistry() {
  const registry = new Map();
  Object.defineProperty(registry, 'secrets', { value: new Set() });
  return registry;
}



const READ_CAPABILITY_TOOLS = new Set([
  'read_file', 'list_files', 'git_status', 'git_diff', 'git_log',
  'search_code', 'find_files', 'web_search', 'web_crawl',
  'skill_list', 'skill_read', 'recall_memories', 'search_repository',
]);

export function registerTool(registry, name, definition, handler, options = {}) {
  registry.set(name, {
    definition: {
      name: name,
      description: definition.description,
      parameters: definition.parameters,
    },
    handler: handler,
    capability: options.capability || (READ_CAPABILITY_TOOLS.has(name) ? 'read' : 'write'),
  });
}

export function createCapabilityRegistry(registry, capabilities) {
  const allowed = new Set(capabilities || []);
  const scoped = new Map([...registry].filter(([, tool]) => allowed.has(tool.capability || 'write')));
  Object.defineProperty(scoped, 'secrets', { value: registry?.secrets || new Set() });
  return scoped;
}

export function addToolSecrets(registry, secrets) {
  if (!(registry?.secrets instanceof Set)) return;
  for (const secret of secrets || []) {
    if (typeof secret === 'string' && secret.length > 0) registry.secrets.add(secret);
  }
}

export function redactToolOutput(registry, value) {
  let output = String(value ?? '');
  const secrets = [...(registry?.secrets || [])].sort((a, b) => b.length - a.length);
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
  return output
    .replace(/\b(?:sk[-_](?:live|test|ant|proj)?[-_][A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED TELEGRAM TOKEN]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:[a-z0-9_-]*(?:api[_-]?key|token|secret|password|credential|private[_-]?key)|authorization)\s*[:=]\s*)(["'])([^"'\r\n]*)\2/gi, '$1$2[REDACTED]$2')
    .replace(/((?:[a-z0-9_-]*(?:api[_-]?key|token|secret|password|credential|private[_-]?key)|authorization)\s*[:=]\s*)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}


export function getToolDefinitions(registry) {
  const definitions = [];
  for (const tool of registry.values()) {
    definitions.push(tool.definition);
  }
  return definitions;
}



export async function executeTool(registry, name, args) {

  // Look up the tool
  const tool = registry.get(name);

  if (!tool) {
    const available = Array.from(registry.keys()).join(', ');
    return redactToolOutput(registry, `Error: Unknown tool "${name}". Available tools: ${available}`);
  }

  // Run the handler
  try {
    const result = await tool.handler(args);

    // Make sure the result is always a string
    if (typeof result === 'string') return redactToolOutput(registry, result);
    return redactToolOutput(registry, JSON.stringify(result, null, 2));

  } catch (error) {
    return redactToolOutput(registry, `Error executing ${name}: ${error.message}`);
  }
}
