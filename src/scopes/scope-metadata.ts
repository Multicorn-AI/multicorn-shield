/**
 * Scope metadata for risk classification and consent behavior.
 *
 * Provides metadata about scopes including risk level, whether they require
 * explicit opt-in, and warning messages for high-risk scopes.
 *
 * @module scopes/scope-metadata
 */

/**
 * Metadata describing a scope's risk classification and consent behavior.
 */
export interface ScopeMetadata {
  /** Risk level classification: 'standard' for normal scopes, 'high' for high-risk scopes. */
  readonly riskLevel: "standard" | "high";
  /** Whether this scope requires explicit opt-in (defaults to OFF in consent screen). */
  readonly requiresExplicitOptIn: boolean;
  /** Optional warning message shown when this scope is requested (plain language for users). */
  readonly warningMessage?: string;
}

/**
 * Metadata registry for scopes.
 *
 * Maps scope strings (e.g., "publish:web") to their metadata. High-risk scopes
 * are classified here and will show warnings in the consent screen.
 */
export const SCOPE_METADATA: ReadonlyMap<string, ScopeMetadata> = new Map([
  [
    "publish:web",
    {
      riskLevel: "high",
      requiresExplicitOptIn: true,
      warningMessage:
        "This agent is requesting permission to publish content publicly on the internet",
    },
  ],
  [
    "create:public_content",
    {
      riskLevel: "high",
      requiresExplicitOptIn: true,
      warningMessage:
        "This agent is requesting permission to publish content publicly on the internet",
    },
  ],
]);

/**
 * Get metadata for a scope string.
 *
 * @param scopeString - The scope string (e.g., "publish:web").
 * @returns The scope metadata, or undefined if not found.
 *
 * @example
 * ```ts
 * const metadata = getScopeMetadata("publish:web");
 * // → { riskLevel: "high", requiresExplicitOptIn: true, ... }
 * ```
 */
export function getScopeMetadata(scopeString: string): ScopeMetadata | undefined {
  return SCOPE_METADATA.get(scopeString);
}

/**
 * Check if a scope is classified as high-risk.
 *
 * @param scopeString - The scope string to check.
 * @returns `true` if the scope is high-risk, `false` otherwise.
 *
 * @example
 * ```ts
 * isHighRiskScope("publish:web"); // true
 * isHighRiskScope("read:gmail");   // false
 * ```
 */
export function isHighRiskScope(scopeString: string): boolean {
  const metadata = getScopeMetadata(scopeString);
  return metadata?.riskLevel === "high";
}

/**
 * Check if a scope requires explicit opt-in.
 *
 * @param scopeString - The scope string to check.
 * @returns `true` if the scope requires explicit opt-in, `false` otherwise.
 *
 * @example
 * ```ts
 * requiresExplicitOptIn("publish:web"); // true
 * requiresExplicitOptIn("read:gmail");  // false
 * ```
 */
export function requiresExplicitOptIn(scopeString: string): boolean {
  const metadata = getScopeMetadata(scopeString);
  return metadata?.requiresExplicitOptIn ?? false;
}

/**
 * Get the warning message for a scope, if any.
 *
 * @param scopeString - The scope string to check.
 * @returns The warning message, or undefined if none.
 *
 * @example
 * ```ts
 * getScopeWarning("publish:web");
 * // → "This agent is requesting permission to publish content publicly on the internet"
 * ```
 */
export function getScopeWarning(scopeString: string): string | undefined {
  const metadata = getScopeMetadata(scopeString);
  return metadata?.warningMessage;
}
