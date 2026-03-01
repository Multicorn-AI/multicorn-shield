/**
 * HTTP client for communicating with the Multicorn Shield API.
 *
 * Handles agent registration, permission fetching, and action logging.
 * Follows the same patterns as the MCP proxy client but is self-contained
 * so the hook has no runtime dependency on proxy internals.
 *
 * Security: the API key is passed as a parameter and sent only via the
 * `X-Multicorn-Key` header over HTTPS. It is never logged or written
 * to disk.
 *
 * @module openclaw/shield-client
 */

import type { Scope, ActionStatus } from "../types/index.js";

const REQUEST_TIMEOUT_MS = 5000;
const AUTH_HEADER = "X-Multicorn-Key";

/**
 * Payload for logging an action to the Shield API.
 */
export interface ActionLogPayload {
  readonly agent: string;
  readonly service: string;
  readonly actionType: string;
  readonly status: ActionStatus;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * A registered agent record returned by the Shield API.
 */
export interface AgentRecord {
  readonly id: string;
  readonly name: string;
}

/**
 * Shape of a permission entry from the agent detail endpoint.
 */
interface PermissionEntry {
  readonly service: string;
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
  readonly revoked_at: string | null;
}

// Type guards for API responses

interface ApiSuccessResponse {
  readonly success: true;
  readonly data: unknown;
}

interface AgentSummary {
  readonly id: string;
  readonly name: string;
}

interface AgentDetail {
  readonly permissions: unknown[];
}

function isApiSuccess(value: unknown): value is ApiSuccessResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj["success"] === true;
}

function isAgentSummary(value: unknown): value is AgentSummary {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["id"] === "string" && typeof obj["name"] === "string";
}

function isAgentDetail(value: unknown): value is AgentDetail {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj["permissions"]);
}

function isPermissionEntry(value: unknown): value is PermissionEntry {
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

/**
 * Find an agent by name via GET /api/v1/agents.
 *
 * @returns The agent record, or `null` if not found or the API is unreachable.
 */
export async function findAgentByName(
  agentName: string,
  apiKey: string,
  baseUrl: string,
): Promise<AgentRecord | null> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/agents`, {
      headers: { [AUTH_HEADER]: apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (!isApiSuccess(body)) return null;

    const agents = body.data;
    if (!Array.isArray(agents)) return null;

    const match = agents.find((a): a is AgentSummary => isAgentSummary(a) && a.name === agentName);

    return match ?? null;
  } catch {
    return null;
  }
}

/**
 * Register a new agent via POST /api/v1/agents.
 *
 * @returns The new agent's ID.
 * @throws {Error} If registration fails.
 */
export async function registerAgent(
  agentName: string,
  apiKey: string,
  baseUrl: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [AUTH_HEADER]: apiKey,
    },
    body: JSON.stringify({ name: agentName }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to register agent "${agentName}": service returned ${String(response.status)}.`,
    );
  }

  const body: unknown = await response.json();
  if (!isApiSuccess(body) || !isAgentSummary(body.data)) {
    throw new Error(`Failed to register agent "${agentName}": unexpected response format.`);
  }

  return body.data.id;
}

/**
 * Find an existing agent or register a new one.
 *
 * @returns The agent record, or `null` if the API is unreachable.
 */
export async function findOrRegisterAgent(
  agentName: string,
  apiKey: string,
  baseUrl: string,
): Promise<AgentRecord | null> {
  const existing = await findAgentByName(agentName, apiKey, baseUrl);
  if (existing !== null) return existing;

  try {
    const id = await registerAgent(agentName, apiKey, baseUrl);
    return { id, name: agentName };
  } catch {
    return null;
  }
}

/**
 * Fetch the granted scopes for an agent via GET /api/v1/agents/{id}.
 *
 * Parses the permissions array and returns only non-revoked scopes.
 *
 * @returns The granted scopes, or an empty array if the API is unreachable.
 */
export async function fetchGrantedScopes(
  agentId: string,
  apiKey: string,
  baseUrl: string,
): Promise<readonly Scope[]> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/agents/${agentId}`, {
      headers: { [AUTH_HEADER]: apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) return [];

    const body: unknown = await response.json();
    if (!isApiSuccess(body)) return [];

    const detail = body.data;
    if (!isAgentDetail(detail)) return [];

    const scopes: Scope[] = [];
    for (const perm of detail.permissions) {
      if (!isPermissionEntry(perm)) continue;
      if (perm.revoked_at !== null) continue;
      if (perm.read) scopes.push({ service: perm.service, permissionLevel: "read" });
      if (perm.write) scopes.push({ service: perm.service, permissionLevel: "write" });
      if (perm.execute) scopes.push({ service: perm.service, permissionLevel: "execute" });
    }

    return scopes;
  } catch {
    return [];
  }
}

/**
 * Log an action to the Shield API via POST /api/v1/actions.
 *
 * This is fire-and-forget. Errors are caught and logged to stderr.
 * The API key is never included in error output.
 */
export async function logAction(
  payload: ActionLogPayload,
  apiKey: string,
  baseUrl: string,
): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/actions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [AUTH_HEADER]: apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      process.stderr.write(
        `[multicorn-shield] Action log failed: HTTP ${String(response.status)}.\n`,
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[multicorn-shield] Action log failed: ${detail}.\n`);
  }
}
