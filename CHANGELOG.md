# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-04-08

### Added

- Cursor platform support in CLI proxy setup (`npx multicorn-proxy init`)
- Hosted proxy onboarding flow: agent name, target MCP server URL, short name, and config snippet output
- Multi-agent setup loop: connect multiple agents in a single init session
- Platform-specific setup instructions for OpenClaw, Claude Code, and Cursor
- URL validation on target MCP server input
- HTTPS enforcement on Shield API base URL (with localhost exception)
- ANSI escape sequence stripping on server error messages
- JSDoc comments on all exported CLI functions

### Changed

- CLI platform menu now shows OpenClaw, Claude Code, and Cursor (previously OpenClaw, Claude Code, Claude Desktop, Other MCP Agent)
- Refactored `runInit` into smaller focused functions
- Improved prompt wording for non-native English speakers
- API key no longer printed in config snippets (replaced with placeholder)
- Error messages now include actionable guidance

### Removed

- Claude Desktop and Other MCP Agent options from CLI platform menu
- `detectOpenClaw` and `isVersionAtLeast` functions (platform detection now via API, version gating server-side)
- Local proxy wrapping flow from `init` command

## [0.2.2] - 2026-04-04

### Added

- Claude Desktop Extension (.mcpb) for one-click install. Packages Shield as a Desktop Extension that wraps existing MCP servers, enforces permissions via the Shield API, and logs all tool calls.
- `npx multicorn-shield restore` command to recover original MCP server config after disabling the extension.
- `multicorn-shield/proxy` subpath export with interceptor helpers, consent utilities, logger, scope validator, and tool mapper for hosted proxy consumers.
- HTTP client for hosted proxy URLs (`proxy-client`) supporting Streamable HTTP transport, session management, and JSON-RPC error handling.
- Optional extension setting `base_url` (env `MULTICORN_BASE_URL`) for enterprise or self-hosted Shield API endpoints. Defaults to `https://api.multicorn.ai` when empty.

### Changed

- Desktop Extension routes tool calls to hosted proxy URLs over Streamable HTTP instead of spawning child MCP processes locally. Permission enforcement and audit logging now run server-side, avoiding sandbox limits in Claude Desktop.
- `runInit` base URL resolution checks config file and `MULTICORN_BASE_URL` env var before falling back to the default API endpoint.
- `platform` field threaded through proxy config and CLI init flow for connection method tracking in the dashboard.

## [0.2.1] - 2026-03-23

### Security

- Claude Code PreToolUse hook now fails closed when the Shield API is unreachable or returns an error. Previously, all error paths exited with code 0 (allow). Now, any error after config is successfully loaded exits with code 2 (block). This matches the fail-closed behaviour of the OpenClaw plugin and MCP proxy since v0.1.15.

## [0.2.0] - 2026-03-22

### Added

- Claude Code plugin: PreToolUse hook intercepts tool calls and checks permissions via Shield API before allowing execution
- Claude Code plugin: PostToolUse hook logs completed tool calls to Shield audit trail
- Claude Code plugin: consent screen opens in browser on first tool call for new agents, polls for approval
- Claude Code plugin: consent marker file prevents repeated browser opens after initial consent
- Claude Desktop: CLI wizard auto-writes `claude_desktop_config.json` with MCP proxy config (macOS, Linux, Windows paths)
- Claude Desktop: wizard prompts for MCP server command and merges config without clobbering existing entries
- MCP proxy: comprehensive tool name mapper with explicit mappings for filesystem, git, web, terminal, email, and calendar MCP servers
- CLI wizard: "connected" checkmark for Claude Code and Claude Desktop in platform selection menu
- CLI wizard: Step 3 added to Claude Code output ("Start Claude Code: claude")
- Agent name validation: must match /^[a-zA-Z0-9_-]+$/ before use in config files
- `shell` tool name mapping to terminal:execute in Claude Code hook (covers Claude Code's Shell tool variant)

### Changed

- Claude Desktop wizard path now auto-writes config instead of showing manual JSON snippet (falls back to manual on invalid JSON or user skip)
- MCP proxy tool mapping replaced: `extractServiceFromToolName`/`extractActionFromToolName` underscore-split replaced with explicit `mapMcpToolToScope` lookup table
- `isClaudeDesktopConnected` uses proper args array inspection instead of substring match on serialized JSON

### Fixed

- Claude Code plugin install: removed `skills` array from plugin.json that caused validation error on `claude plugin install`
- Claude Code consent flow: consent screen only opens once per agent (not per scope), subsequent permission requests block with approvals link
- Claude Code hook: localhost:8080 API base URL correctly maps to localhost:5173 dashboard URL for consent and approvals links
- MCP proxy: filesystem server tools (read_file, write_file, list_directory, etc.) now correctly map to filesystem:read/write instead of garbage service names

## [0.1.16] - 2026-03-21

### Added

- Claude Code marketplace manifest at `.claude-plugin/marketplace.json`
- Claude Code plugin structure at `plugins/multicorn-shield/` with plugin.json and shield-governance skill
- Repository field added to marketplace.json linking to GitHub source

## [0.1.15] - 2026-03-13

### Changed

- All proxy and plugin failure modes now fail closed (block action when Shield cannot verify permissions)
- `handleHttpError` returns `shouldBlock: true` for 429 (rate limit) and 5xx (server error), matching the existing `checkActionPermission` behavior and fixing misleading comments
- Service-unreachable, auth-error, and internal-error responses use distinct JSON-RPC error codes: -32000 (permission denied), -32002 (internal error), -32003 (service unreachable), -32004 (auth error)
- Plugin output filename changed from `index.js` to `multicorn-shield.js` to fix OpenClaw plugin ID mismatch warning

### Added

- `ShieldAuthError` class for clean 401/403 error propagation through `resolveAgentRecord`
- `buildInternalErrorResponse`, `buildServiceUnreachableResponse`, and `buildAuthErrorResponse` in interceptor module
- Early auth-invalid and offline-mode guards at the top of `handleToolCall` (before scope validation)
- `authInvalid` flag on `AgentRecord` for propagating auth failures from consent module to proxy
- `proxy.fail-closed.test.ts` covering service-down, timeout, 500, malformed JSON, 401, 403, and internal error scenarios
- `plugin.fail-closed.test.ts` covering exception handling, 5xx responses, and malformed response blocking

### Fixed

- Proxy `handleToolCall` no longer hangs or returns wrong error code when service is unreachable at startup
- `findAgentByName` wraps `response.json()` in try/catch so malformed responses flow through the offline path instead of throwing unhandled rejections
- Existing test assertions updated to match new error codes (-32003 for service unreachable, -32004 for auth errors)

## [0.1.14] - 2026-03-12

### Fixed

- Audit log payload column uses `text` instead of `jsonb` to preserve SHA-256 hash chain integrity (PostgreSQL `jsonb` normalizes key ordering and whitespace)
- `Instant.toString()` timestamp precision preserved using `DateTimeFormatter` with `SSSSSS` pattern in `AuditHasher.formatTimestamp()`
- All 40 integration tests passing after audit log migration (V030)

## [0.1.13] - 2026-03-10

### Fixed

- Consent screen now pre-selects the permission level the agent actually requested (e.g. terminal:execute pre-selects the Execute button)
- Scope param parsing supports both formats: service:permission (terminal:execute) and permission:service (execute:terminal)
- deriveDashboardUrl respects MULTICORN_BASE_URL env var for local development instead of always resolving to production
- Plugin re-checks permission after consent completes in the blocked path, so the user doesn't have to trigger a second tool call

## [0.1.12] - 2026-03-10

(version bump only - failed publish on 0.1.11)

## [0.1.11] - 2026-03-10

### Fixed

- Approval flow: plugin correctly handles consent-then-permission-check sequence
- Flaky tests stabilised across handler, plugin, proxy blocking, and edge-case suites

## [0.1.10] - 2026-03-05

### Fixed

- Plugin fail mode now defaults to closed (block on API error, never fail open)
- approval_id field name corrected from camelCase to snake_case to match backend API
- Plugin beforeToolCall wrapped in try/catch so errors block instead of crashing silently
- Config cascade documented: ~/.multicorn/config.json takes priority over openclaw.json plugin env

## [0.1.9] - 2026-03-04

### Fixed

- API key resolution from config.json when openclaw.json env block is not available

## [0.1.8] - 2026-03-04

### Fixed

- Plugin correctly maps destructive exec commands (rm, mv, sudo, chmod) to terminal:write instead of terminal:execute
- Approval descriptions now show human-readable summaries instead of raw shell commands
- Agent polling removed in favour of immediate block with dashboard redirect (OpenClaw hook timeout was shorter than human approval time)

## [0.1.7] - 2026-03-04

### Added

- README header SVG banner

### Changed

- Consent flow updated for OpenClaw Plugin API (replaces deprecated gateway hook approach)

### Fixed

- Handler and plugin consent test alignment with new Plugin API structure

## [0.1.6] - 2026-03-04

### Added

- Comprehensive plugin test suite for beforeToolCall and afterToolCall hooks

### Fixed

- Plugin registration and lifecycle handling with OpenClaw Plugin API

## [0.1.5] - 2026-03-04

### Fixed

- Test stability improvements across the full suite

### Changed

- Package metadata updates for npm listing

## [0.1.4] - 2026-03-04

### Changed

- MCP proxy improved for edge cases in tool call interception

### Fixed

- Proxy test reliability

## [0.1.3] - 2026-03-04

### Added

- Shield API client (shield-client.ts) for permission checks and action logging from the plugin
- Consent flow module with browser-open and polling for user authorization
- OpenClaw Plugin API integration (beforeToolCall/afterToolCall hooks)
- Tool name mapper: OpenClaw tools (exec, read, write, browser, message) mapped to Shield service scopes
- Hook documentation (HOOK.md)

### Fixed

- OpenClaw integration issues discovered during end-to-end testing

## [0.1.2] - 2026-03-04

(version bump only - testing OIDC trusted publishing workflow)

## [0.1.1] - 2026-03-04

### Fixed

- Plugin loading path resolution for OpenClaw

### Changed

- Publish workflow switched to OIDC trusted publishing via GitHub Actions

## [0.1.0] - 2026-02-18

### Added

- Consent screen web component with Shadow DOM isolation, focus trapping, and keyboard navigation
- Scope system with hierarchical definitions, parsing, and validation
- Action logger for audit-trail recording of agent activity
- Spending controls with per-agent and per-scope limit checking
- MCP protocol adapter for Model Context Protocol integration
- TypeScript strict mode with full type safety across all modules
- ESM and CJS dual-format builds via tsup
- Full test suite with >85% coverage thresholds
