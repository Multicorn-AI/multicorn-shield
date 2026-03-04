/**
 * @deprecated Use the Plugin API entry point at `src/openclaw/plugin/index.ts`
 * instead. Gateway hooks cannot intercept tool calls - only the Plugin API's
 * `before_tool_call` / `after_tool_call` lifecycle hooks can do that.
 *
 * This file is kept for reference but will be removed in a future release.
 *
 * ---
 *
 * OpenClaw gateway hook handler for Multicorn Shield.
 *
 * Default-exported async function that OpenClaw calls on every
 * `agent:tool_call` event. Checks permissions against the Shield API,
 * blocks unauthorized actions, and logs everything to the dashboard.
 *
 * Configuration is read from environment variables:
 * - MULTICORN_API_KEY (required)
 * - MULTICORN_BASE_URL (default: https://api.multicorn.ai)
 * - MULTICORN_AGENT_NAME (override, default: derived from session key)
 * - MULTICORN_FAIL_MODE (open | closed, default: open)
 *
 * @module openclaw/hook/handler
 */

import type { OpenClawEvent, ToolCallEvent } from "../types.js";
import { isToolCallEvent } from "../types.js";
import { mapToolToScope } from "../tool-mapper.js";
import { loadCachedScopes, saveCachedScopes } from "../scope-cache.js";
import {
  findOrRegisterAgent,
  fetchGrantedScopes,
  logAction,
  type AgentRecord,
} from "../shield-client.js";
import { waitForConsent, deriveDashboardUrl } from "../consent.js";
import { hasScope } from "../../scopes/scope-validator.js";
import type { Scope, PermissionLevel } from "../../types/index.js";

// In-memory state across hook invocations within a single gateway session.
// Populated on first tool call, then reused.
let agentRecord: AgentRecord | null = null;
let grantedScopes: readonly Scope[] = [];
let consentInProgress = false;
let lastScopeRefresh = 0;

const SCOPE_REFRESH_INTERVAL_MS = 60_000;

/**
 * Read configuration from environment variables.
 */
function readConfig(): {
  apiKey: string;
  baseUrl: string;
  agentName: string | null;
  failMode: "open" | "closed";
} {
  const apiKey = process.env["MULTICORN_API_KEY"] ?? "";
  const baseUrl = process.env["MULTICORN_BASE_URL"] ?? "https://api.multicorn.ai";
  const agentName = process.env["MULTICORN_AGENT_NAME"] ?? null;
  const failModeRaw = process.env["MULTICORN_FAIL_MODE"] ?? "open";
  const failMode = failModeRaw === "closed" ? "closed" : "open";

  return { apiKey, baseUrl, agentName, failMode };
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

/**
 * Result of agent initialization.
 *
 * - `ready`: agent record and scopes are available, proceed with permission check
 * - `skip`: fail-open mode, API unreachable, skip permission check entirely
 * - `block`: fail-closed mode, API unreachable, block the tool call
 */
type AgentReadiness = "ready" | "skip" | "block";

/**
 * Ensure we have an agent record and scopes. Runs on first tool call
 * and refreshes periodically.
 */
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
      process.stderr.write(
        "[multicorn-shield] Could not reach Shield API. Running without permission checks.\n",
      );
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

/**
 * Run the consent flow if the requested scope has not been granted yet.
 */
async function ensureConsent(
  agentName: string,
  apiKey: string,
  baseUrl: string,
  scope?: { service: string; permissionLevel: string },
): Promise<void> {
  if (agentRecord === null) return;

  // Check API-fetched scopes to determine if agent has zero permissions
  // This ensures we don't re-trigger consent for agents with existing permissions from previous sessions
  const apiScopes = await fetchGrantedScopes(agentRecord.id, apiKey, baseUrl);

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
    const scopes = await waitForConsent(agentRecord.id, agentName, apiKey, baseUrl, scope);
    grantedScopes = scopes;
    await saveCachedScopes(agentName, agentRecord.id, scopes).catch(() => {
      // Cache write failure is non-fatal
    });
  } finally {
    consentInProgress = false;
  }
}

/**
 * Check whether the tool call is permitted by the agent's granted scopes.
 */
function isPermitted(event: ToolCallEvent): boolean {
  const mapping = mapToolToScope(event.context.toolName);
  // Defensive check: ensure grantedScopes is defined (can be undefined in test scenarios)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!grantedScopes || grantedScopes.length === 0) return false;
  return grantedScopes.some(
    (scope) =>
      scope.service === mapping.service && scope.permissionLevel === mapping.permissionLevel,
  );
}

/**
 * Main hook handler. OpenClaw calls this on every registered event.
 *
 * Filters for `agent:tool_call` events, checks permissions, blocks
 * unauthorized actions, and logs everything.
 */
const handler = async (event: OpenClawEvent): Promise<void> => {
  if (!isToolCallEvent(event)) return;

  const config = readConfig();

  if (config.apiKey.length === 0) {
    process.stderr.write(
      "[multicorn-shield] MULTICORN_API_KEY is not set. Skipping permission checks.\n",
    );
    return;
  }

  const agentName = resolveAgentName(event.sessionKey, config.agentName);

  // Ensure we have agent record and scopes
  const readiness = await ensureAgent(agentName, config.apiKey, config.baseUrl, config.failMode);

  if (readiness === "block") {
    event.messages.push(
      "Permission denied: Multicorn Shield could not verify permissions. " +
        "The Shield API is unreachable and fail-closed mode is enabled.",
    );
    return;
  }

  // In skip mode (fail-open, API unreachable), let the tool call through
  if (readiness === "skip") {
    return;
  }

  // Map tool to scope first, then check if that specific scope is granted
  const mapping = mapToolToScope(event.context.toolName);
  const requestedScope: Scope = {
    service: mapping.service,
    permissionLevel: mapping.permissionLevel,
  };

  // Trigger consent if the specific scope is missing
  if (!hasScope(grantedScopes, requestedScope)) {
    await ensureConsent(agentName, config.apiKey, config.baseUrl, mapping);
  }

  const permitted = isPermitted(event);

  if (!permitted) {
    const capitalizedService = mapping.service.charAt(0).toUpperCase() + mapping.service.slice(1);
    const dashboardUrl = deriveDashboardUrl(config.baseUrl);
    event.messages.push(
      `Permission denied: ${capitalizedService} ${mapping.permissionLevel} access is not allowed. ` +
        `Check pending approvals at ${dashboardUrl}/approvals `,
    );

    // Log the blocked action (fire-and-forget)
    void logAction(
      {
        agent: agentName,
        service: mapping.service,
        actionType: event.context.toolName,
        status: "blocked",
      },
      config.apiKey,
      config.baseUrl,
    );
    return;
  }

  // Log the approved action (fire-and-forget)
  void logAction(
    {
      agent: agentName,
      service: mapping.service,
      actionType: event.context.toolName,
      status: "approved",
    },
    config.apiKey,
    config.baseUrl,
  );
};

export { handler };

// Exported for testing only
export { resolveAgentName, readConfig };

// Reset function for testing - clears in-memory state
export function resetState(): void {
  agentRecord = null;
  grantedScopes = [];
  consentInProgress = false;
  lastScopeRefresh = 0;
}
