/**
 * Maps MCP tool names (stdio servers, Claude Desktop) to Shield service and permission level.
 *
 * Uses explicit tables for common MCP servers (filesystem, terminal, browser) and the same
 * integration-style prefix rules as OpenClaw's tool-mapper for names like `gmail_send_email`.
 *
 * @module mcp-tool-mapper
 */

import type { PermissionLevel } from "./types/index.js";

export interface McpToolScopeMapping {
  readonly service: string;
  readonly permissionLevel: PermissionLevel;
  /** Original tool name for audit logs. */
  readonly actionType: string;
}

/** Tools from MCP filesystem servers and common variants (read side). */
const FILESYSTEM_READ_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "read_text_file",
  "read_media_file",
  "read_multiple_files",
  "list_directory",
  "list_dir",
  "directory_tree",
  "tree",
  "get_file_info",
  "stat",
  "search_files",
  "glob_file_search",
  "list_allowed_directories",
  "file_search",
]);

/** Tools from MCP filesystem servers (write / mutate side). */
const FILESYSTEM_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "create_directory",
  "mkdir",
  "move_file",
  "rename",
  "delete_file",
  "remove_file",
  "copy_file",
]);

const TERMINAL_EXECUTE_TOOLS: ReadonlySet<string> = new Set([
  "run_terminal_cmd",
  "execute_command",
  "terminal_run",
  "run_command",
]);

const BROWSER_EXECUTE_TOOLS: ReadonlySet<string> = new Set([
  "web_fetch",
  "fetch_url",
  "browser_navigate",
  "navigate",
  "mcp_web_fetch",
]);

/**
 * Service prefixes aligned with OpenClaw `tool-mapper` integration rules.
 */
const INTEGRATION_SERVICE_BY_PREFIX: Readonly<Record<string, string>> = {
  gmail: "gmail",
  google_calendar: "google_calendar",
  calendar: "google_calendar",
  google_drive: "google_drive",
  drive: "google_drive",
  slack: "slack",
  payments: "payments",
  payment: "payments",
  stripe: "payments",
  github: "github",
  gitlab: "gitlab",
  notion: "notion",
  linear: "linear",
  jira: "jira",
};

function inferPermissionFromToolName(normalized: string): PermissionLevel {
  if (
    normalized.includes("_read") ||
    normalized.includes("_get") ||
    normalized.includes("_list") ||
    normalized.endsWith("_fetch") ||
    normalized.includes("_search")
  ) {
    return "read";
  }
  if (
    normalized.includes("_write") ||
    normalized.includes("_send") ||
    normalized.includes("_create") ||
    normalized.includes("_update") ||
    normalized.includes("_delete") ||
    normalized.includes("_push") ||
    normalized.includes("_commit") ||
    normalized.includes("_post") ||
    normalized.includes("_patch")
  ) {
    return "write";
  }
  return "execute";
}

/**
 * Maps an MCP `tools/call` tool name to Shield `service` + `permissionLevel` for scope checks.
 */
export function mapMcpToolToScope(toolName: string): McpToolScopeMapping {
  const actionType = toolName.trim();
  const normalized = actionType.toLowerCase();

  if (normalized.length === 0) {
    return { service: "unknown", permissionLevel: "execute", actionType };
  }

  if (FILESYSTEM_READ_TOOLS.has(normalized)) {
    return { service: "filesystem", permissionLevel: "read", actionType };
  }
  if (FILESYSTEM_WRITE_TOOLS.has(normalized)) {
    return { service: "filesystem", permissionLevel: "write", actionType };
  }
  if (TERMINAL_EXECUTE_TOOLS.has(normalized)) {
    return { service: "terminal", permissionLevel: "execute", actionType };
  }
  if (BROWSER_EXECUTE_TOOLS.has(normalized)) {
    return { service: "browser", permissionLevel: "execute", actionType };
  }

  // OpenClaw-style single-token tools (rare in MCP, but cheap to support)
  if (normalized === "read") {
    return { service: "filesystem", permissionLevel: "read", actionType };
  }
  if (normalized === "write" || normalized === "edit") {
    return { service: "filesystem", permissionLevel: "write", actionType };
  }
  if (normalized === "exec") {
    return { service: "terminal", permissionLevel: "execute", actionType };
  }

  // git_* → git service
  if (normalized.startsWith("git_")) {
    const permissionLevel = inferPermissionFromToolName(normalized);
    return { service: "git", permissionLevel, actionType };
  }

  // Integration prefixes (gmail_send_email, slack_read_channels, …)
  for (const [prefix, service] of Object.entries(INTEGRATION_SERVICE_BY_PREFIX)) {
    if (normalized.startsWith(`${prefix}_`) || normalized === prefix) {
      const permissionLevel = inferPermissionFromToolName(normalized);
      return { service, permissionLevel, actionType };
    }
  }

  // Underscore split: first segment as service, infer level from remainder
  const idx = normalized.indexOf("_");
  if (idx === -1) {
    return { service: normalized, permissionLevel: "execute", actionType };
  }

  const head = normalized.slice(0, idx);
  const tail = normalized.slice(idx + 1);
  let permissionLevel: PermissionLevel = "execute";
  if (
    tail.includes("read") ||
    tail.includes("list") ||
    tail.includes("get") ||
    tail.includes("search") ||
    tail.includes("fetch")
  ) {
    permissionLevel = "read";
  } else if (
    tail.includes("write") ||
    tail.includes("send") ||
    tail.includes("create") ||
    tail.includes("update") ||
    tail.includes("delete") ||
    tail.includes("remove")
  ) {
    permissionLevel = "write";
  }

  return { service: head, permissionLevel, actionType };
}
