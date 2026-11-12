# Security controls

## Ask mode

Tools have a capability tag. Tools default to `write`, including plugin tools.
Ask mode gives the agent a registry containing only tools tagged `read`; the
same scoped registry is used for execution, so an unsolicited call to a hidden
tool is rejected before approval or handler execution. The default read-only
tool names are listed in `src/tools/ToolRegistry.js`.

## Tool output redaction

Tool results and tool errors pass through a shared redactor before they enter
the agent conversation. It removes configured provider, search, Qdrant, and
Telegram secrets; common API token formats; bearer credentials; labeled secret
assignments; and PEM private key blocks.

## Optional execution sandbox

`QTPI_SANDBOX_ENABLED=true` enables Chromium's sandbox and runs shell commands
inside bubblewrap (`bwrap`) on Linux. The shell sandbox disables networking,
mounts the host filesystem read-only, and allows writes in the configured
project workspace and a temporary filesystem. Bubblewrap must be installed.
On other platforms shell execution fails closed while sandboxing is enabled.
The default is `false` to preserve existing behavior. This is an optional
execution restriction, not a general process/container isolation boundary.

## Control UI

The dashboard accepts only loopback host values, checks the request Host and
Origin, and requires the CSRF token embedded in the locally served page for
message posts. `/api/config` masks configured API keys and tokens. These checks
reduce cross-origin and accidental network exposure; keep the dashboard on a
trusted local machine and leave sensitive-tool auto-approval disabled unless
you intentionally trust the dashboard session.

## Plugins

Plugins are trusted executable JavaScript loaded into the QTPi process. They
can use the process's filesystem and network permissions; capability tags do
not sandbox plugin code. Load only plugins you trust.

## Scheduled jobs

Scheduled jobs reject sensitive tools by default. Enabling job-level or global
auto-approval grants those tools permission to execute without an interactive
confirmation. Timeouts request cancellation from supported providers, but a
tool already running may continue until it finishes; QTPi keeps the shared
agent locked until the run unwinds.
