# Plugins

QTPi loads trusted JavaScript plugins from `pluginsDirs` during runtime startup.
Set `QTPI_PLUGINS_DIR` to a comma-separated list, or configure the key as an
array. Each configured directory can contain `index.js`/`index.mjs` plugins or
subdirectories with their own `index.js`, `index.mjs`, or `index.cjs` entry.
Plugins are executable code and run with the permissions of the QTPi process.

A plugin exports a `register(registry, config)` function (as a named export or
the `register` member of its default export):

```js
export default {
  name: 'example',
  register(registry, config) {
    registry.registerTool('hello', {
      description: 'Return a greeting',
      parameters: { type: 'object', properties: {} },
    }, async () => 'hello');

    registry.registerProvider('example-provider', ({ model }) => ({
      name: 'example-provider', model,
      async chat() { return { content: 'hello', toolCalls: [] }; },
    }));

    registry.registerChannel('example-channel', (options) => createChannel(options));
  },
};
```

The registry exposes `tools`, `registerTool`, `registerProvider`,
`registerChannel`, and the `providers` and `channels` maps. Provider factories
receive `{ config, providerName, apiKey, model }`. Channel factories are called
with the channel-specific options and are checked against the standard channel
contract.

## Named gateway runtimes

The optional `agents` config value accepts objects with `name`, `workspace`,
`channels`, and `senders` fields. `senders` is checked first for exact sender ID
matches; otherwise the first runtime listing the incoming channel is selected.
Unmatched traffic uses the first configured runtime. Each runtime has its own
agent, workspace-backed long-term memory, and per-sender conversation sessions.

```json
{
  "agents": [
    { "name": "personal", "workspace": "./personal", "senders": ["123"] },
    { "name": "team", "workspace": "./team", "channels": ["telegram"] }
  ]
}
```
