/**
 * Scope validation engine.
 *
 * Given a set of granted scopes and a requested action, determines whether
 * the action is permitted. Returns a structured result with a human-readable
 * reason when access is denied — no silent failures, no implicit grants.
 *
 * **Design principle (Jordan persona):** Every permission must be explicitly
 * granted. `read` does **not** imply `write`; `write` does **not** imply
 * `execute`. There is no wildcard or superuser bypass.
 *
 * @module scopes/scope-validator
 */

import { type Scope } from "../types/index.js";
import { formatScope } from "./scope-parser.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * The outcome of a scope validation check.
 *
 * - When `allowed` is `true`, no `reason` is present.
 * - When `allowed` is `false`, `reason` contains a descriptive explanation
 *   of why the action was denied.
 *
 * @example
 * ```ts
 * const result = validateScopeAccess(granted, requested);
 * if (!result.allowed) {
 *   console.warn(`Denied: ${result.reason}`);
 * }
 * ```
 */
export interface ValidationResult {
  /** Whether the requested action is permitted by the granted scopes. */
  readonly allowed: boolean;
  /**
   * Human-readable explanation of why the action was denied.
   * Only present when `allowed` is `false`.
   */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Single-scope validation
// ---------------------------------------------------------------------------

/**
 * Check whether a single requested scope is covered by the granted set.
 *
 * Matching is **exact**: the granted set must contain an entry with the
 * same `service` **and** `permissionLevel`. No implicit escalation is
 * performed (e.g. `write` does not subsume `read`).
 *
 * @param grantedScopes - The scopes the agent has been granted via consent.
 * @param requested - The scope required by the action the agent wants to perform.
 * @returns A {@link ValidationResult} indicating whether access is allowed.
 *
 * @example
 * ```ts
 * const granted = [
 *   { service: "gmail", permissionLevel: "read" },
 *   { service: "gmail", permissionLevel: "write" },
 * ];
 *
 * validateScopeAccess(granted, { service: "gmail", permissionLevel: "read" });
 * // → { allowed: true }
 *
 * validateScopeAccess(granted, { service: "gmail", permissionLevel: "execute" });
 * // → { allowed: false, reason: "Permission \"execute\" is not granted …" }
 *
 * validateScopeAccess(granted, { service: "slack", permissionLevel: "read" });
 * // → { allowed: false, reason: "No permissions granted for service \"slack\" …" }
 * ```
 */
export function validateScopeAccess(
  grantedScopes: readonly Scope[],
  requested: Scope,
): ValidationResult {
  // Fast path: exact match
  const isGranted = grantedScopes.some(
    (granted) =>
      granted.service === requested.service &&
      granted.permissionLevel === requested.permissionLevel,
  );

  if (isGranted) {
    return { allowed: true };
  }

  // Build a descriptive denial reason
  const serviceScopes = grantedScopes.filter(
    (g) => g.service === requested.service,
  );

  if (serviceScopes.length > 0) {
    const grantedLevels = serviceScopes
      .map((g) => `"${g.permissionLevel}"`)
      .join(", ");

    return {
      allowed: false,
      reason:
        `Permission "${requested.permissionLevel}" is not granted for service "${requested.service}". ` +
        `Currently granted permission level(s): ${grantedLevels}. ` +
        `Requested scope "${formatScope(requested)}" requires explicit consent.`,
    };
  }

  return {
    allowed: false,
    reason:
      `No permissions granted for service "${requested.service}". ` +
      "The agent has not been authorised to access this service. " +
      `Request scope "${formatScope(requested)}" via the consent screen.`,
  };
}

// ---------------------------------------------------------------------------
// Multi-scope validation
// ---------------------------------------------------------------------------

/**
 * Check whether **all** requested scopes are covered by the granted set.
 *
 * Validation stops at the **first** denied scope and returns its reason.
 * This ensures the caller receives the most specific failure information
 * without needing to iterate themselves.
 *
 * @param grantedScopes - The scopes the agent has been granted.
 * @param requestedScopes - All scopes required by the action.
 * @returns A {@link ValidationResult} — allowed only if **every** scope matches.
 *
 * @example
 * ```ts
 * const granted = [
 *   { service: "gmail", permissionLevel: "read" },
 *   { service: "calendar", permissionLevel: "write" },
 * ];
 *
 * validateAllScopesAccess(granted, [
 *   { service: "gmail", permissionLevel: "read" },
 *   { service: "calendar", permissionLevel: "write" },
 * ]);
 * // → { allowed: true }
 *
 * validateAllScopesAccess(granted, [
 *   { service: "gmail", permissionLevel: "read" },
 *   { service: "slack", permissionLevel: "read" },
 * ]);
 * // → { allowed: false, reason: "No permissions granted for service \"slack\" …" }
 * ```
 */
export function validateAllScopesAccess(
  grantedScopes: readonly Scope[],
  requestedScopes: readonly Scope[],
): ValidationResult {
  if (requestedScopes.length === 0) {
    return { allowed: true };
  }

  for (const requested of requestedScopes) {
    const result = validateScopeAccess(grantedScopes, requested);
    if (!result.allowed) {
      return result;
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Convenience boolean helper
// ---------------------------------------------------------------------------

/**
 * Quick boolean check for whether a single scope is granted.
 *
 * Equivalent to `validateScopeAccess(granted, requested).allowed` but
 * avoids allocating a result object, making it suitable for hot paths.
 *
 * @param grantedScopes - The scopes the agent has been granted.
 * @param requested - The scope to check.
 * @returns `true` if the scope is explicitly granted.
 *
 * @example
 * ```ts
 * if (hasScope(agent.scopes, { service: "payments", permissionLevel: "execute" })) {
 *   // proceed with payment
 * }
 * ```
 */
export function hasScope(
  grantedScopes: readonly Scope[],
  requested: Scope,
): boolean {
  return grantedScopes.some(
    (granted) =>
      granted.service === requested.service &&
      granted.permissionLevel === requested.permissionLevel,
  );
}
