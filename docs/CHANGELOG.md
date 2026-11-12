# Changes since the last committed version

This summary compares the current worktree with the repository's last commit,
`ad95572` (`feat: add shared runtime, channel abstraction, and persistent gateway`).
The items below describe the uncommitted changes currently present in this
checkout; they are not a release record and have not been published.

## Gateway dashboard

- Added `qtpi dashboard` and an optional dashboard hosted by the gateway.
- Added local session listing, chat routing, and masked config display.
- Restricted the listener to loopback addresses and protected message posts
  with Host/Origin checks and a per-instance CSRF token.
- Sensitive tools remain rejected unless dashboard auto-approval is enabled.

## Scheduled automation

- Added cron jobs from inline configuration or a JSON jobs file, with list,
  validate, and manual run CLI commands.
- Added per-job conversation isolation, timezone and approval overrides,
  overlap protection, optional JSONL logging, timeout cancellation requests,
  and delivery through configured running channels.
- Scheduled runs share a lock with gateway conversations. Cancellation is
  best-effort for in-flight tools; the lock stays held until the run unwinds.

## Plugins and named runtimes

- Added trusted local plugin loading for tool, provider, and channel
  registrations, controlled by `pluginsDirs` / `QTPI_PLUGINS_DIR`.
- Added gateway runtime selection by exact sender ID and then channel, with
  separate workspace, memory, and sessions per named runtime.

## Trust and execution controls

- Ask mode now supplies a capability-scoped tool registry and enforces the
  same registry at execution time; tools default to write capability.
- Tool results and errors are redacted for configured secrets and common
  credential formats before they enter the model conversation.
- Added optional shell bubblewrap isolation on Linux and Chromium sandbox
  configuration via `sandboxEnabled` / `QTPI_SANDBOX_ENABLED`.
- Secret masking is shared by CLI config display and the dashboard, includes
  the Telegram token, and masks short secrets completely.
- Provider chat methods accept abort signals for timed scheduled runs.

## Integration and project maintenance

- Extended runtime and gateway initialization to load plugins asynchronously,
  support named runtimes, expose new config keys, and coordinate automation,
  channels, and the dashboard.
- Added targeted tests for dashboard, automation, plugins, security controls,
  and browser sandbox configuration; updated gateway/browser coverage.
- Added `node-cron` and documented the new operator-facing features in
  [`GATEWAY.md`](GATEWAY.md), [`PLUGINS.md`](PLUGINS.md), and
  [`SECURITY.md`](SECURITY.md).

## Review notes

- The shell sandbox requires Linux and `bwrap`; on other platforms the command
  fails closed when sandbox mode is enabled.
- A timed out operation may remain active if its current tool cannot be
  interrupted. The scheduler reports the timeout but keeps the shared agent
  slot locked until the operation exits.
- Plugins run as trusted code with the QTPi process's permissions; plugin
  capability tags do not isolate plugin execution.
- Automation output delivery requires both `channel` and `target`, and the
  named channel must be started by the gateway.

No commit or remote push is included in this summary.
