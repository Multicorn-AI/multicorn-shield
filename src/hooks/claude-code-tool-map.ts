/**
 * Maps Claude Code hook tool names to Shield `service` + permission-level `actionType`
 * for `/api/v1/actions`. Exported as CommonJS for use by Claude Code hook scripts
 * (`plugins/multicorn-shield/hooks/scripts/claude-code-tool-map.cjs`).
 *
 * @module hooks/claude-code-tool-map
 */

import { mapToolToScope, isDestructiveExecCommand } from "../openclaw/tool-mapper.js";

export interface ClaudeCodeShieldMapping {
  readonly service: string;
  /** Permission level sent as `actionType` (read | write | execute). */
  readonly actionType: string;
}

/**
 * Pull a shell command string from Claude Code bash/shell `tool_input` when present.
 */
export function extractExecCommand(toolInput: unknown): string | undefined {
  if (toolInput === undefined || toolInput === null) {
    return undefined;
  }
  if (typeof toolInput === "string") {
    try {
      return extractExecCommand(JSON.parse(toolInput) as unknown);
    } catch {
      process.stderr.write("Shield: failed to parse tool input as JSON, using raw string\n");
      return toolInput;
    }
  }
  if (typeof toolInput === "object") {
    const o = toolInput as Record<string, unknown>;
    const c = o["command"] ?? o["cmd"];
    if (typeof c === "string") {
      return c;
    }
  }
  return undefined;
}

/**
 * Map a Claude Code PreToolUse / PostToolUse tool name to Shield audit/permission fields.
 * Aligns with {@link mapToolToScope} for shared tools; adds Claude-specific aliases (`bash`, `shell`, …).
 */
export function mapClaudeCodeToolToShield(
  toolName: string,
  toolInput?: unknown,
): ClaudeCodeShieldMapping {
  const n = toolName.trim().toLowerCase();
  if (n.length === 0) {
    return { service: "unknown", actionType: "execute" };
  }

  if (n === "bash" || n === "shell") {
    const cmd = extractExecCommand(toolInput);
    if (cmd !== undefined && isDestructiveExecCommand(cmd)) {
      return { service: "terminal", actionType: "write" };
    }
    return { service: "terminal", actionType: "execute" };
  }

  if (n === "glob" || n === "grep") {
    return { service: "filesystem", actionType: "read" };
  }

  if (n === "webfetch") {
    return { service: "web", actionType: "read" };
  }

  if (n === "task") {
    return { service: "subagent", actionType: "execute" };
  }

  const scope = mapToolToScope(n);
  return { service: scope.service, actionType: scope.permissionLevel };
}
