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
import type { PluginLogger } from "./plugin-sdk.types.js";

const REQUEST_TIMEOUT_MS = 5000;
const AUTH_HEADER = "X-Multicorn-Key";
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 100;
const POLL_TIMEOUT_MS = POLL_INTERVAL_MS * MAX_POLLS;

// Module-level flag to track if auth error has been logged (once per session)
let authErrorLogged = false;

/**
 * Reset the auth error logged flag. For testing only.
 */
export function resetAuthErrorFlag(): void {
  authErrorLogged = false;
}

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
 * Response from GET /api/v1/approvals/:id
 */
export interface ApprovalResponse {
  readonly id: string;
  readonly status: "pending" | "approved" | "rejected" | "expired";
  readonly decided_at: string | null;
}

/**
 * `data` shape from GET /api/v1/content-reviews/:id/status when `success` is true.
 */
export interface ContentReviewStatusResponse {
  readonly id: string;
  readonly status: "pending" | "approved" | "blocked" | "timeout";
}

/**
 * Result of {@link requestContentReview} or {@link pollContentReviewStatus}.
 */
export interface ContentReviewResult {
  readonly status: "approved" | "blocked" | "timeout";
  readonly reviewId?: string;
  readonly reason?: string;
}

/**
 * Payload for {@link requestContentReview}. `cost` is optional; the POST body always includes `cost`, defaulting to `0` when omitted (matches {@link LogActionRequest} in the service).
 */
export interface ContentReviewRequestPayload {
  readonly agent: string;
  readonly service: string;
  readonly actionType: string;
  /** Defaults to `0` when omitted. Must be >= 0 if set. */
  readonly cost?: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Result of checking action permission via POST /api/v1/actions
 */
export interface ActionPermissionResult {
  readonly status: "approved" | "pending" | "blocked";
  readonly approvalId?: string;
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
    (obj["revoked_at"] === null ||
      obj["revoked_at"] === undefined ||
      typeof obj["revoked_at"] === "string")
  );
}

function isApprovalResponse(value: unknown): value is ApprovalResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["id"] === "string" &&
    typeof obj["status"] === "string" &&
    ["pending", "approved", "rejected", "expired"].includes(obj["status"]) &&
    (obj["decided_at"] === null || typeof obj["decided_at"] === "string")
  );
}

function isContentReviewStatusResponse(value: unknown): value is ContentReviewStatusResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["id"] === "string" &&
    typeof obj["status"] === "string" &&
    ["pending", "approved", "blocked", "timeout"].includes(obj["status"])
  );
}

function readApiErrorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const err = (body as Record<string, unknown>)["error"];
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : undefined;
}

function isPlanTierInsufficientError(status: number, body: unknown): boolean {
  return status === 403 && readApiErrorCode(body) === "PLAN_TIER_INSUFFICIENT";
}

/**
 * Handle HTTP error responses from the Shield API.
 *
 * Logs appropriate error messages based on status code:
 * - 401/403: Authentication error (logged once per session)
 * - 429: Rate limiting
 * - 5xx: Server errors
 *
 * @param status - HTTP status code
 * @param logger - Optional logger for error messages
 * @param retryDelaySeconds - Optional retry delay for rate limiting (if retrying)
 * @returns Object indicating whether the error should result in blocking (true) or fail-open (false)
 */
function handleHttpError(
  status: number,
  logger?: PluginLogger,
  retryDelaySeconds?: number,
): { shouldBlock: boolean } {
  // 401/403: Authentication failures - must block, log once per session
  if (status === 401 || status === 403) {
    if (!authErrorLogged) {
      authErrorLogged = true;
      const errorMsg =
        "[multicorn-shield] ERROR: Authentication failed. Your MULTICORN_API_KEY is invalid or expired. " +
        "Check the key in your OpenClaw config (~/.openclaw/openclaw.json → plugins.entries.multicorn-shield.env.MULTICORN_API_KEY). " +
        "Get a valid key from your Multicorn dashboard (Settings → API Keys).";
      logger?.error(errorMsg);
      // Also log to stderr for visibility in gateway console
      process.stderr.write(`${errorMsg}\n`);
    }
    return { shouldBlock: true };
  }

  // 429: Rate limiting - fail closed (cannot verify permissions)
  if (status === 429) {
    if (retryDelaySeconds !== undefined) {
      const rateLimitMsg = `[multicorn-shield] Rate limited by Shield API. Retrying in ${String(retryDelaySeconds)}s.`;
      logger?.warn(rateLimitMsg);
      process.stderr.write(`${rateLimitMsg}\n`);
    } else {
      const rateLimitMsg =
        "[multicorn-shield] Rate limited by Shield API. Action blocked: Shield cannot verify permissions.";
      logger?.warn(rateLimitMsg);
      process.stderr.write(`${rateLimitMsg}\n`);
    }
    return { shouldBlock: true };
  }

  // 5xx: Server errors - fail closed (cannot verify permissions)
  if (status >= 500 && status < 600) {
    const serverErrorMsg = `[multicorn-shield] Shield API error (${String(status)}). Action blocked: Shield cannot verify permissions.`;
    logger?.warn(serverErrorMsg);
    process.stderr.write(`${serverErrorMsg}\n`);
    return { shouldBlock: true };
  }

  // Other errors - default to fail closed
  return { shouldBlock: true };
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
  logger?: PluginLogger,
): Promise<AgentRecord | null> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/agents`, {
      headers: { [AUTH_HEADER]: apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      handleHttpError(response.status, logger);
      // 401/403 should block (return null to indicate auth failure)
      // 5xx and other errors can fail-open (return null)
      return null;
    }

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
  logger?: PluginLogger,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [AUTH_HEADER]: apiKey,
    },
    body: JSON.stringify({ name: agentName, platform: "openclaw" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (response.status === 403) {
      const msg = (body?.error?.message ?? "").toLowerCase();
      if (msg.includes("agent limit") || msg.includes("maximum")) {
        throw new Error("Agent limit reached. Upgrade your plan at app.multicorn.ai/settings.");
      }
    }
    handleHttpError(response.status, logger);
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

// Coalesce concurrent findOrRegisterAgent calls for the same key to prevent duplicate agent creation
const findOrRegisterInflight = new Map<string, Promise<AgentRecord | null>>();

/**
 * Find an existing agent or register a new one.
 *
 * Concurrent calls for the same (agentName, apiKey, baseUrl) share one in-flight
 * execution to prevent race conditions that create duplicate agents.
 *
 * @returns The agent record, or `null` if the API is unreachable.
 * @throws {Error} If agent limit is reached (re-thrown from registerAgent).
 */
export async function findOrRegisterAgent(
  agentName: string,
  apiKey: string,
  baseUrl: string,
  logger?: PluginLogger,
): Promise<AgentRecord | null> {
  const key = `${agentName}:${apiKey}:${baseUrl}`;
  const existing = findOrRegisterInflight.get(key);
  if (existing !== undefined) return existing;

  const promise = (async (): Promise<AgentRecord | null> => {
    const found = await findAgentByName(agentName, apiKey, baseUrl, logger);
    if (found !== null) return found;

    try {
      const id = await registerAgent(agentName, apiKey, baseUrl, logger);
      return { id, name: agentName };
    } catch (err) {
      if (err instanceof Error && err.message.includes("Agent limit reached")) {
        throw err;
      }
      return null;
    }
  })().finally(() => {
    findOrRegisterInflight.delete(key);
  });

  findOrRegisterInflight.set(key, promise);
  return promise;
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
  logger?: PluginLogger,
): Promise<readonly Scope[]> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/agents/${agentId}`, {
      headers: { [AUTH_HEADER]: apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      handleHttpError(response.status, logger);
      // 401/403 should block (return empty array to indicate auth failure)
      // 5xx and other errors can fail-open (return empty array)
      return [];
    }

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
 * Check action permission via POST /api/v1/actions.
 *
 * Returns the permission status and approval ID if pending.
 * The service returns:
 * - 201: Action approved, proceed
 * - 202: Action pending approval (approvalId in response)
 * - 403: Action blocked (no approval available)
 *
 * @returns Permission result with status and optional approvalId
 */
export async function checkActionPermission(
  payload: ActionLogPayload,
  apiKey: string,
  baseUrl: string,
  logger?: PluginLogger,
): Promise<ActionPermissionResult> {
  try {
    const requestBody = {
      agent: payload.agent,
      service: payload.service,
      actionType: payload.actionType,
      status: payload.status,
      metadata: payload.metadata,
    };
    console.error("[SHIELD-CLIENT] POST /api/v1/actions request: " + JSON.stringify(requestBody));

    const response = await fetch(`${baseUrl}/api/v1/actions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [AUTH_HEADER]: apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 201) {
      console.error(
        "[SHIELD-CLIENT] response status=201, returning approved (body not read - backend may have failed approval creation)",
      );
      return { status: "approved" };
    }

    if (response.status === 202) {
      const body: unknown = await response.json();
      const data = (isApiSuccess(body) ? body.data : null) as Record<string, unknown> | null;
      console.error("[SHIELD-CLIENT] response status=202 body=" + JSON.stringify(data ?? body));

      if (!isApiSuccess(body) || data === null) {
        return { status: "blocked" };
      }

      const approvalId = typeof data["approval_id"] === "string" ? data["approval_id"] : undefined;
      console.error(
        "[SHIELD-CLIENT] extracted: status=" +
          String(data["status"]) +
          " approval_id=" +
          (approvalId ?? "undefined"),
      );

      if (approvalId === undefined) {
        return { status: "blocked" };
      }

      return { status: "pending", approvalId };
    }

    // Check for auth errors (401/403) - must block
    if (response.status === 401 || response.status === 403) {
      handleHttpError(response.status, logger);
      return { status: "blocked" };
    }

    // Check for rate limiting (429) or server errors (5xx)
    if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
      handleHttpError(response.status, logger);
      // Fail closed: cannot verify permissions
      return { status: "blocked" };
    }

    // Any other error status
    return { status: "blocked" };
  } catch {
    return { status: "blocked" };
  }
}

/**
 * Poll approval status via GET /api/v1/approvals/:id.
 *
 * Polls every 3 seconds for up to 5 minutes (100 polls).
 * Handles network errors with exponential backoff (up to 3 retries per poll).
 *
 * @returns Final approval status: 'approved', 'rejected', 'expired', or 'timeout'
 */
export async function pollApprovalStatus(
  approvalId: string,
  apiKey: string,
  baseUrl: string,
  logger?: PluginLogger,
): Promise<"approved" | "rejected" | "expired" | "timeout"> {
  console.error("[SHIELD-CLIENT] pollApprovalStatus START: approvalId=" + approvalId);

  const startTime = Date.now();

  const logDebug = logger?.debug?.bind(logger) as ((msg: string) => void) | undefined;

  for (let pollCount = 0; pollCount < MAX_POLLS; pollCount++) {
    // Check if we've exceeded the total timeout
    if (Date.now() - startTime >= POLL_TIMEOUT_MS) {
      return "timeout";
    }

    // Try to fetch approval status with retries
    let approval: ApprovalResponse | null = null;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const response = await fetch(`${baseUrl}/api/v1/approvals/${approvalId}`, {
          headers: { [AUTH_HEADER]: apiKey },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          // Handle auth errors (401/403) - these should block
          if (response.status === 401 || response.status === 403) {
            handleHttpError(response.status, logger);
            // Return timeout to indicate failure (auth errors are not transient)
            return "timeout";
          }

          // Handle rate limiting (429) and server errors (5xx)
          if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
            const retryDelay = retry < 2 ? Math.pow(2, retry) : undefined;
            handleHttpError(response.status, logger, retryDelay);
          }

          // Log at debug level - failed polls are expected during normal operation
          logDebug?.(
            `Poll ${String(pollCount + 1)} failed: HTTP ${String(response.status)}. Retrying...`,
          );
          // Exponential backoff: 1s, 2s, 4s
          if (retry < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retry)));
          }
          continue;
        }

        const body: unknown = await response.json();
        if (!isApiSuccess(body)) {
          logDebug?.(`Poll ${String(pollCount + 1)} failed: invalid response format. Retrying...`);
          if (retry < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retry)));
          }
          continue;
        }

        const approvalData = body.data;
        if (!isApprovalResponse(approvalData)) {
          logDebug?.(`Poll ${String(pollCount + 1)} failed: invalid approval data. Retrying...`);
          if (retry < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retry)));
          }
          continue;
        }

        approval = approvalData;
        console.error("[SHIELD-CLIENT] poll response: " + JSON.stringify(approvalData));
        break; // Successfully got a response, exit retry loop
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logDebug?.(`Poll ${String(pollCount + 1)} failed: ${errorMessage}. Retrying...`);
        // Exponential backoff: 1s, 2s, 4s
        if (retry < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retry)));
        }
      }
    }

    // If we got a valid approval response, check its status
    if (approval !== null) {
      if (approval.status === "approved") {
        return "approved";
      }
      if (approval.status === "rejected") {
        return "rejected";
      }
      if (approval.status === "expired") {
        return "expired";
      }
      // Still pending, wait before next poll
      if (pollCount < MAX_POLLS - 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } else {
      // All retries failed, log and continue to next poll
      logDebug?.(`All retries failed for poll ${String(pollCount + 1)}. Continuing...`);
      if (pollCount < MAX_POLLS - 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }
  }

  // Exceeded max polls
  return "timeout";
}

/**
 * Poll content review status via GET /api/v1/content-reviews/:id/status.
 *
 * Same timing and retry behaviour as {@link pollApprovalStatus}: 3s interval, 100 polls, exponential backoff on transient errors.
 *
 * **404 handling:** Unlike {@link pollApprovalStatus}, a missing review is treated as terminal (`review_not_found`) immediately.
 * The approvals poll endpoint can return transient errors for a still-valid id; for content reviews, 404 means the review id is gone (wrong org, deleted, never existed), so retrying until timeout would only waste the 5 minute window.
 *
 * @internal Exported for unit tests only; package consumers should use {@link requestContentReview}.
 */
export async function pollContentReviewStatus(
  reviewId: string,
  apiKey: string,
  baseUrl: string,
  logger?: PluginLogger,
): Promise<ContentReviewResult> {
  const startTime = Date.now();
  const logDebug = logger?.debug?.bind(logger) as ((msg: string) => void) | undefined;

  for (let pollCount = 0; pollCount < MAX_POLLS; pollCount++) {
    if (Date.now() - startTime >= POLL_TIMEOUT_MS) {
      return { status: "timeout", reason: "decision_window_exceeded", reviewId };
    }

    let row: ContentReviewStatusResponse | null = null;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const response = await fetch(`${baseUrl}/api/v1/content-reviews/${reviewId}/status`, {
          headers: { [AUTH_HEADER]: apiKey },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          if (response.status === 404) {
            return { status: "blocked", reason: "review_not_found", reviewId };
          }

          const errBody: unknown = await response.json().catch(() => null);
          if (isPlanTierInsufficientError(response.status, errBody)) {
            return { status: "blocked", reason: "plan_tier_insufficient", reviewId };
          }

          if (response.status === 401 || response.status === 403) {
            handleHttpError(response.status, logger);
            return { status: "blocked", reason: "auth_error", reviewId };
          }

          if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
            const retryDelay = retry < 2 ? Math.pow(2, retry) : undefined;
            handleHttpError(response.status, logger, retryDelay);
          }

          logDebug?.(
            `Content review poll ${String(pollCount + 1)} failed: HTTP ${String(response.status)}. Retrying...`,
          );
          if (retry < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retry)));
          }
          continue;
        }

        const body: unknown = await response.json();
        if (!isApiSuccess(body)) {
          logDebug?.(
            `Content review poll ${String(pollCount + 1)} failed: invalid response format. Retrying...`,
          );
          if (retry < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retry)));
          }
          continue;
        }

        const statusData = body.data;
        if (!isContentReviewStatusResponse(statusData)) {
          logDebug?.(
            `Content review poll ${String(pollCount + 1)} failed: invalid status data. Retrying...`,
          );
          if (retry < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retry)));
          }
          continue;
        }

        row = statusData;
        break;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logDebug?.(
          `Content review poll ${String(pollCount + 1)} failed: ${errorMessage}. Retrying...`,
        );
        if (retry < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retry)));
        }
      }
    }

    if (row !== null) {
      if (row.status === "approved") {
        return { status: "approved", reviewId };
      }
      if (row.status === "blocked") {
        return { status: "blocked", reason: "blocked_by_reviewer", reviewId };
      }
      if (row.status === "timeout") {
        return { status: "timeout", reason: "decision_window_exceeded", reviewId };
      }
      if (pollCount < MAX_POLLS - 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } else {
      logDebug?.(
        `All retries failed for content review poll ${String(pollCount + 1)}. Continuing...`,
      );
      if (pollCount < MAX_POLLS - 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }
  }

  return { status: "timeout", reason: "decision_window_exceeded", reviewId };
}

/**
 * Create a content-review request via POST /api/v1/actions with `status: "requires_approval"`, then poll until decided.
 *
 * Wire format: response `data.content_review_id` (snake_case) per service Jackson naming.
 */
export async function requestContentReview(
  payload: ContentReviewRequestPayload,
  apiKey: string,
  baseUrl: string,
  logger?: PluginLogger,
): Promise<ContentReviewResult> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/actions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [AUTH_HEADER]: apiKey,
      },
      body: JSON.stringify({
        agent: payload.agent,
        service: payload.service,
        actionType: payload.actionType,
        status: "requires_approval",
        cost: payload.cost ?? 0,
        metadata: payload.metadata,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const body: unknown = await response.json().catch(() => null);

    if (isPlanTierInsufficientError(response.status, body)) {
      return { status: "blocked", reason: "plan_tier_insufficient" };
    }

    if (response.status === 401 || response.status === 403) {
      handleHttpError(response.status, logger);
      return { status: "blocked", reason: "auth_error" };
    }

    if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
      handleHttpError(response.status, logger);
      return { status: "blocked", reason: "service_unavailable" };
    }

    if (response.status === 202) {
      if (!isApiSuccess(body)) {
        return { status: "blocked", reason: "no_review_id" };
      }
      const data = body.data;
      if (typeof data !== "object" || data === null) {
        return { status: "blocked", reason: "no_review_id" };
      }
      const record = data as Record<string, unknown>;
      const rid = record["content_review_id"];
      const reviewId = typeof rid === "string" ? rid : undefined;
      if (reviewId === undefined) {
        return { status: "blocked", reason: "no_review_id" };
      }
      const polled = await pollContentReviewStatus(reviewId, apiKey, baseUrl, logger);
      return { ...polled, reviewId };
    }

    if (response.status === 201) {
      return { status: "blocked", reason: "no_review_id" };
    }

    return { status: "blocked", reason: "service_unavailable" };
  } catch {
    return { status: "blocked", reason: "network_error" };
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
  logger?: PluginLogger,
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
      // Use handleHttpError for consistent error messaging
      handleHttpError(response.status, logger);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[multicorn-shield] Action log failed: ${detail}.\n`);
  }
}
