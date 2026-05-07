# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release checklist

- Bump `version` in `package.json` before publishing to npm.

## [1.3.2] - 2026-05-07

### Fixed

- Pass action cost (USD) to the backend when logging approved and spending-blocked actions via the MCP proxy. Previously cost was computed locally for spending-limit checks but never sent to the API, causing all agent spend totals to show $0.
- Add optional `cost` field to `ActionLogPayload` in `shield-client.ts` so OpenClaw plugin callers can include cost when it becomes available upstream.
- Sanitise cost values extracted from tool arguments before logging (reject negative, NaN, Infinity, and values exceeding $1M).

### Added

- Print signup URL and API key instructions before the key prompt in the CLI wizard for new users who don't yet have an account.
- Print dashboard URL at the end of the CLI wizard setup summary.
- Log a one-time "First action recorded" message with dashboard link on the first approved action in both the MCP proxy and OpenClaw plugin.

## [1.3.1] - 2026-05-07

### Fixed

- Consent screen not opening for re-created agents with the same name (stale consent marker now cleared on polling timeout)
- One-time approvals not working in Claude Code and Windsurf hooks (hook now polls approval status instead of immediately blocking when consent marker exists)

## [1.2.0] - 2026-05-06

### Added

- Agents now remember which project directory they were set up in - running `init` from different repos creates separate agents on the same platform (e.g. one Cursor agent per project)
- When a platform already has agents registered, the wizard offers to replace a specific one, add a new agent alongside them, or skip to another platform
- If the current directory already has an agent for the selected platform, the wizard detects it and offers a targeted replace prompt
- Default agent names now include the project folder (e.g. `multicorn-dashboard-cursor` instead of `cursor`)
- Extracted Claude Code tool-to-Shield mapping into dedicated module (`src/hooks/claude-code-tool-map.ts`), exported as CommonJS for hook scripts
- Updated plugin hook scripts to v1.2.0
- After API key validation, `init` may warn when the installed `multicorn-shield` is older than the version published on npm (fetch errors are ignored)

### Changed

- Claude Code path in `init` writes PreToolUse and PostToolUse command hooks to `~/.claude/settings.json` (script paths resolve via the installed `multicorn-shield` package). Marketplace and `claude plugin install` steps were removed from the wizard
- "Next steps" after setup complete only lists how to start or restart each platform (no repeated paste-into-file instructions)
- Agent resolution now picks the most specific workspace match when multiple agents share a platform - falls back to the original behaviour for existing setups
- Native hook scripts (Cline, Claude Code, Windsurf, Gemini CLI) use workspace-aware agent resolution. Claude Code hooks use `PWD` when set, then longest matching `workspacePath`, then `defaultAgent`, then the first `claude-code` agent
- Replacing an agent no longer removes all agents for that platform - only the specific one being replaced

### Fixed

- Stripe/payment tools incorrectly classified as `execute` instead of `write` in tool mapper
- If the old Claude Code plugin is still installed, `init` prints a note that hooks now live in `settings.json` and suggests `claude plugin uninstall multicorn-shield@multicorn-shield`

## [1.1.0] - 2026-05-06

### Added

- Kilo Code as a hosted proxy platform
- GitHub Copilot as a hosted proxy platform
- Continue as a hosted proxy platform
- Goose as a hosted proxy platform
- Claude Desktop as a hosted proxy platform
- Prereq check step in CLI wizard for all hosted proxy platforms
- Platform filter and search in dashboard platform select

### Changed

- GitHub Copilot moved from native plugin to hosted proxy section in CLI wizard
- Kilo Code config snippet now includes `"type": "streamable-http"`
- Goose config snippet uses `"type": "streamable_http"` and `"url"` (SSE deprecated)
- ProxySetup is now a stepped wizard (prereq check, OS selection, proxy form, snippet, completion)
- Short name prompt removed from CLI wizard (uses agent name automatically)

### Removed

- Aider as a supported platform (no MCP client support)

### Fixed

- Proxy ALLOW_PRIVATE_TARGETS env var not bypassing localhost validation
- Goose prereq URL updated (moved from Block to the Agentic AI Foundation (AAIF))
- Continue prereq URL updated
- ProxySetup form input contrast (WCAG AA fix)
- Governance disclosure now lists all four native plugin platforms

## [1.0.0] - 2026-05-02

### Changed

- CLI binary renamed from `multicorn-proxy` to `multicorn-shield`. The `multicorn-proxy` command still works but prints a deprecation warning. All user-facing documentation and dashboard references use `npx multicorn-shield`.

### Deprecated

- `multicorn-proxy` binary alias. Use `multicorn-shield` instead.

### Added

- Gemini CLI native plugin: BeforeTool/AfterTool hook scripts for full governance
- Gemini CLI hosted proxy support with httpUrl config field
- CLI wizard: Gemini CLI platform with native plugin and hosted proxy integration modes
- CLI wizard: platform prerequisite detection (warns if target platform is not installed)

## [X.Y.Z] - YYYY-MM-DD

### Added

- Cline native plugin support via PreToolUse/PostToolUse hooks
- Hook scripts for Cline: pre-tool-use.cjs, post-tool-use.cjs, shared.cjs
- Cline plugin README with setup instructions and troubleshooting
- Browser auto-open for consent screen when Shield blocks an action
- Licence headers on all plugin scripts

### Changed

- CLI wizard installs Cline hooks to ~/Documents/Cline/Hooks/ (previously ~/Documents/Cline/Rules/Hooks/)
- Cline hook reads toolName field from hook input (Cline v3.81+ sends toolName, not tool)
- Consent flow no longer polls for approval (blocks immediately with consent URL to avoid Cline's 30-second hook timeout)
- Extracted shared utilities (config loading, HTTP, tool mapping) into shared.cjs to eliminate duplication between hooks
- Parameter metadata scrubbed before sending to Shield API (file contents redacted, commands truncated)
- HTTPS enforced for non-local Shield API connections

### Removed

- Polling-based consent approval flow (replaced with immediate block + consent URL)
- Consent marker filesystem state (no longer needed without polling)

### Security

- Fixed Windows shell injection in openBrowser (replaced execSync with execFileSync)
- Added HTTPS enforcement for non-localhost baseUrl in hook config
- Added parameter and result scrubbing to prevent sensitive data leakage in audit metadata

## [0.11.0] - 2026-04-25

### Added

- `<multicorn-badge>` trust badge web component for embedding in third-party products. Shadow DOM encapsulation, dark/light themes, compact/standard sizes, optional action count display.
- CDN entrypoint (`dist/badge.js`) for single-script-tag embedding: `<script src="https://cdn.multicorn.ai/badge.js" data-agent-id="..."></script>`. Self-contained, no Lit runtime dependency.
- `MulticornBadge` class exported from the main SDK barrel for programmatic usage.
- Shared `shield-tokens.ts` module (`src/shared/`) extracting `SHIELD_COLORS` design tokens for reuse across consent and badge components.
- `size-limit` budget enforcement for `dist/badge.js` at 5 kB gzip (actual ~1.75 kB).

## [0.10.0] - 2026-04-21

### Added

- `requestContentReview()` and supporting types (`ContentReviewResult`, `ContentReviewRequestPayload`, `ContentReviewStatusResponse`) for submitting public-content actions to the Content Review queue and awaiting the human decision.
- `waitForReviewDecision` opt-in flag on `McpAdapterConfig`. When true, the MCP adapter blocks until a human approves or blocks the action (5 minute ceiling) and forwards the call if approved. Default false preserves existing block-fast behaviour.
- Public exports of `requiresContentReview` and `isPublicContentAction` from `src/scopes/content-review-detector.ts`.
- SDK-side mapping of backend `PLAN_TIER_INSUFFICIENT` responses to a distinct `plan_tier_insufficient` reason code with the "Content review requires an Enterprise plan" user message.

### Changed

- `pollContentReviewStatus` fast-fails on 404 (maps to `review_not_found`) instead of retrying, diverging from `pollApprovalStatus` which treats 404 as transient. Content reviews can be hard-deleted by admin action in a way approvals cannot.

## [0.9.0] - 2026-04-15

### Added

- Windsurf native integration via Cascade Hooks (`pre_*` / `post_*` for reads, writes, terminal, and MCP). Hook scripts install to `~/.multicorn/windsurf-hooks/` and add entries to `~/.codeium/windsurf/hooks.json`.
- `npx multicorn-shield init`: when you pick Windsurf, choose Native plugin (recommended) or Hosted proxy. Native path registers Shield hooks and reminds you to restart Windsurf.

## [0.8.0] - 2026-04-12

### Added

- Windsurf IDE as a supported platform in `npx multicorn-shield init`. Generates a proxy config and prints an `~/.codeium/windsurf/mcp_config.json` snippet using the Windsurf `mcpServers` / `serverUrl` schema.
- Auto-detection of existing Windsurf proxy entries (shows "● detected locally" in the platform selection list).

### Changed

- Next Steps block for Cursor and Windsurf rewritten as clear three-step numbered actions: download the IDE if needed, paste the config snippet, restart. Previous copy ("Config file: ...", "Restart Cursor to pick up MCP config changes") gave no guidance to first-time users.

## [0.7.0] - 2026-04-11

### Added

- New `--api-key <key>` CLI flag on `multicorn-shield --wrap`. Lets users run the proxy without first creating a config file.
- New `MULTICORN_API_KEY` environment variable support. Resolves with priority `--api-key` flag > `MULTICORN_API_KEY` env var > `~/.multicorn/config.json`.
- New "Local MCP / Other" option in the `multicorn-shield init` wizard. Skips the platform-specific setup steps and writes a minimal config suitable for wrapping any local MCP server with `--wrap`.
- SDK constructor now validates the API key format and rejects invalid keys (empty, wrong prefix, too short, or the literal placeholder `mcs_your_key_here`) with a clear error pointing at the settings page.

### Changed

- `multicorn-shield init` platform menu now labels detected platforms as "detected locally" instead of "connected", with a dimmed dot icon instead of a green checkmark. The previous label implied account-level connection state, but the underlying detection only checks for local config files.
- Error message when no API key is configured now mentions all three sources: the `--api-key` flag, the `MULTICORN_API_KEY` environment variable, and the `npx multicorn-shield init` config file path.
- All references to the API keys settings page now use the fragment URL `https://app.multicorn.ai/settings#api-keys` instead of the previous `/settings/api-keys` path which did not exist.

### Fixed

- `multicorn-shield --wrap` now fails immediately at startup with a clear error if the configured API key is rejected by the Multicorn service. Previously the proxy logged "Agent resolved" and "Proxy ready" with empty agent state and only blocked tool calls at runtime, leaving users confused about why their setup was not working.
- `multicorn-shield --wrap` now correctly accepts proxy flags (`--api-key`, `--base-url`, `--log-level`, `--dashboard-url`, `--agent-name`) when they appear between `--wrap` and the wrap command. Previously the parser bailed with "requires a command to run" because the early-exit guard rejected any flag-shaped token in that position before the stripping logic ran.
- `multicorn-shield init` exit summary no longer renders a trailing dash for the "Local MCP / Other" option (which has no agent name). The summary line now reads `✓ Local MCP / Other` instead of `✓ Local MCP / Other -`.
- `multicorn-shield init` no longer prints a misleading "Next steps" block referencing "Other MCP Agent" and `--agent-name` after the "Local MCP / Other" option. The "Try it" example printed inside the option 4 branch is sufficient guidance.

## [0.6.2] - 2026-04-09

### Fixed

- Proxy CLI `init` command now reads `baseUrl` from `~/.multicorn/config.json` on the new-key path, not just the reuse-key path. Previously required `--base-url` flag as a workaround.
- `--base-url` CLI flag correctly overrides config file value (previously indistinguishable from the default).

### Added

- `readBaseUrlFromConfig()` helper for reading base URL from partial config files.
- `parseConfigFile()` shared helper eliminating duplicated file read/parse logic between `loadConfig` and `readBaseUrlFromConfig`.
- `isAllowedShieldApiBaseUrl()` exported validator for HTTPS/localhost scheme checks.
- `DEFAULT_SHIELD_API_BASE_URL` named constant replacing hardcoded fallback string.
- HTTPS scheme validation in `runInit()` init flow (previously only enforced in wrap flow).

### Changed

- `runInit` parameter changed from `baseUrl = "https://api.multicorn.ai"` to `explicitBaseUrl?: string` to distinguish "no flag" from "explicitly passed default."
- Base URL resolution priority: explicit flag > full config > partial config > env var > default.
- HTTPS validation error messages no longer include the actual URL value.
- Wrap flow validates `--base-url` before loading config when the flag is present.

## [0.6.1] - 2026-04-08

### Fixed

- Updated README badges and npm package metadata to reflect current branding.

## [0.6.0] - 2026-04-08

### Added

- Multi-agent config support: `~/.multicorn/config.json` now stores an `agents` array with per-platform entries instead of a single `agentName`
- New CLI commands: `npx multicorn-shield agents` (list configured agents) and `npx multicorn-shield delete-agent <name>` (remove an agent)
- New exported helpers: `getAgentByPlatform()`, `getDefaultAgent()`, `collectAgentsFromConfig()`, `deleteAgentByName()`
- `AgentEntry` interface exported from the SDK
- Automatic migration: legacy single-agent configs are upgraded to the new format on first read and written back to disk
- Platform-based agent lookup in Claude Code hooks (`pre-tool-use.cjs`, `post-tool-use.cjs`), OpenClaw plugin, and Claude Desktop extension
- CLI agent name sanitisation: `delete-agent` strips non-printable characters before echoing to terminal

### Changed

- `ProxyConfig` interface now includes optional `agents` (readonly `AgentEntry[]`) and `defaultAgent` fields
- `agentName` and `platform` fields on `ProxyConfig` are deprecated (kept for backward compatibility during migration)
- `runInit()` appends to the agents array instead of overwriting; detects duplicate platforms and prompts to replace
- Restored inline OpenClaw setup flow with version detection, auto-config of `~/.openclaw/openclaw.json`, and "Next steps" instructions (`openclaw gateway restart`, `openclaw tui`)
- Restored inline Claude Code setup instructions (marketplace add, plugin install, start claude, `/plugin` verification)
- "Next steps" summary restored at end of init wizard with per-platform instructions
- Help text clarified for non-technical users ("List configured agents and show which is the default", "Remove a saved agent")
- CJS hook duplication comment updated to explain why shared modules are not possible

### Fixed

- Running `npx multicorn-shield init` for a second platform no longer overwrites the first agent's config
- `delete-agent` clears `defaultAgent` when deleting the default agent instead of leaving a dangling reference

### Security

- Agent names from CLI input are sanitised before echoing to stdout/stderr to prevent terminal escape sequence injection

## [0.5.0] - 2026-04-08

Version number skipped. The `release:minor` script double-bumped from 0.4.0 to 0.5.0 (manual) then to 0.6.0 (automated). No separate 0.5.0 release exists on npm.

## [0.4.0] - 2026-04-08

### Changed

- CLI rewrite: extracted platform selection, agent naming, and proxy config prompts into separate helper functions
- Reduced platform options from 4 (OpenClaw, Claude Code, Claude Desktop, Other MCP Agent) to 3 (OpenClaw, Claude Code, Cursor)
- Cursor connection detection via `~/.cursor/mcp.json`
- Claude Code connection detection via `~/.claude/plugins/cache/multicorn-shield`
- Cursor (selection 3) now prompts for target MCP server URL and creates a hosted proxy config via the Shield API
- Platform-specific MCP config snippets shown after proxy config creation
- "Connect another agent?" prompt changed from `(y/N)` default-no to `(Y/n)` default-yes
- Setup complete summary now shows agent names and proxy URLs alongside platform labels

### Removed

- Claude Desktop as a standalone platform option (now handled via Cursor/Other MCP path)
- "Next steps" grouped summary at end of init (replaced by inline instructions per platform)
- OpenClaw version detection and `updateOpenClawConfigIfPresent()` auto-config during init

## [0.3.0] - 2026-04-08

Version number skipped. No 0.3.0 release exists on npm.

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
