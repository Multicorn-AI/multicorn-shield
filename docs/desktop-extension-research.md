# Desktop Extension (.mcpb) research spike

Research notes for the Claude Desktop Extension (.mcpb): four design questions answered before implementation. Sources: Anthropic Desktop Extensions article, open MCPB manifest spec (`anthropics/dxt` MANIFEST.md), and the multicorn-shield codebase.

## (1) Can a .mcpb extension act as a proxy or wrapper for other MCP servers?

Not as transport-layer middleware. A Desktop Extension is one MCP server process that Claude Desktop launches over stdio. The format does not define a way to sit in front of other MCP servers at the host level.

The extension can still behave like a proxy by:

- Reading the user's Claude Desktop MCP configuration from disk (paths already used in this repo for wizard flows).
- Spawning those MCP servers as child processes with stdio pipes.
- Implementing `tools/list` by merging child responses and `tools/call` by routing to the correct child after permission checks.

So the bundle is a standalone MCP server that multiplexes child servers, not a plugin that rewrites Claude Desktop's transport to existing servers.

## (2) How does the extension discover which other MCP servers the user has installed?

The MCPB manifest and Claude Desktop do not expose an API for "list other extensions" or "read merged MCP config" to the running server.

Practical discovery is reading `claude_desktop_config.json` (or equivalent) from the known OS paths at runtime. The Node-based server can use `fs` like any local process.

Optional future path: users register targets in the Multicorn dashboard (hosted proxy config). That is extra setup and not required for the local config file approach.

## (3) Can the manifest collect the Shield API key via `user_config`?

Yes. Declare a `user_config` field with `type: "string"`, `sensitive: true`, and `required: true`. Claude Desktop prompts on first enable, stores the value in the OS secret store, and substitutes `${user_config.<key>}` into `mcp_config` env or args. Sensitive values should not be written to project JSON on disk by the extension itself.

## (4) What happens when the extension is disabled?

Claude Desktop stops starting that MCP server. Tools exposed only through the extension disappear from the client.

Other MCP entries that still exist in `claude_desktop_config.json` are unchanged on disk unless the user edited them during onboarding. To make disable and uninstall safe, Shield backs up the `mcpServers` object before relying on wrapped behaviour and ships a `restore` CLI that writes the backup back into `claude_desktop_config.json`. See the README Desktop Extension section.

## Tooling note

Run `npx @anthropic-ai/mcpb init` to generate a manifest baseline. The CLI currently emits `manifest_version` **0.2** (verify on upgrade). Use `mcpb validate` and `mcpb pack` for the bundle; do not hand-roll the zip format.
