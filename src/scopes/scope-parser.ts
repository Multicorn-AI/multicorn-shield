/**
 * Scope string parser and formatter.
 *
 * Parses human-readable scope strings (e.g. `"read:gmail"`) into structured
 * {@link Scope} objects and formats them back. Validates format, permission
 * level, and service name — rejecting malformed input with clear, actionable
 * error messages.
 *
 * @module scopes/scope-parser
 */

import {
  type PermissionLevel,
  type Scope,
  PERMISSION_LEVELS,
} from "../types/index.js";
import { SERVICE_NAME_PATTERN } from "./scope-definitions.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Set of valid permission level strings for fast membership checks.
 * @internal
 */
const VALID_PERMISSION_LEVELS: ReadonlySet<string> = new Set(
  Object.values(PERMISSION_LEVELS),
);

/**
 * Display-friendly list of valid permission levels, used in error messages.
 * @internal
 */
const PERMISSION_LEVEL_LIST: string = [...VALID_PERMISSION_LEVELS].join(
  ", ",
);

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Error thrown when a scope string cannot be parsed.
 *
 * Contains the original input string so callers can include it in logs or
 * user-facing feedback.
 *
 * @example
 * ```ts
 * try {
 *   parseScope("bad-scope");
 * } catch (error) {
 *   if (error instanceof ScopeParseError) {
 *     console.error(error.message); // descriptive message
 *     console.error(error.input);   // "bad-scope"
 *   }
 * }
 * ```
 */
export class ScopeParseError extends Error {
  /** The original scope string that failed to parse. */
  readonly input: string;

  constructor(message: string, input: string) {
    super(message);
    this.name = "ScopeParseError";
    this.input = input;
  }
}

// ---------------------------------------------------------------------------
// Result type for tryParseScope
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by {@link tryParseScope}.
 *
 * - On success: `{ success: true, scope: Scope }`
 * - On failure: `{ success: false, error: string }`
 */
export type ScopeParseResult =
  | { readonly success: true; readonly scope: Scope }
  | { readonly success: false; readonly error: string };

// ---------------------------------------------------------------------------
// Core parsing logic (private)
// ---------------------------------------------------------------------------

/**
 * Validates and parses a scope string, returning either a Scope or an error message.
 * @internal
 */
function doParse(input: string): ScopeParseResult {
  // 1. Empty or whitespace-only
  if (input.length === 0) {
    return {
      success: false,
      error:
        "Scope string must not be empty. " +
        'Expected format: "permission:service" (e.g. "read:gmail").',
    };
  }

  // 2. Whitespace check (no leading/trailing/internal whitespace)
  if (/\s/.test(input)) {
    return {
      success: false,
      error:
        `Scope string "${input}" contains whitespace. ` +
        "Remove any spaces, tabs, or newlines. " +
        'Expected format: "permission:service" (e.g. "read:gmail").',
    };
  }

  // 3. Must contain exactly one colon
  const colonIndex = input.indexOf(":");
  if (colonIndex === -1) {
    return {
      success: false,
      error:
        `Invalid scope string "${input}": missing ":" separator. ` +
        'Expected format: "permission:service" (e.g. "read:gmail").',
    };
  }

  if (input.includes(":", colonIndex + 1)) {
    return {
      success: false,
      error:
        `Invalid scope string "${input}": contains multiple ":" separators. ` +
        'Expected exactly one ":" separating permission and service ' +
        '(e.g. "read:gmail").',
    };
  }

  // 4. Extract parts
  const permission = input.slice(0, colonIndex);
  const service = input.slice(colonIndex + 1);

  // 5. Validate permission level
  if (permission.length === 0) {
    return {
      success: false,
      error:
        `Invalid scope string "${input}": permission level is empty. ` +
        `Provide one of: ${PERMISSION_LEVEL_LIST} ` +
        '(e.g. "read:gmail").',
    };
  }

  if (!VALID_PERMISSION_LEVELS.has(permission)) {
    return {
      success: false,
      error:
        `Unknown permission level "${permission}" in scope string "${input}". ` +
        `Valid permission levels are: ${PERMISSION_LEVEL_LIST}.`,
    };
  }

  // 6. Validate service name
  if (service.length === 0) {
    return {
      success: false,
      error:
        `Invalid scope string "${input}": service name is empty. ` +
        'Provide a service name after the ":" ' +
        '(e.g. "read:gmail").',
    };
  }

  if (!SERVICE_NAME_PATTERN.test(service)) {
    return {
      success: false,
      error:
        `Invalid service name "${service}" in scope string "${input}". ` +
        "Service names must start with a lowercase letter and contain only " +
        'lowercase letters, digits, hyphens, or underscores (e.g. "gmail", "my-service").',
    };
  }

  return {
    success: true,
    scope: {
      service,
      permissionLevel: permission as PermissionLevel,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a scope string into a structured {@link Scope} object.
 *
 * Scope strings use the format `"permission:service"` where:
 * - **permission** is one of `read`, `write`, or `execute`
 * - **service** is a lowercase identifier (letters, digits, hyphens, underscores)
 *
 * @param input - The scope string to parse (e.g. `"read:gmail"`).
 * @returns A validated {@link Scope} object.
 * @throws {ScopeParseError} If the input is malformed, with a descriptive message.
 *
 * @example
 * ```ts
 * const scope = parseScope("read:gmail");
 * // → { service: "gmail", permissionLevel: "read" }
 * ```
 *
 * @example
 * ```ts
 * parseScope("delete:gmail");
 * // throws ScopeParseError: Unknown permission level "delete" …
 * ```
 */
export function parseScope(input: string): Scope {
  const result = doParse(input);
  if (result.success) {
    return result.scope;
  }
  throw new ScopeParseError(result.error, input);
}

/**
 * Parse multiple scope strings into an array of {@link Scope} objects.
 *
 * All strings must be valid; parsing stops at the first invalid string
 * and throws a {@link ScopeParseError}.
 *
 * @param inputs - An array of scope strings to parse.
 * @returns An array of validated {@link Scope} objects.
 * @throws {ScopeParseError} If any input string is malformed.
 *
 * @example
 * ```ts
 * const scopes = parseScopes(["read:gmail", "write:calendar"]);
 * // → [
 * //   { service: "gmail", permissionLevel: "read" },
 * //   { service: "calendar", permissionLevel: "write" },
 * // ]
 * ```
 */
export function parseScopes(inputs: readonly string[]): readonly Scope[] {
  const results: Scope[] = [];
  for (const input of inputs) {
    results.push(parseScope(input));
  }
  return results;
}

/**
 * Attempt to parse a scope string without throwing.
 *
 * Returns a discriminated union: check the `success` field to determine
 * whether parsing succeeded and access either the `scope` or the `error`.
 *
 * @param input - The scope string to parse.
 * @returns A {@link ScopeParseResult} — either `{ success: true, scope }` or `{ success: false, error }`.
 *
 * @example
 * ```ts
 * const result = tryParseScope("read:gmail");
 * if (result.success) {
 *   console.log(result.scope.service); // "gmail"
 * } else {
 *   console.error(result.error);
 * }
 * ```
 */
export function tryParseScope(input: string): ScopeParseResult {
  return doParse(input);
}

/**
 * Format a {@link Scope} object back into its canonical string representation.
 *
 * @param scope - The scope to format.
 * @returns The scope string in `"permission:service"` format.
 *
 * @example
 * ```ts
 * formatScope({ service: "gmail", permissionLevel: "read" });
 * // → "read:gmail"
 * ```
 */
export function formatScope(scope: Scope): string {
  return `${scope.permissionLevel}:${scope.service}`;
}

/**
 * Check whether a string is a valid scope string without throwing or
 * allocating a result object.
 *
 * Useful for quick guard checks in hot paths.
 *
 * @param input - The string to test.
 * @returns `true` if the string can be parsed as a valid scope.
 *
 * @example
 * ```ts
 * isValidScopeString("read:gmail");     // true
 * isValidScopeString("delete:gmail");   // false
 * isValidScopeString("");               // false
 * ```
 */
export function isValidScopeString(input: string): boolean {
  return doParse(input).success;
}
