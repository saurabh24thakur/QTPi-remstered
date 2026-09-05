
export function createRegistry() {
  return new Map();
}



export function registerTool(registry, name, definition, handler) {
  registry.set(name, {
    definition: {
      name: name,
      description: definition.description,
      parameters: definition.parameters,
    },
    handler: handler,
  });
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
    return `Error: Unknown tool "${name}". Available tools: ${available}`;
  }

  // Run the handler
  try {
    const result = await tool.handler(args);

    // Make sure the result is always a string
    if (typeof result === 'string') return result;
    return JSON.stringify(result, null, 2);

  } catch (error) {
    return `Error executing ${name}: ${error.message}`;
  }
}