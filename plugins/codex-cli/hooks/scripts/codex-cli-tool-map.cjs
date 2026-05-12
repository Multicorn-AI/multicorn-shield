"use strict";

// AUTO-GENERATED from src/hooks/codex-cli-tool-map.ts — do not edit manually. Run pnpm build from the package root to regenerate.

// src/openclaw/tool-mapper.ts
var TOOL_MAP = {
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
  payments: { service: "payments", permissionLevel: "write" },
  payment: { service: "payments", permissionLevel: "write" },
  stripe: { service: "payments", permissionLevel: "write" },
};
function isDestructiveExecCommand(command) {
  const destructiveCommands = ["rm", "mv", "sudo", "chmod", "chown", "dd", "truncate", "shred"];
  const normalized = command.toLowerCase();
  return destructiveCommands.some((destructive) => normalized.includes(destructive));
}
function mapToolToScope(toolName, command) {
  const normalized = toolName.trim().toLowerCase();
  if (normalized.length === 0) {
    return { service: "unknown", permissionLevel: "execute" };
  }
  const known = TOOL_MAP[normalized];
  if (known !== void 0) {
    return known;
  }
  const integrationPrefixes = {
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
      let permissionLevel = "execute";
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
  return { service: normalized, permissionLevel: "execute" };
}

// src/hooks/codex-cli-tool-map.ts
function extractExecCommand(toolInput) {
  if (toolInput === void 0 || toolInput === null) {
    return void 0;
  }
  if (typeof toolInput === "object") {
    const o = toolInput;
    const c = o["command"];
    if (typeof c === "string") {
      return c;
    }
  }
  if (typeof toolInput === "string") {
    try {
      return extractExecCommand(JSON.parse(toolInput));
    } catch {
      return toolInput;
    }
  }
  return void 0;
}
function mapCodexCliToolToShield(toolName, toolInput) {
  const n = toolName.trim().toLowerCase();
  if (n.length === 0) {
    return { service: "unknown", actionType: "execute" };
  }
  if (n === "bash") {
    const cmd = extractExecCommand(toolInput);
    if (cmd !== void 0 && isDestructiveExecCommand(cmd)) {
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

exports.extractExecCommand = extractExecCommand;
exports.mapCodexCliToolToShield = mapCodexCliToolToShield;
