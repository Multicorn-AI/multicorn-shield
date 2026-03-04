/**
 * Multicorn Shield plugin for OpenClaw.
 *
 * Registers `before_tool_call` and `after_tool_call` lifecycle hooks
 * via the Plugin API to intercept every tool call the agent makes.
 *
 * - before_tool_call: checks permissions and blocks unauthorized actions
 * - after_tool_call: logs activity to the Shield dashboard (fire-and-forget)
 *
 * Configuration is read from (in priority order):
 * 1. Plugin config (plugins.entries.multicorn-shield.env in openclaw.json)
 * 2. Process environment variables
 * 3. Hooks config fallback (hooks.internal.entries.multicorn-shield.env in openclaw.json)
 *
 * Environment variables:
 * - MULTICORN_API_KEY (required)
 * - MULTICORN_BASE_URL (default: https://api.multicorn.ai)
 * - MULTICORN_AGENT_NAME (override, default: derived from session key)
 * - MULTICORN_FAIL_MODE (open | closed, default: open)
 *
 * @module openclaw/plugin
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
  PluginLogger,
} from "../plugin-sdk.types.js";
import { mapToolToScope } from "../tool-mapper.js";
import { loadCachedScopes, saveCachedScopes } from "../scope-cache.js";
import {
  findOrRegisterAgent,
  fetchGrantedScopes,
  logAction,
  checkActionPermission,
  pollApprovalStatus,
  type AgentRecord,
} from "../shield-client.js";
import { waitForConsent } from "../consent.js";
import type { Scope } from "../../types/index.js";

// ---------------------------------------------------------------------------
// In-memory state (persists across hook invocations within a gateway session)
// ---------------------------------------------------------------------------

let agentRecord: AgentRecord | null = null;
let grantedScopes: readonly Scope[] = [];
let consentInProgress = false;
let lastScopeRefresh = 0;
let pluginLogger: PluginLogger | null = null;
let pluginConfig: Record<string, unknown> | undefined;
let connectionLogged = false;

const SCOPE_REFRESH_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface ShieldConfig {
  apiKey: string;
  baseUrl: string;
  agentName: string | null;
  failMode: "open" | "closed";
}

/**
 * Read config from plugin config (openclaw.json), then env vars, then hooks config as fallback.
 */
function readConfig(): ShieldConfig {
  const pc = pluginConfig ?? {};
  let resolvedApiKey = asString(pc["apiKey"]) ?? process.env["MULTICORN_API_KEY"] ?? "";
  let resolvedBaseUrl = asString(pc["baseUrl"]) ?? process.env["MULTICORN_BASE_URL"] ?? "";

  // Fallback: read from hooks.internal.entries if plugin config and env vars are both empty
  if (!resolvedApiKey) {
    try {
      const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
      const configContent = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(configContent) as Record<string, unknown>;
      const hooks = config["hooks"] as Record<string, unknown> | undefined;
      const internal = hooks?.["internal"] as Record<string, unknown> | undefined;
      const entries = internal?.["entries"] as Record<string, unknown> | undefined;
      const shieldEntry = entries?.["multicorn-shield"] as
        | { env?: Record<string, unknown> }
        | undefined;
      const env = shieldEntry?.env;

      if (env) {
        const hookApiKey = asString(env["MULTICORN_API_KEY"]);
        const hookBaseUrl = asString(env["MULTICORN_BASE_URL"]);

        if (hookApiKey) {
          resolvedApiKey = hookApiKey;
          resolvedBaseUrl = resolvedBaseUrl || (hookBaseUrl ?? "https://api.multicorn.ai");
          pluginLogger?.warn(
            "Multicorn Shield: Reading config from hooks.internal.entries. For cleaner setup, set MULTICORN_API_KEY as a system environment variable.",
          );
        } else if (hookBaseUrl) {
          resolvedBaseUrl = resolvedBaseUrl || hookBaseUrl;
        }
      }
    } catch {
      // Config file not readable or doesn't exist — will be caught by empty apiKey check below
    }
  }

  if (!resolvedBaseUrl) {
    resolvedBaseUrl = "https://api.multicorn.ai";
  }

  const agentName = asString(pc["agentName"]) ?? process.env["MULTICORN_AGENT_NAME"] ?? null;
  const failModeRaw = asString(pc["failMode"]) ?? process.env["MULTICORN_FAIL_MODE"] ?? "open";
  const failMode = failModeRaw === "closed" ? "closed" : "open";
  return { apiKey: resolvedApiKey, baseUrl: resolvedBaseUrl, agentName, failMode };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Derive the agent name from the session key or env override.
 *
 * Session keys look like "agent:main:main". We extract the second
 * segment as the agent name, or fall back to "openclaw".
 */
function resolveAgentName(sessionKey: string, envOverride: string | null): string {
  if (envOverride !== null && envOverride.trim().length > 0) {
    return envOverride.trim();
  }

  const parts = sessionKey.split(":");
  const name = parts[1];
  if (name !== undefined && name.trim().length > 0) {
    return name.trim();
  }

  return "openclaw";
}

// ---------------------------------------------------------------------------
// Agent + scope resolution
// ---------------------------------------------------------------------------

type AgentReadiness = "ready" | "skip" | "block";

async function ensureAgent(
  agentName: string,
  apiKey: string,
  baseUrl: string,
  failMode: "open" | "closed",
): Promise<AgentReadiness> {
  // Already initialized and scopes are fresh
  if (agentRecord !== null && Date.now() - lastScopeRefresh < SCOPE_REFRESH_INTERVAL_MS) {
    return "ready";
  }

  // Try to load cached scopes first (fast, offline-resilient)
  if (agentRecord === null) {
    const cached = await loadCachedScopes(agentName);
    if (cached !== null && cached.length > 0) {
      grantedScopes = cached;
      // Still need the agent record for logging, but don't block on it
      void findOrRegisterAgent(agentName, apiKey, baseUrl, pluginLogger ?? undefined).then(
        (record) => {
          if (record !== null) agentRecord = record;
        },
      );
      lastScopeRefresh = Date.now();
      return "ready";
    }
  }

  // Register or find the agent
  if (agentRecord === null) {
    const record = await findOrRegisterAgent(agentName, apiKey, baseUrl, pluginLogger ?? undefined);
    if (record === null) {
      if (failMode === "closed") {
        return "block";
      }
      pluginLogger?.warn("Could not reach Shield API. Running without permission checks.");
      return "skip";
    }
    agentRecord = record;
  }

  // Refresh scopes from the API
  const scopes = await fetchGrantedScopes(
    agentRecord.id,
    apiKey,
    baseUrl,
    pluginLogger ?? undefined,
  );
  grantedScopes = scopes;
  lastScopeRefresh = Date.now();

  if (scopes.length > 0) {
    await saveCachedScopes(agentName, agentRecord.id, scopes).catch(() => {
      // Cache write failure is non-fatal
    });
  }

  // Log connection success once per session
  if (!connectionLogged) {
    connectionLogged = true;
    pluginLogger?.info(`Multicorn Shield connected. Agent: ${agentName}`);
  }

  return "ready";
}

async function ensureConsent(
  agentName: string,
  apiKey: string,
  baseUrl: string,
  scope?: { service: string; permissionLevel: string },
): Promise<void> {
  if (grantedScopes.length > 0 || consentInProgress || agentRecord === null) return;

  consentInProgress = true;
  try {
    const scopes = await waitForConsent(
      agentRecord.id,
      agentName,
      apiKey,
      baseUrl,
      scope,
      pluginLogger ?? undefined,
    );
    grantedScopes = scopes;
    await saveCachedScopes(agentName, agentRecord.id, scopes).catch(() => {
      // Cache write failure is non-fatal
    });
  } finally {
    consentInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Description builder
// ---------------------------------------------------------------------------

/**
 * Build a human-readable description for an approval request.
 *
 * Formats tool arguments with priority ordering: important keys (path, command, etc.)
 * appear first, followed by other keys. Internal/noise keys are skipped.
 * The description is truncated at 200 characters to fit in the dashboard.
 */
function buildApprovalDescription(
  agentName: string,
  permissionLevel: string,
  service: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): string {
  const priorityKeys = ["path", "paths", "command", "files", "url", "query"];
  const skipKeys = new Set(["sessionId", "requestId", "traceId", "timestamp"]);

  // Separate priority and other keys
  const priorityEntries: [string, unknown][] = [];
  const otherEntries: [string, unknown][] = [];

  for (const [key, value] of Object.entries(toolArgs)) {
    // Skip null, undefined, and noise keys
    if (value === null || value === undefined || skipKeys.has(key)) {
      continue;
    }

    if (priorityKeys.includes(key)) {
      priorityEntries.push([key, value]);
    } else {
      otherEntries.push([key, value]);
    }
  }

  // Combine: priority first, then others
  const allEntries = [...priorityEntries, ...otherEntries];

  // Build arguments string
  const argParts: string[] = [];
  for (const [key, value] of allEntries) {
    const valueStr = typeof value === "string" ? value : JSON.stringify(value);
    argParts.push(`${key}: ${valueStr}`);
  }

  // Special handling for exec tool - parse command and return plain-English summary
  if (toolName === "exec" && typeof toolArgs["command"] === "string") {
    const cmd = toolArgs["command"];
    const destructiveCommands = ["rm", "mv", "sudo", "chmod", "chown", "dd", "truncate", "shred"];
    const isDestructive = destructiveCommands.some((destructive) =>
      cmd.toLowerCase().includes(destructive),
    );

    if (isDestructive) {
      // For destructive commands, provide a clear warning
      if (cmd.includes("rm")) {
        // Try to extract file count or path for better description
        const rmMatch = /rm\s+.*?(\d+)\s+files?/i.exec(cmd) ?? /rm\s+-rf?\s+(.+)/i.exec(cmd);
        if (rmMatch?.[1]) {
          return `${agentName} wants to delete ${rmMatch[1].includes("files") ? rmMatch[1] : `files from ${rmMatch[1]}`}`;
        }
        return `${agentName} wants to delete files in your inbox`;
      }
      return `${agentName} wants to run a destructive terminal command: ${cmd.slice(0, 80)}`;
    }

    // Safe read-only commands
    if (cmd.includes("ls") || cmd.includes("wc")) {
      return `${agentName} wants to list files in your inbox`;
    }
    if (cmd.includes("head") || cmd.includes("cat")) {
      return `${agentName} wants to preview files in your inbox`;
    }
    return `${agentName} wants to run a terminal command: ${cmd.slice(0, 80)}`;
  }

  const argsStr = argParts.length > 0 ? argParts.join(", ") : "";

  // Build full description
  const baseDescription = `${agentName} is requesting ${service} ${permissionLevel} access. Tool: ${toolName}.`;
  const fullDescription = argsStr.length > 0 ? `${baseDescription} ${argsStr}` : baseDescription;

  // Truncate at 200 characters
  if (fullDescription.length <= 200) {
    return fullDescription;
  }

  // Truncate, trying to preserve complete key:value pairs
  let truncated = baseDescription;
  const remainingChars = 200 - truncated.length - 1; // -1 for space

  if (remainingChars > 0 && argsStr.length > 0) {
    // Try to include as many complete arguments as possible
    let includedArgs = "";
    for (const arg of argParts) {
      const candidate = includedArgs.length === 0 ? arg : `${includedArgs}, ${arg}`;
      if (candidate.length <= remainingChars) {
        includedArgs = candidate;
      } else {
        break;
      }
    }

    if (includedArgs.length > 0) {
      truncated = `${truncated} ${includedArgs}`;
    }
  }

  return truncated;
}

// ---------------------------------------------------------------------------
// Plugin hooks
// ---------------------------------------------------------------------------

async function beforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
): Promise<PluginHookBeforeToolCallResult | undefined> {
  const config = readConfig();

  if (config.apiKey.length === 0) {
    pluginLogger?.warn("MULTICORN_API_KEY is not set. Skipping permission checks.");
    return undefined;
  }

  const agentName = resolveAgentName(ctx.sessionKey ?? "", config.agentName);

  const readiness = await ensureAgent(agentName, config.apiKey, config.baseUrl, config.failMode);

  if (readiness === "block") {
    return {
      block: true,
      blockReason:
        "Multicorn Shield could not verify permissions. " +
        "The Shield API is unreachable and fail-closed mode is enabled.",
    };
  }

  // In skip mode (fail-open, API unreachable), let the tool call through
  if (readiness === "skip") {
    return undefined;
  }

  // Map tool to scope FIRST, before checking permissions
  const command =
    event.toolName === "exec" && typeof event.params["command"] === "string"
      ? event.params["command"]
      : undefined;
  const mapping = mapToolToScope(event.toolName, command);

  // Log the mapping to verify correct scope is being used
  pluginLogger?.info(
    `Multicorn Shield: tool=${event.toolName}, service=${mapping.service}, permissionLevel=${mapping.permissionLevel}`,
  );

  // For destructive exec commands, use actionType that backend will recognize as requiring write permission
  // Backend checks if actionType contains "_delete" or "_write" to determine write permission needed
  const actionType =
    mapping.permissionLevel === "write" && event.toolName === "exec"
      ? "exec_write"
      : event.toolName;

  // Build description for approval requests
  const description = buildApprovalDescription(
    agentName,
    mapping.permissionLevel,
    mapping.service,
    event.toolName,
    event.params,
  );

  // Check permission via POST /api/v1/actions (server is source of truth)
  // Do this BEFORE triggering consent to avoid double-action
  const permissionResult = await checkActionPermission(
    {
      agent: agentName,
      service: mapping.service,
      actionType: actionType,
      status: "approved", // Status doesn't matter for permission check
      metadata: {
        description,
      },
    },
    config.apiKey,
    config.baseUrl,
    pluginLogger ?? undefined,
  );

  if (permissionResult.status === "approved") {
    // Action approved - refresh scopes to pick up newly granted permissions
    if (agentRecord !== null) {
      const scopes = await fetchGrantedScopes(
        agentRecord.id,
        config.apiKey,
        config.baseUrl,
        pluginLogger ?? undefined,
      );
      grantedScopes = scopes;
      lastScopeRefresh = Date.now();
      if (scopes.length > 0) {
        await saveCachedScopes(agentName, agentRecord.id, scopes).catch(() => {
          // Cache write failure is non-fatal
        });
      }
    }
    // Allow tool call to proceed
    return undefined;
  }

  if (permissionResult.status === "pending" && permissionResult.approvalId !== undefined) {
    // Action pending approval - poll for status
    pluginLogger?.info(
      `Multicorn Shield: action pending approval (ID: ${permissionResult.approvalId}). Polling for status...`,
    );

    const pollResult = await pollApprovalStatus(
      permissionResult.approvalId,
      config.apiKey,
      config.baseUrl,
      pluginLogger ?? undefined,
    );

    if (pollResult === "approved") {
      // Approval granted, allow tool call to proceed
      return undefined;
    }

    if (pollResult === "rejected") {
      return {
        block: true,
        blockReason: "Action was reviewed and rejected.",
      };
    }

    if (pollResult === "expired") {
      return {
        block: true,
        blockReason: "Approval request expired before a decision was made.",
      };
    }

    // pollResult must be "timeout" at this point
    return {
      block: true,
      blockReason: "Approval request timed out after 5 minutes.",
    };
  }

  // Action blocked (no approval available)
  // Only trigger consent if we have no scopes at all (first-time setup)
  // If we have some scopes but not this one, don't trigger consent - user should use Permissions page
  if (grantedScopes.length === 0 && agentRecord !== null) {
    await ensureConsent(agentName, config.apiKey, config.baseUrl, mapping);
  }

  const capitalizedService = mapping.service.charAt(0).toUpperCase() + mapping.service.slice(1);
  const reason =
    `${capitalizedService} ${mapping.permissionLevel} access is not allowed. ` +
    "Visit the Multicorn Shield dashboard to manage permissions.";

  return { block: true, blockReason: reason };
}

function afterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,
): Promise<void> {
  const config = readConfig();
  if (config.apiKey.length === 0) return Promise.resolve();

  const agentName = resolveAgentName(ctx.sessionKey ?? "", config.agentName);
  const mapping = mapToolToScope(event.toolName);

  void logAction(
    {
      agent: agentName,
      service: mapping.service,
      actionType: event.toolName,
      status: event.error ? "blocked" : "approved",
      metadata: {
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      },
    },
    config.apiKey,
    config.baseUrl,
    pluginLogger ?? undefined,
  );

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: OpenClawPluginDefinition = {
  id: "multicorn-shield",
  name: "Multicorn Shield",
  description:
    "AI agent governance for OpenClaw. Checks permissions, logs actions, " +
    "and enforces controls via the Shield API.",
  version: "0.1.0",

  register(api: OpenClawPluginApi) {
    pluginLogger = api.logger;
    pluginConfig = api.pluginConfig;
    api.on("before_tool_call", beforeToolCall, { priority: 10 });
    api.on("after_tool_call", afterToolCall);
    api.logger.info("Multicorn Shield plugin registered.");

    // Startup logging: check config and log connection info or error
    const config = readConfig();
    if (config.apiKey.length === 0) {
      api.logger.error(
        "Multicorn Shield: No API key found. Set MULTICORN_API_KEY in your OpenClaw config (~/.openclaw/openclaw.json → plugins.entries.multicorn-shield.env.MULTICORN_API_KEY). Get a key from your Multicorn dashboard (Settings → API Keys).",
      );
    } else {
      api.logger.info(`Multicorn Shield connecting to ${config.baseUrl}`);
    }
  },
};

export { plugin };

// Top-level register export for OpenClaw Plugin API v2
export function register(api: OpenClawPluginApi): void {
  if (plugin.register) {
    void plugin.register(api);
  }
}

// Exported for testing
export { readConfig, resolveAgentName, beforeToolCall, afterToolCall };

/**
 * Reset in-memory state. For testing only.
 */
export function resetState(): void {
  agentRecord = null;
  grantedScopes = [];
  consentInProgress = false;
  lastScopeRefresh = 0;
  pluginLogger = null;
  pluginConfig = undefined;
  connectionLogged = false;
}
