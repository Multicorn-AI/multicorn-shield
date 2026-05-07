/**
 * Multicorn Shield plugin for OpenClaw.
 *
 * Registers `before_tool_call` and `after_tool_call` lifecycle hooks
 * via the Plugin API to intercept every tool call the agent makes.
 *
 * - before_tool_call: checks permissions and blocks unauthorized actions
 * - after_tool_call: logs activity to the Shield dashboard (fire-and-forget)
 *
 * API key and base URL are read from (in order): process.env, then
 * ~/.multicorn/config.json (written by npx multicorn-shield init).
 * Agent name and fail mode also use plugin config and env.
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
  type AgentRecord,
} from "../shield-client.js";
import { waitForConsent, deriveDashboardUrl } from "../consent.js";
import { hasScope } from "../../scopes/scope-validator.js";
import type { Scope, PermissionLevel } from "../../types/index.js";

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
let pinnedAgentName: string | null = null;
let hasLoggedFirstAction = false;

const SCOPE_REFRESH_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface MulticornConfig {
  apiKey?: string;
  baseUrl?: string;
  agentName?: string;
  agents?: readonly { readonly name: string; readonly platform: string }[];
  defaultAgent?: string;
}

interface ShieldConfig {
  apiKey: string;
  baseUrl: string;
  agentName: string | null;
  failMode: "open" | "closed";
}

let cachedMulticornConfig: MulticornConfig | null = null;

function loadMulticornConfig(): MulticornConfig | null {
  try {
    const configPath = path.join(os.homedir(), ".multicorn", "config.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as MulticornConfig;
  } catch {
    return null;
  }
}

function agentNameFromOpenclawPlatform(cfg: MulticornConfig | null): string | undefined {
  if (cfg === null) return undefined;
  const list = cfg.agents;
  if (!Array.isArray(list)) return undefined;
  for (const e of list) {
    if (
      typeof e === "object" &&
      e !== null &&
      "platform" in e &&
      "name" in e &&
      (e as { platform: string }).platform === "openclaw" &&
      typeof (e as { name: string }).name === "string"
    ) {
      return (e as { name: string }).name;
    }
  }
  return undefined;
}

/**
 * Read config. API key and base URL: ~/.multicorn/config.json first (cached at startup), then env.
 * Agent name and fail mode: plugin config then env.
 */
function readConfig(): ShieldConfig {
  const pc = pluginConfig ?? {};
  const resolvedApiKey =
    asString(cachedMulticornConfig?.apiKey) ?? asString(process.env["MULTICORN_API_KEY"]) ?? "";
  const resolvedBaseUrl =
    asString(cachedMulticornConfig?.baseUrl) ??
    asString(process.env["MULTICORN_BASE_URL"]) ??
    "https://api.multicorn.ai";

  const agentName =
    asString(pc["agentName"]) ??
    process.env["MULTICORN_AGENT_NAME"] ??
    agentNameFromOpenclawPlatform(cachedMulticornConfig) ??
    asString(cachedMulticornConfig?.agentName) ??
    null;
  const failMode = "closed" as const;

  let apiKey = resolvedApiKey;
  if (apiKey.length > 0 && (!apiKey.startsWith("mcs_") || apiKey.length < 16)) {
    pluginLogger?.error(
      "Invalid API key format. Key must start with mcs_ and be at least 16 characters.",
    );
    apiKey = "";
  }

  return { apiKey, baseUrl: resolvedBaseUrl, agentName, failMode };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Derive the agent name.
 *
 * When a configured name exists (plugin config, MULTICORN_AGENT_NAME, or ctx.agentId
 * from OpenClaw's agents.list[0].id), use it unconditionally and ignore sessionKey.
 * This prevents the "openclaw" ghost agent when OpenClaw sends varied session keys.
 *
 * Resolution order: configOverride (plugin/env) → ctxAgentId → parse sessionKey → "openclaw".
 */
function resolveAgentName(
  sessionKey: string,
  configOverride: string | null,
  ctxAgentId?: string,
): string {
  if (configOverride !== null && configOverride.trim().length > 0) {
    return configOverride.trim();
  }
  if (ctxAgentId !== undefined && ctxAgentId.trim().length > 0) {
    return ctxAgentId.trim();
  }

  const parts = sessionKey.split(":");
  const name = parts[1];
  if (name !== undefined && name.trim().length > 0) {
    return name.trim();
  }

  return "openclaw";
}

/**
 * Get the agent name for Shield API calls.
 * Once a non-"openclaw" name is resolved, pin it and reuse for all subsequent calls
 * to avoid creating ghost agents from internal tool calls with empty context.
 */
function getAgentName(
  sessionKey: string,
  configOverride: string | null,
  ctxAgentId?: string,
): string {
  if (pinnedAgentName !== null) return pinnedAgentName;
  const resolved = resolveAgentName(sessionKey, configOverride, ctxAgentId);
  if (resolved !== "openclaw") {
    pinnedAgentName = resolved;
  }
  return resolved;
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
  // Already initialized and scopes are fresh (safety: ensure name matches)
  if (
    agentRecord !== null &&
    agentRecord.name === agentName &&
    Date.now() - lastScopeRefresh < SCOPE_REFRESH_INTERVAL_MS
  ) {
    return "ready";
  }

  // Wrong agent in cache - reset and re-init for this agentName
  if (agentRecord !== null && agentRecord.name !== agentName) {
    agentRecord = null;
  }

  // Try to load cached scopes first (fast, offline-resilient)
  if (agentRecord === null) {
    const cached = await loadCachedScopes(agentName, apiKey);
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
    await saveCachedScopes(agentName, agentRecord.id, scopes, apiKey).catch(() => {
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
  if (agentRecord === null) return;

  // Check API-fetched scopes to determine if agent has zero permissions
  // This ensures we don't re-trigger consent for agents with existing permissions from previous sessions
  const apiScopes = await fetchGrantedScopes(
    agentRecord.id,
    apiKey,
    baseUrl,
    pluginLogger ?? undefined,
  );

  // Only open consent screen if agent has zero permissions (first-time setup)
  // If agent has any permissions, skip consent and let the action go through approval flow
  if (apiScopes.length > 0) {
    // Agent has permissions - update in-memory state and skip consent
    grantedScopes = apiScopes;
    lastScopeRefresh = Date.now();
    return;
  }

  // If a specific scope is requested, check if that exact scope is granted
  // If no scope is requested, check if any scopes exist (first-time setup)
  if (scope !== undefined) {
    const requestedScope: Scope = {
      service: scope.service,
      permissionLevel: scope.permissionLevel as PermissionLevel,
    };
    if (hasScope(grantedScopes, requestedScope) || consentInProgress) return;
  } else {
    if (grantedScopes.length > 0 || consentInProgress) return;
  }

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
    await saveCachedScopes(agentName, agentRecord.id, scopes, apiKey).catch(() => {
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
  try {
    console.error("[SHIELD] beforeToolCall ENTRY: tool=" + event.toolName);

    const config = readConfig();
    console.error(
      "[SHIELD] config loaded: baseUrl=" +
        config.baseUrl +
        " apiKey=" +
        (config.apiKey ? "present" : "MISSING") +
        " failMode=" +
        config.failMode,
    );

    if (config.apiKey.length === 0) {
      pluginLogger?.warn(
        "Multicorn Shield: No API key found. Run 'npx multicorn-shield init' or set MULTICORN_API_KEY.",
      );
      console.error("[SHIELD] DECISION: allow (no API key)");
      return undefined;
    }

    const agentName = getAgentName(ctx.sessionKey ?? "", config.agentName, ctx.agentId);

    const readiness = await ensureAgent(agentName, config.apiKey, config.baseUrl, config.failMode);
    console.error("[SHIELD] ensureAgent result: " + JSON.stringify(readiness));

    if (readiness === "block") {
      const returnValue = {
        block: true,
        blockReason:
          "Multicorn Shield could not verify permissions. " +
          "The Shield API is unreachable and fail-closed mode is enabled.",
      };
      console.error("[SHIELD] DECISION: " + JSON.stringify(returnValue));
      return returnValue;
    }

    // In skip mode (fail-open, API unreachable), let the tool call through
    if (readiness === "skip") {
      console.error("[SHIELD] DECISION: allow (skip mode)");
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

    // If agent has zero scopes (first-time setup), trigger consent before checking permission
    if (grantedScopes.length === 0 && agentRecord !== null) {
      await ensureConsent(agentName, config.apiKey, config.baseUrl, mapping);
      console.error("[SHIELD] ensureConsent result: completed (zero-scopes path)");
    }

    // Check permission via POST /api/v1/actions (server is source of truth)
    console.error(
      "[SHIELD] calling checkActionPermission: service=" +
        mapping.service +
        " actionType=" +
        actionType,
    );
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
    console.error("[SHIELD] permission result: " + JSON.stringify(permissionResult));

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
        if (Array.isArray(scopes) && scopes.length > 0) {
          await saveCachedScopes(agentName, agentRecord.id, scopes, config.apiKey).catch(() => {
            // Cache write failure is non-fatal
          });
        }
      }
      // Allow tool call to proceed
      console.error("[SHIELD] DECISION: allow (approved)");
      return undefined;
    }

    if (permissionResult.status === "pending" && permissionResult.approvalId !== undefined) {
      const base = deriveDashboardUrl(config.baseUrl).replace(/\/+$/, "");
      const returnValue = {
        block: true,
        blockReason: `Action pending approval.\nVisit ${base}/approvals to approve or reject, then try again.`,
      };
      console.error("[SHIELD] DECISION: " + JSON.stringify(returnValue));
      return returnValue;
    }

    // Action blocked (no approval available)
    // Check if the specific scope is missing and trigger consent for that scope
    const requestedScope: Scope = {
      service: mapping.service,
      permissionLevel: mapping.permissionLevel,
    };
    if (!hasScope(grantedScopes, requestedScope) && agentRecord !== null) {
      await ensureConsent(agentName, config.apiKey, config.baseUrl, mapping);
      console.error("[SHIELD] ensureConsent result: completed (blocked path)");

      // Re-check after consent: refresh scopes and call API again
      const scopes = await fetchGrantedScopes(
        agentRecord.id,
        config.apiKey,
        config.baseUrl,
        pluginLogger ?? undefined,
      );
      grantedScopes = scopes;
      lastScopeRefresh = Date.now();
      if (Array.isArray(scopes) && scopes.length > 0) {
        await saveCachedScopes(agentName, agentRecord.id, scopes, config.apiKey).catch(() => {
          /* Cache write failure is non-fatal */
        });
      }

      const recheckResult = await checkActionPermission(
        {
          agent: agentName,
          service: mapping.service,
          actionType: actionType,
          status: "approved",
          metadata: { description },
        },
        config.apiKey,
        config.baseUrl,
        pluginLogger ?? undefined,
      );

      if (recheckResult.status === "approved") {
        const refreshedScopes = await fetchGrantedScopes(
          agentRecord.id,
          config.apiKey,
          config.baseUrl,
          pluginLogger ?? undefined,
        );
        grantedScopes = refreshedScopes;
        lastScopeRefresh = Date.now();
        if (Array.isArray(refreshedScopes) && refreshedScopes.length > 0) {
          await saveCachedScopes(agentName, agentRecord.id, refreshedScopes, config.apiKey).catch(
            () => {
              /* Cache write failure is non-fatal */
            },
          );
        }
        console.error("[SHIELD] DECISION: allow (re-check after consent)");
        return undefined;
      }
    }

    const capitalizedService = mapping.service.charAt(0).toUpperCase() + mapping.service.slice(1);
    const base = deriveDashboardUrl(config.baseUrl).replace(/\/+$/, "");
    const reason =
      `${capitalizedService} ${mapping.permissionLevel} access is not allowed. ` +
      `Check pending approvals at:\n${base}/approvals`;

    const returnValue = { block: true, blockReason: reason };
    console.error("[SHIELD] DECISION: " + JSON.stringify(returnValue));
    return returnValue;
  } catch (e) {
    console.error("[SHIELD] CRASH in beforeToolCall: " + String(e));
    console.error("[SHIELD] Stack: " + ((e instanceof Error ? e.stack : undefined) ?? "no stack"));
    return { block: true, blockReason: "Shield internal error: " + String(e) };
  }
}

function afterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,
): Promise<void> {
  const config = readConfig();
  if (config.apiKey.length === 0) return Promise.resolve();

  const agentName = getAgentName(ctx.sessionKey ?? "", config.agentName, ctx.agentId);
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

  if (!event.error && !hasLoggedFirstAction) {
    hasLoggedFirstAction = true;
    const dashUrl = deriveDashboardUrl(config.baseUrl).replace(/\/+$/, "");
    if (pluginLogger) {
      pluginLogger.info(`First action recorded. View activity → ${dashUrl}/agents`);
    }
  }

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
    cachedMulticornConfig = loadMulticornConfig();
    const config = readConfig();
    if (config.agentName !== null) {
      pinnedAgentName = config.agentName;
    }
    // Logged fields are allowlisted and treated as non-secret by contract. Do not log raw
    // `cachedMulticornConfig` or add URL query params, userinfo, or tokens to this line; baseUrl is
    // expected to be a plain host (e.g. https://api.example.com) only.
    api.logger.info(
      "Multicorn Shield config loaded: " +
        `hasApiKey=${String((cachedMulticornConfig?.apiKey ?? "").length > 0)} ` +
        `baseUrl=${cachedMulticornConfig?.baseUrl ?? "default"} ` +
        `agentName=${cachedMulticornConfig?.agentName ?? "unset"} ` +
        `defaultAgent=${cachedMulticornConfig?.defaultAgent ?? "unset"} ` +
        `agents=${String(cachedMulticornConfig?.agents?.length ?? 0)}`,
    );
    api.on("before_tool_call", beforeToolCall, { priority: 10 });
    api.on("after_tool_call", afterToolCall);
    api.logger.info("Multicorn Shield plugin registered.");

    if (config.apiKey.length === 0) {
      api.logger.error(
        "Multicorn Shield: No API key found. Run 'npx multicorn-shield init' or set MULTICORN_API_KEY.",
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
  cachedMulticornConfig = null;
  connectionLogged = false;
  pinnedAgentName = null;
  hasLoggedFirstAction = false;
}
