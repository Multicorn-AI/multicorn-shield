/**
 * Agent registration, scope fetching, consent flow, and scope caching.
 *
 * Handles the full lifecycle of connecting a proxy to the Multicorn service:
 * finding or creating an agent record, fetching its granted scopes, and
 * triggering the browser consent flow when the agent has no scopes yet.
 *
 * Scopes are cached in `~/.multicorn/scopes.json` for offline resilience
 * and refreshed from the service every 60 seconds while the proxy runs.
 * Cache is account-aware (keyed by agent name + API key).
 *
 * @module proxy/consent
 */

import { spawn } from "node:child_process";
import { loadCachedScopes, saveCachedScopes } from "../openclaw/scope-cache.js";
import type { Scope } from "../types/index.js";
import type { ProxyLogger } from "./logger.js";

const CONSENT_POLL_INTERVAL_MS = 3000;
const CONSENT_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Derives the dashboard URL from the API base URL.
 * - http://localhost:8080 -> http://localhost:5173
 * - https://api.multicorn.ai -> https://app.multicorn.ai
 * - Other URLs: replace "api" with "app" in the hostname, or use default
 */
export function deriveDashboardUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);

    // Local development: localhost or 127.0.0.1 (any port) -> dashboard on 5173
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      url.port = "5173";
      url.protocol = "http:";
      return url.toString();
    }

    // Production: api.multicorn.ai -> app.multicorn.ai
    if (url.hostname === "api.multicorn.ai") {
      url.hostname = "app.multicorn.ai";
      return url.toString();
    }

    // Try replacing "api" with "app" in hostname
    if (url.hostname.includes("api")) {
      url.hostname = url.hostname.replace("api", "app");
      return url.toString();
    }

    // For other production-like URLs (https with non-localhost), derive from base URL
    if (url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      // Fallback: default production dashboard for production-like URLs
      return "https://app.multicorn.ai";
    }

    // For other cases (http with non-localhost), try to derive
    // If we can't derive, fall back to production (shouldn't happen in practice)
    return "https://app.multicorn.ai";
  } catch {
    // If baseUrl is invalid, fall back to production dashboard
    return "https://app.multicorn.ai";
  }
}

/**
 * Thrown when the Shield API returns 401 or 403 (API key invalid or revoked).
 * Used so resolveAgentRecord can detect auth failure without ad-hoc property casts.
 */
export class ShieldAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShieldAuthError";
    Object.setPrototypeOf(this, ShieldAuthError.prototype);
  }
}

export interface AgentRecord {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly Scope[];
  /** Set when the service returned 401/403; proxy must block with auth error message. */
  readonly authInvalid?: boolean;
}

export { loadCachedScopes, saveCachedScopes };

export async function findAgentByName(
  agentName: string,
  apiKey: string,
  baseUrl: string,
): Promise<AgentRecord | null> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v1/agents`, {
      headers: { "X-Multicorn-Key": apiKey },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { id: "", name: agentName, scopes: [], authInvalid: true };
    }
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!isApiSuccessResponse(body)) return null;

  const agents = body.data;
  if (!Array.isArray(agents)) return null;

  const match = agents.find(
    (a): a is AgentSummaryShape => isAgentSummaryShape(a) && a.name === agentName,
  );
  if (match === undefined) return null;

  return { id: match.id, name: match.name, scopes: [] };
}

export async function registerAgent(
  agentName: string,
  apiKey: string,
  baseUrl: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Multicorn-Key": apiKey,
    },
    body: JSON.stringify({ name: agentName }),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ShieldAuthError(
        `Failed to register agent "${agentName}": service returned ${String(response.status)}.`,
      );
    }
    throw new Error(
      `Failed to register agent "${agentName}": service returned ${String(response.status)}.`,
    );
  }

  const body: unknown = await response.json();
  if (!isApiSuccessResponse(body)) {
    throw new Error(`Failed to register agent "${agentName}": unexpected response format.`);
  }

  if (!isAgentSummaryShape(body.data)) {
    throw new Error(`Failed to register agent "${agentName}": response missing agent ID.`);
  }

  return body.data.id;
}

export async function fetchGrantedScopes(
  agentId: string,
  apiKey: string,
  baseUrl: string,
): Promise<readonly Scope[]> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v1/agents/${agentId}`, {
      headers: { "X-Multicorn-Key": apiKey },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return [];
  }

  if (!response.ok) return [];

  const body: unknown = await response.json();
  if (!isApiSuccessResponse(body)) return [];

  const agentDetail = body.data;
  if (!isAgentDetailShape(agentDetail)) return [];

  const scopes: Scope[] = [];
  for (const perm of agentDetail.permissions) {
    if (!isPermissionShape(perm)) continue;
    if (perm.revoked_at !== null) continue;
    if (perm.read) scopes.push({ service: perm.service, permissionLevel: "read" });
    if (perm.write) scopes.push({ service: perm.service, permissionLevel: "write" });
    if (perm.execute) scopes.push({ service: perm.service, permissionLevel: "execute" });
  }

  return scopes;
}

export function openBrowser(url: string): void {
  if (process.env["NODE_ENV"] === "test" || process.env["VITEST"] === "true") {
    return;
  }
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";

  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

export async function waitForConsent(
  agentId: string,
  agentName: string,
  apiKey: string,
  baseUrl: string,
  dashboardUrl: string,
  logger: ProxyLogger,
  scope?: { service: string; permissionLevel: string },
): Promise<readonly Scope[]> {
  // Use the provided scope if available, otherwise fall back to detected scopes
  const scopeStrings: readonly string[] = scope
    ? [`${scope.service}:${scope.permissionLevel}`]
    : detectScopeHints();
  const consentUrl = buildConsentUrl(agentName, scopeStrings, dashboardUrl);

  logger.info("Opening consent page in your browser.", { url: consentUrl });
  process.stderr.write(
    `\nAction requires permission. Opening consent page...\n${consentUrl}\n\n` +
      "Waiting for you to grant access in the Multicorn dashboard...\n",
  );

  openBrowser(consentUrl);

  const deadline = Date.now() + CONSENT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(CONSENT_POLL_INTERVAL_MS);

    const scopes = await fetchGrantedScopes(agentId, apiKey, baseUrl);
    if (scopes.length > 0) {
      logger.info("Permissions granted.", { agent: agentName, scopeCount: scopes.length });
      return scopes;
    }
  }

  throw new Error(
    `Consent not granted within ${String(CONSENT_POLL_TIMEOUT_MS / 60_000)} minutes. ` +
      `Grant access at ${dashboardUrl} and restart the proxy.`,
  );
}

export async function resolveAgentRecord(
  agentName: string,
  apiKey: string,
  baseUrl: string,
  logger: ProxyLogger,
): Promise<AgentRecord> {
  // Always try the cache first. It works offline.
  const cachedScopes = await loadCachedScopes(agentName, apiKey);
  if (cachedScopes !== null && cachedScopes.length > 0) {
    logger.debug("Loaded scopes from cache.", { agent: agentName, count: cachedScopes.length });
    // Use a placeholder id. It will be overwritten once the service is reachable.
    return { id: "", name: agentName, scopes: cachedScopes };
  }

  let agent = await findAgentByName(agentName, apiKey, baseUrl);

  if (agent?.authInvalid) {
    return agent;
  }

  if (agent === null) {
    // Service may be unreachable. Attempt registration, fall back to offline mode.
    try {
      logger.info("Agent not found. Registering.", { agent: agentName });
      const id = await registerAgent(agentName, apiKey, baseUrl);
      agent = { id, name: agentName, scopes: [] };
      logger.info("Agent registered.", { agent: agentName, id });
    } catch (error: unknown) {
      if (error instanceof ShieldAuthError) {
        return { id: "", name: agentName, scopes: [], authInvalid: true };
      }
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn("Could not reach Multicorn service. Running with empty permissions.", {
        error: detail,
      });
      // id: "" signals offline mode. Consent flow and action logging are skipped.
      return { id: "", name: agentName, scopes: [] };
    }
  }

  const scopes = await fetchGrantedScopes(agent.id, apiKey, baseUrl);
  if (scopes.length > 0) {
    await saveCachedScopes(agentName, agent.id, scopes, apiKey);
  }

  return { ...agent, scopes };
}

export function buildConsentUrl(
  agentName: string,
  scopes: readonly string[],
  dashboardUrl: string,
): string {
  const base = dashboardUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ agent: agentName });
  if (scopes.length > 0) {
    params.set("scopes", scopes.join(","));
  }
  return `${base}/consent?${params.toString()}`;
}

function detectScopeHints(): readonly string[] {
  // In a full implementation this would inspect the MCP server's tools/list output.
  // For now, the consent URL omits scopes and lets the dashboard show all options.
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Type guards for API response shapes

interface ApiSuccessResponse {
  readonly success: true;
  readonly data: unknown;
}

interface AgentSummaryShape {
  readonly id: string;
  readonly name: string;
}

interface PermissionShape {
  readonly service: string;
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
  readonly revoked_at: string | null;
  readonly granted_at?: string;
  readonly agent_id?: string;
}

interface AgentDetailShape {
  readonly permissions: unknown[];
}

function isApiSuccessResponse(value: unknown): value is ApiSuccessResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj["success"] === true;
}

function isAgentSummaryShape(value: unknown): value is AgentSummaryShape {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["id"] === "string" && typeof obj["name"] === "string";
}

function isAgentDetailShape(value: unknown): value is AgentDetailShape {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj["permissions"]);
}

function isPermissionShape(value: unknown): value is PermissionShape {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["service"] === "string" &&
    typeof obj["read"] === "boolean" &&
    typeof obj["write"] === "boolean" &&
    typeof obj["execute"] === "boolean" &&
    (obj["revoked_at"] === null || typeof obj["revoked_at"] === "string")
  );
}
