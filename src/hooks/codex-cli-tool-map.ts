/**
 * Maps Codex CLI hook tool names to Shield `service` + permission-level `actionType`
 * for `/api/v1/actions`. Exported as CommonJS for use by Codex CLI hook scripts
 * (`plugins/codex-cli/hooks/scripts/codex-cli-tool-map.cjs`).
 *
 * Currently only `Bash` is emitted by Codex hooks. `apply_patch`/`Edit`/`Write`
 * and MCP tools (`mcp__*`) are documented but not yet intercepted by Codex.
 *
 * @module hooks/codex-cli-tool-map
 */

import { mapToolToScope, isDestructiveExecCommand } from "../openclaw/tool-mapper.js";

export interface CodexCliShieldMapping {
  readonly service: string;
  /** Permission level sent as `actionType` (read | write | execute). */
  readonly actionType: string;
}

/**
 * Extract the shell command from Codex CLI Bash `tool_input`.
 * Codex always sends `{ command: "..." }` for Bash hooks.
 */
export function extractExecCommand(toolInput: unknown): string | undefined {
  if (toolInput === undefined || toolInput === null) {
    return undefined;
  }
  if (typeof toolInput === "object") {
    const o = toolInput as Record<string, unknown>;
    const c = o["command"];
    if (typeof c === "string") {
      return c;
    }
  }
  if (typeof toolInput === "string") {
    try {
      return extractExecCommand(JSON.parse(toolInput) as unknown);
    } catch {
      return toolInput;
    }
  }
  return undefined;
}

/**
 * Map a Codex CLI PreToolUse / PostToolUse tool name to Shield audit/permission fields.
 *
 * Currently only `Bash` is intercepted. `apply_patch`/`Edit`/`Write` and
 * `mcp__*` mappings are included for forward compatibility.
 */
export function mapCodexCliToolToShield(
  toolName: string,
  toolInput?: unknown,
): CodexCliShieldMapping {
  const n = toolName.trim().toLowerCase();
  if (n.length === 0) {
    return { service: "unknown", actionType: "execute" };
  }

  if (n === "bash") {
    const cmd = extractExecCommand(toolInput);
    if (cmd !== undefined && isDestructiveExecCommand(cmd)) {
      return { service: "terminal", actionType: "write" };
    }
    return { service: "terminal", actionType: "execute" };
  }

  // Future: apply_patch / Edit / Write (not intercepted by Codex hooks yet)
  if (n === "apply_patch" || n === "edit" || n === "write") {
    return { service: "filesystem", actionType: "write" };
  }

  const scope = mapToolToScope(n);
  return { service: scope.service, actionType: scope.permissionLevel };
}
