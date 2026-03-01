/**
 * Multicorn Shield plugin for OpenClaw.
 *
 * Registers `before_tool_call` and `after_tool_call` lifecycle hooks
 * via the Plugin API to intercept every tool call the agent makes.
 *
 * - before_tool_call: checks permissions and blocks unauthorized actions
 * - after_tool_call: logs activity to the Shield dashboard (fire-and-forget)
 *
 * Configuration is read from environment variables:
 * - MULTICORN_API_KEY (required)
 * - MULTICORN_BASE_URL (default: https://api.multicorn.ai)
 * - MULTICORN_AGENT_NAME (override, default: derived from session key)
 * - MULTICORN_FAIL_MODE (open | closed, default: open)
 *
 * @module openclaw/plugin
 */

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
 * Read config from plugin config (openclaw.json), then env vars as fallback.
 */
function readConfig(): ShieldConfig {
  const pc = pluginConfig ?? {};
  const apiKey = asString(pc["apiKey"]) ?? process.env["MULTICORN_API_KEY"] ?? "";
  const baseUrl =
    asString(pc["baseUrl"]) ?? process.env["MULTICORN_BASE_URL"] ?? "https://api.multicorn.ai";
  const agentName = asString(pc["agentName"]) ?? process.env["MULTICORN_AGENT_NAME"] ?? null;
  const failModeRaw = asString(pc["failMode"]) ?? process.env["MULTICORN_FAIL_MODE"] ?? "open";
  const failMode = failModeRaw === "closed" ? "closed" : "open";
  return { apiKey, baseUrl, agentName, failMode };
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
      void findOrRegisterAgent(agentName, apiKey, baseUrl).then((record) => {
        if (record !== null) agentRecord = record;
      });
      lastScopeRefresh = Date.now();
      return "ready";
    }
  }

  // Register or find the agent
  if (agentRecord === null) {
    const record = await findOrRegisterAgent(agentName, apiKey, baseUrl);
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
  const scopes = await fetchGrantedScopes(agentRecord.id, apiKey, baseUrl);
  grantedScopes = scopes;
  lastScopeRefresh = Date.now();

  if (scopes.length > 0) {
    await saveCachedScopes(agentName, agentRecord.id, scopes).catch(() => {
      // Cache write failure is non-fatal
    });
  }

  return "ready";
}

async function ensureConsent(agentName: string, apiKey: string, baseUrl: string): Promise<void> {
  if (grantedScopes.length > 0 || consentInProgress || agentRecord === null) return;

  consentInProgress = true;
  try {
    const scopes = await waitForConsent(agentRecord.id, agentName, apiKey, baseUrl);
    grantedScopes = scopes;
    await saveCachedScopes(agentName, agentRecord.id, scopes).catch(() => {
      // Cache write failure is non-fatal
    });
  } finally {
    consentInProgress = false;
  }
}

function isScopePermitted(toolName: string): boolean {
  const mapping = mapToolToScope(toolName);
  return grantedScopes.some(
    (scope) =>
      scope.service === mapping.service && scope.permissionLevel === mapping.permissionLevel,
  );
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

  // If no scopes and we have an agent record, trigger consent
  await ensureConsent(agentName, config.apiKey, config.baseUrl);

  const mapping = mapToolToScope(event.toolName);
  const permitted = isScopePermitted(event.toolName);

  if (!permitted) {
    const capitalizedService = mapping.service.charAt(0).toUpperCase() + mapping.service.slice(1);
    const reason =
      `${capitalizedService} ${mapping.permissionLevel} access is not allowed. ` +
      "Visit the Multicorn Shield dashboard to manage permissions.";

    // Log the blocked action (fire-and-forget)
    void logAction(
      {
        agent: agentName,
        service: mapping.service,
        actionType: event.toolName,
        status: "blocked",
      },
      config.apiKey,
      config.baseUrl,
    );

    return { block: true, blockReason: reason };
  }

  // Log the approved action (fire-and-forget, done in before so it's recorded
  // even if the tool itself errors out)
  void logAction(
    {
      agent: agentName,
      service: mapping.service,
      actionType: event.toolName,
      status: "approved",
    },
    config.apiKey,
    config.baseUrl,
  );

  return undefined;
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
  },
};

export { plugin };

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
}
