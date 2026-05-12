/**
 * MIT License
 *
 * Copyright (c) Multicorn AI Pty Ltd
 *
 * Maps Codex CLI hook tool names to Shield `service` + permission-level `actionType`
 * for `/api/v1/actions`. Built to `plugins/codex-cli/hooks/scripts/codex-cli-tool-map.cjs`.
 *
 * @module hooks/codex-cli-tool-map
 */

import { mapToolToScope, isKnownTool } from "../openclaw/tool-mapper.js";

export interface CodexCliShieldMapping {
  readonly service: string;
  /** Permission level sent as `actionType` (read | write | execute). */
  readonly actionType: string;
}

/** Bash-style destructive tokens for Codex hooks only (mirrors OpenClaw list). */
const CODEX_DESTRUCTIVE_KEYWORDS = [
  "rm",
  "mv",
  "sudo",
  "chmod",
  "chown",
  "dd",
  "truncate",
  "shred",
] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function destructiveTokenRegex(keyword: string): RegExp {
  const e = escapeRegExp(keyword);
  // Standalone shell token (not removeme, sudo-payload, rm-dir, etc.). `\b` alone treats `-` as a break, so hyphenated tokens need the negative lookahead.
  return new RegExp(`(^|[^a-zA-Z0-9_])${e}(?![a-zA-Z0-9_-])`, "i");
}

/**
 * Best-effort destructive shell classification for Codex `Bash` tool_input.command.
 * Matches destructive keywords as standalone tokens (with quote stripping so literals do not false-positive).
 * Leading `echo ...` lines without `;`, `&`, or `|` are skipped so literals such as `echo rm`
 * are not treated as destructive.
 *
 * This is a classification hint for the tool map (write vs execute), not a security enforcement
 * boundary. Shield applies the real permission decision server-side.
 */
export function codexIsDestructiveExecCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/^\s*echo\b/i.test(trimmed) && !/[;&|]/.test(trimmed)) {
    return false;
  }
  const withoutQuotes = trimmed.replace(/'[^']*'/g, " ").replace(/"([^"\\]|\\.)*"/g, " ");
  const normalized = withoutQuotes.toLowerCase();
  return CODEX_DESTRUCTIVE_KEYWORDS.some((kw) => destructiveTokenRegex(kw).test(normalized));
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
    if (cmd !== undefined && codexIsDestructiveExecCommand(cmd)) {
      return { service: "terminal", actionType: "write" };
    }
    return { service: "terminal", actionType: "execute" };
  }

  if (n === "apply_patch" || n === "edit" || n === "write") {
    return { service: "filesystem", actionType: "write" };
  }

  const scope = mapToolToScope(n);
  let actionType = scope.permissionLevel;
  /**
   * Restrictive default for Codex CLI: tools that are not OpenClaw TOOL_MAP builtins but still map
   * to execute-only (e.g. unknown MCP-style names) are bumped to write so unknown tools need write-tier consent.
   */
  if (!isKnownTool(n) && actionType === "execute") {
    actionType = "write";
  }
  return { service: scope.service, actionType };
}
