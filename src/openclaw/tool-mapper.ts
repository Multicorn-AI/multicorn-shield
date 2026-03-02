/**
 * Maps OpenClaw tool names to Multicorn Shield service/scope pairs.
 *
 * OpenClaw has its own built-in tool names (read, write, exec, etc.) that
 * differ from MCP tool naming conventions. This module translates them into
 * the Shield permission model so the hook can check access consistently.
 *
 * Unknown tools are still governed - they map to their own name as the
 * service with "execute" permission, so nothing slips through untracked.
 *
 * @module openclaw/tool-mapper
 */

import type { PermissionLevel } from "../types/index.js";
import type { ToolScopeMapping } from "./types.js";

/**
 * Static mapping of OpenClaw built-in tools to Shield service/scope pairs.
 *
 * This uses `as const` for literal types rather than an enum (per code
 * quality rules).
 */
const TOOL_MAP: Readonly<Record<string, ToolScopeMapping>> = {
  // OpenClaw built-in tools
  read: { service: "filesystem", permissionLevel: "read" },
  write: { service: "filesystem", permissionLevel: "write" },
  edit: { service: "filesystem", permissionLevel: "write" },
  exec: { service: "terminal", permissionLevel: "execute" },
  browser: { service: "browser", permissionLevel: "execute" },
  message: { service: "messaging", permissionLevel: "write" },
  process: { service: "terminal", permissionLevel: "execute" },
  sessions_spawn: { service: "agents", permissionLevel: "execute" },
  // Common integration tools (MCP servers, skills, etc.)
  // Gmail
  gmail: { service: "gmail", permissionLevel: "execute" },
  gmail_send: { service: "gmail", permissionLevel: "write" },
  gmail_read: { service: "gmail", permissionLevel: "read" },
  // Google Calendar
  google_calendar: { service: "google_calendar", permissionLevel: "execute" },
  calendar: { service: "google_calendar", permissionLevel: "execute" },
  calendar_create: { service: "google_calendar", permissionLevel: "write" },
  calendar_read: { service: "google_calendar", permissionLevel: "read" },
  // Google Drive
  google_drive: { service: "google_drive", permissionLevel: "execute" },
  drive: { service: "google_drive", permissionLevel: "execute" },
  drive_read: { service: "google_drive", permissionLevel: "read" },
  drive_write: { service: "google_drive", permissionLevel: "write" },
  // Slack
  slack: { service: "slack", permissionLevel: "execute" },
  slack_send: { service: "slack", permissionLevel: "write" },
  slack_read: { service: "slack", permissionLevel: "read" },
  slack_message: { service: "slack", permissionLevel: "write" },
  // Payments
  payments: { service: "payments", permissionLevel: "execute" },
  payment: { service: "payments", permissionLevel: "execute" },
  stripe: { service: "payments", permissionLevel: "execute" },
} as const;

/**
 * Check if an exec command is destructive and requires write permission.
 *
 * Destructive commands include: rm, mv, sudo, chmod, chown, dd, truncate, shred.
 * These commands can modify or delete files, so they require write permission
 * instead of execute permission to ensure separate approval.
 *
 * @param command - The command string to check.
 * @returns `true` if the command is destructive.
 */
export function isDestructiveExecCommand(command: string): boolean {
  const destructiveCommands = ["rm", "mv", "sudo", "chmod", "chown", "dd", "truncate", "shred"];
  const normalized = command.toLowerCase();
  return destructiveCommands.some((destructive) => normalized.includes(destructive));
}

/**
 * Map an OpenClaw tool name to its Shield service and permission level.
 *
 * Known tools (read, write, edit, exec, browser, message, process,
 * sessions_spawn) return their predefined mapping. Unknown tools default
 * to `{ service: toolName, permissionLevel: "execute" }` so they're still
 * tracked and governed by Shield.
 *
 * For integration tools (gmail, slack, etc.), tools with prefixes like
 * "slack_send_message" map to the base service "slack".
 *
 * For exec commands, if a command string is provided and it's destructive,
 * returns terminal:write instead of terminal:execute to require separate approval.
 *
 * @param toolName - The OpenClaw tool name from the event context.
 * @param command - Optional command string for exec tool to check if destructive.
 * @returns The Shield service and permission level for this tool.
 */
export function mapToolToScope(toolName: string, command?: string): ToolScopeMapping {
  const normalized = toolName.trim().toLowerCase();

  if (normalized.length === 0) {
    return { service: "unknown", permissionLevel: "execute" as PermissionLevel };
  }

  // Check exact matches first
  const known = TOOL_MAP[normalized];
  if (known !== undefined) {
    // Special handling for exec: if command is provided and destructive, use write instead of execute
    if (normalized === "exec" && command !== undefined && isDestructiveExecCommand(command)) {
      return { service: "terminal", permissionLevel: "write" };
    }
    return known;
  }

  // Check for integration tool prefixes (e.g., "slack_send_message" -> "slack")
  const integrationPrefixes: Record<string, string> = {
    gmail: "gmail",
    google_calendar: "google_calendar",
    calendar: "google_calendar",
    google_drive: "google_drive",
    drive: "google_drive",
    slack: "slack",
    payments: "payments",
    payment: "payments",
    stripe: "payments",
  };

  for (const [prefix, service] of Object.entries(integrationPrefixes)) {
    if (normalized.startsWith(prefix + "_") || normalized === prefix) {
      // Determine permission level from tool name
      let permissionLevel: PermissionLevel = "execute";
      if (
        normalized.includes("_read") ||
        normalized.includes("_get") ||
        normalized.includes("_list")
      ) {
        permissionLevel = "read";
      } else if (
        normalized.includes("_write") ||
        normalized.includes("_send") ||
        normalized.includes("_create") ||
        normalized.includes("_update") ||
        normalized.includes("_delete")
      ) {
        permissionLevel = "write";
      }
      return { service, permissionLevel };
    }
  }

  // Unknown tool - use tool name as service
  return { service: normalized, permissionLevel: "execute" as PermissionLevel };
}

/**
 * Check whether a tool name is a known OpenClaw built-in tool.
 *
 * @param toolName - The tool name to check.
 * @returns `true` if the tool has a predefined Shield mapping.
 */
export function isKnownTool(toolName: string): boolean {
  return Object.hasOwn(TOOL_MAP, toolName.trim().toLowerCase());
}
