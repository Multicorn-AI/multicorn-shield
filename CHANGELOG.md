# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
