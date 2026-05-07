'use strict';

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
  payments: { service: "payments", permissionLevel: "execute" },
  payment: { service: "payments", permissionLevel: "execute" },
  stripe: { service: "payments", permissionLevel: "execute" }
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
    stripe: "payments"
  };
  for (const [prefix, service] of Object.entries(integrationPrefixes)) {
    if (normalized.startsWith(prefix + "_") || normalized === prefix) {
      let permissionLevel = "execute";
      if (normalized.includes("_read") || normalized.includes("_get") || normalized.includes("_list")) {
        permissionLevel = "read";
      } else if (normalized.includes("_write") || normalized.includes("_send") || normalized.includes("_create") || normalized.includes("_update") || normalized.includes("_delete")) {
        permissionLevel = "write";
      }
      return { service, permissionLevel };
    }
  }
  return { service: normalized, permissionLevel: "execute" };
}

// src/hooks/claude-code-tool-map.ts
function extractExecCommand(toolInput) {
  if (toolInput === void 0 || toolInput === null) {
    return void 0;
  }
  if (typeof toolInput === "string") {
    try {
      return extractExecCommand(JSON.parse(toolInput));
    } catch {
      return toolInput;
    }
  }
  if (typeof toolInput === "object") {
    const o = toolInput;
    const c = o["command"] ?? o["cmd"];
    if (typeof c === "string") {
      return c;
    }
  }
  return void 0;
}
function mapClaudeCodeToolToShield(toolName, toolInput) {
  const n = toolName.trim().toLowerCase();
  if (n.length === 0) {
    return { service: "unknown", actionType: "execute" };
  }
  if (n === "bash" || n === "shell") {
    const cmd = extractExecCommand(toolInput);
    if (cmd !== void 0 && isDestructiveExecCommand(cmd)) {
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

exports.extractExecCommand = extractExecCommand;
exports.mapClaudeCodeToolToShield = mapClaudeCodeToolToShield;
