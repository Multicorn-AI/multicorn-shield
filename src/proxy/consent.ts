/**
 * Agent registration, scope fetching, consent flow, and scope caching.
 *
 * Handles the full lifecycle of connecting a proxy to the Multicorn service:
 * finding or creating an agent record, fetching its granted scopes, and
 * triggering the browser consent flow when the agent has no scopes yet.
 *
 * Scopes are cached in `~/.multicorn/scopes.json` for offline resilience
 * and refreshed from the service every 60 seconds while the proxy runs.
 *
 * @module proxy/consent
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { Scope } from "../types/index.js";
import type { ProxyLogger } from "./logger.js";

const MULTICORN_DIR = join(homedir(), ".multicorn");
const SCOPES_PATH = join(MULTICORN_DIR, "scopes.json");

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

    // Local development: API on 8080, dashboard on 5173
    if (url.hostname === "localhost" && url.port === "8080") {
      url.port = "5173";
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

    // Fallback: default production dashboard
    return "https://app.multicorn.ai";
  } catch {
    // If baseUrl is invalid, fall back to production dashboard
    return "https://app.multicorn.ai";
  }
}

export interface AgentRecord {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly Scope[];
}

type ScopesCacheFile = Readonly<Record<string, ScopesCacheEntry>>;

interface ScopesCacheEntry {
  readonly agentId: string;
  readonly scopes: readonly Scope[];
  readonly fetchedAt: string;
}

export async function loadCachedScopes(agentName: string): Promise<readonly Scope[] | null> {
  try {
    const raw = await readFile(SCOPES_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isScopesCacheFile(parsed)) return null;

    const entry = parsed[agentName];
    return entry?.scopes ?? null;
  } catch {
    return null;
  }
}

export async function saveCachedScopes(
  agentName: string,
  agentId: string,
  scopes: readonly Scope[],
): Promise<void> {
  await mkdir(MULTICORN_DIR, { recursive: true });

  let existing: ScopesCacheFile = {};
  try {
    const raw = await readFile(SCOPES_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isScopesCacheFile(parsed)) existing = parsed;
  } catch {
    // File missing or corrupt. Start fresh.
  }

  const updated: ScopesCacheFile = {
    ...existing,
    [agentName]: {
      agentId,
      scopes,
      fetchedAt: new Date().toISOString(),
    },
  };

  await writeFile(SCOPES_PATH, JSON.stringify(updated, null, 2) + "\n", "utf8");
}

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

  if (!response.ok) return null;

  const body: unknown = await response.json();
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
): Promise<readonly Scope[]> {
  const detectedScopes = detectScopeHints();
  const consentUrl = buildConsentUrl(agentName, detectedScopes, dashboardUrl);

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
  const cachedScopes = await loadCachedScopes(agentName);
  if (cachedScopes !== null && cachedScopes.length > 0) {
    logger.debug("Loaded scopes from cache.", { agent: agentName, count: cachedScopes.length });
    // Use a placeholder id. It will be overwritten once the service is reachable.
    return { id: "", name: agentName, scopes: cachedScopes };
  }

  let agent = await findAgentByName(agentName, apiKey, baseUrl);

  if (agent === null) {
    // Service may be unreachable. Attempt registration, fall back to offline mode.
    try {
      logger.info("Agent not found. Registering.", { agent: agentName });
      const id = await registerAgent(agentName, apiKey, baseUrl);
      agent = { id, name: agentName, scopes: [] };
      logger.info("Agent registered.", { agent: agentName, id });
    } catch (error) {
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
    await saveCachedScopes(agentName, agent.id, scopes);
  }

  return { ...agent, scopes };
}

function buildConsentUrl(
  agentName: string,
  scopes: readonly string[],
  dashboardUrl: string,
): string {
  const params = new URLSearchParams({ agent: agentName });
  if (scopes.length > 0) {
    params.set("scopes", scopes.join(","));
  }
  return `${dashboardUrl}/consent?${params.toString()}`;
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

function isScopesCacheFile(value: unknown): value is ScopesCacheFile {
  return typeof value === "object" && value !== null;
}
