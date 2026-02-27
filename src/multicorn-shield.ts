/**
 * MulticornShield: the primary SDK entry point.
 *
 * Orchestrates agent permission consent, action logging, scope validation, and
 * spending controls into a single cohesive API.
 *
 * **Security note:** The API key is stored in a private class field. It cannot
 * be accessed outside this class, is never written to `localStorage`, cookies,
 * session storage, or any DOM attribute.
 *
 * @example Quick start
 * ```ts
 * const shield = new MulticornShield({ apiKey: 'mcs_...' });
 *
 * await shield.requestConsent({
 *   agent: 'OpenClaw',
 *   scopes: ['read:gmail', 'write:calendar'],
 *   spendLimit: 200,
 * });
 *
 * await shield.logAction({
 *   agent: 'OpenClaw',
 *   service: 'gmail',
 *   action: 'send_email',
 *   status: 'approved',
 * });
 *
 * shield.destroy();
 * ```
 *
 * @module multicorn-shield
 */

import {
  createActionLogger,
  type ActionLogger,
  type ActionPayload,
  type BatchModeConfig,
} from "./logger/action-logger.js";
import {
  createSpendingChecker,
  dollarsToCents,
  type SpendingChecker,
  type SpendingCheckResult,
} from "./spending/spending-checker.js";
import { parseScope, parseScopes } from "./scopes/scope-parser.js";
import type { Scope, ConsentDecision, ScopeRequest, ActionStatus } from "./types/index.js";
import { CONSENT_ELEMENT_TAG } from "./consent/multicorn-consent.js";

/**
 * The subset of `<multicorn-consent>` properties set programmatically.
 * Using a local interface avoids importing the full Lit element class
 * just for property assignment.
 */
interface ConsentElement extends HTMLElement {
  agentName: string;
  scopes: Scope[];
  spendLimit: number;
  agentColor: string;
}
import type {
  ConsentGrantedEventDetail,
  ConsentPartialEventDetail,
  ConsentDeniedEventDetail,
} from "./consent/consent-events.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_KEY_PREFIX = "mcs_";

/**
 * Convert a Scope object to a scope string format expected by the backend.
 * @example { service: "gmail", permissionLevel: "read" } → "gmail:read"
 */
function formatScope(scope: Scope): string {
  return `${scope.service}:${scope.permissionLevel}`;
}

/**
 * Convert an array of Scope objects to scope strings.
 */
function formatScopes(scopes: readonly Scope[]): readonly string[] {
  return scopes.map(formatScope);
}

/**
 * Minimum total length for a valid API key (prefix + key material).
 * Ensures keys have sufficient entropy beyond the `mcs_` prefix.
 */
const MIN_API_KEY_LENGTH = 16;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for creating a {@link MulticornShield} instance.
 *
 * @example
 * ```ts
 * const shield = new MulticornShield({
 *   apiKey: 'mcs_your_key_here',
 *   baseUrl: 'https://api.multicorn.ai',
 *   timeout: 5000,
 * });
 * ```
 */
export interface MulticornShieldConfig {
  /**
   * Your Multicorn API key.
   * Must start with `mcs_` and be at least 16 characters.
   * Stored in memory only. Never written to localStorage, cookies, or DOM.
   */
  readonly apiKey: string;

  /**
   * Base URL for the Multicorn API.
   * @default "https://api.multicorn.ai"
   */
  readonly baseUrl?: string;

  /**
   * Request timeout in milliseconds.
   * @default 5000
   */
  readonly timeout?: number;

  /**
   * Optional batch mode for action logging.
   * When enabled, actions are queued and flushed periodically rather than
   * sent immediately.
   */
  readonly batchMode?: BatchModeConfig;
}

/**
 * Options for requesting agent permission consent from the user.
 *
 * @example
 * ```ts
 * await shield.requestConsent({
 *   agent: 'OpenClaw',
 *   scopes: ['read:gmail', 'write:calendar'],
 *   spendLimit: 200,
 * });
 * ```
 */
export interface ConsentOptions {
  /**
   * The name or identifier of the agent requesting access.
   * Shown on the consent screen as the requesting agent.
   */
  readonly agent: string;

  /**
   * Scope strings the agent is requesting.
   * Format: `"permission:service"`, e.g. `"read:gmail"`, `"write:calendar"`.
   */
  readonly scopes: readonly string[];

  /**
   * Maximum spend per transaction the agent is allowed without further
   * approval (in dollars). Omit or set to 0 to disable spending controls.
   */
  readonly spendLimit?: number;

  /**
   * Hex colour used for the agent's icon on the consent screen.
   * @default "#8b5cf6"
   */
  readonly agentColor?: string;
}

/**
 * An action taken by an agent to be audited and logged.
 *
 * @example
 * ```ts
 * await shield.logAction({
 *   agent: 'OpenClaw',
 *   service: 'gmail',
 *   action: 'send_email',
 *   status: 'approved',
 *   cost: 0.002,
 * });
 * ```
 */
export interface ActionInput {
  /** Agent identifier. Must match the `agent` value used in `requestConsent`. */
  readonly agent: string;

  /** The service the agent accessed (e.g. `"gmail"`, `"calendar"`). */
  readonly service: string;

  /** The type of action performed (e.g. `"send_email"`, `"read_message"`). */
  readonly action: string;

  /** The outcome of the action. */
  readonly status: ActionStatus;

  /**
   * Optional cost in USD incurred by this action.
   * Present only for actions with usage-based pricing.
   */
  readonly cost?: number;

  /** Optional structured metadata for additional context. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The result of a pre-flight spending check.
 *
 * - When `allowed` is `true`, the action can proceed.
 * - When `allowed` is `false`, `reason` describes which limit was exceeded.
 */
export type SpendCheckResult = SpendingCheckResult;

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * The main entry point for the Multicorn Shield SDK.
 *
 * Orchestrates agent permission consent, action logging, scope enforcement,
 * and spending controls. Intended to be instantiated once per application
 * and reused across agent interactions.
 *
 * @example
 * ```ts
 * const shield = new MulticornShield({ apiKey: 'mcs_...' });
 *
 * await shield.requestConsent({
 *   agent: 'OpenClaw',
 *   scopes: ['read:gmail', 'write:calendar'],
 *   spendLimit: 200,
 * });
 *
 * await shield.logAction({
 *   agent: 'OpenClaw',
 *   service: 'gmail',
 *   action: 'send_email',
 *   status: 'approved',
 * });
 * ```
 */
export class MulticornShield {
  // Private class fields for true runtime privacy.
  // #apiKey is unreachable outside this class at the JS level, not just compile time.
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #logger: ActionLogger;
  readonly #grantedScopes = new Map<string, Scope[]>();
  readonly #spendingCheckers = new Map<string, SpendingChecker>();
  #consentContainer: HTMLElement | null = null;
  #isDestroyed = false;

  /**
   * Create a new MulticornShield instance.
   *
   * @param config - SDK configuration options.
   * @throws {Error} If the API key is missing, incorrectly formatted, or too short.
   *
   * @example
   * ```ts
   * const shield = new MulticornShield({ apiKey: 'mcs_your_key_here' });
   * ```
   */
  constructor(config: MulticornShieldConfig) {
    validateApiKey(config.apiKey);

    // Held in a private field, unreachable outside this class instance.
    this.#apiKey = config.apiKey;
    this.#baseUrl = config.baseUrl ?? "https://api.multicorn.ai";

    this.#logger = createActionLogger({
      apiKey: this.#apiKey,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      ...(config.batchMode !== undefined ? { batchMode: config.batchMode } : {}),
    });
  }

  /**
   * Show the consent screen and wait for the user's decision.
   *
   * Mounts the `<multicorn-consent>` web component to the document body,
   * resolves with the user's decision (granted scopes, approved spend limit,
   * and a timestamp), then removes the element from the DOM.
   *
   * Granted scopes are stored internally and enforced on every subsequent
   * {@link logAction} call.
   *
   * @param options - What to request consent for.
   * @returns The user's consent decision including which scopes were granted.
   * @throws {ScopeParseError} If any scope string is malformed.
   * @throws {Error} If the instance has been destroyed.
   *
   * @example
   * ```ts
   * const decision = await shield.requestConsent({
   *   agent: 'OpenClaw',
   *   scopes: ['read:gmail', 'write:calendar'],
   *   spendLimit: 200,
   * });
   *
   * console.log(decision.grantedScopes.map(s => `${s.permissionLevel}:${s.service}`));
   * ```
   */
  async requestConsent(options: ConsentOptions): Promise<ConsentDecision> {
    this.#assertNotDestroyed();

    // Parse and validate all scope strings up front to fail fast with clear errors.
    const parsedScopes = parseScopes(options.scopes);

    const scopeRequest: ScopeRequest = {
      agentName: options.agent,
      scopes: parsedScopes,
      spendLimit: options.spendLimit ?? 0,
    };

    return new Promise<ConsentDecision>((resolve) => {
      const container = document.createElement("div");
      this.#consentContainer = container;
      document.body.appendChild(container);

      const element = document.createElement(CONSENT_ELEMENT_TAG) as ConsentElement;
      element.agentName = options.agent;
      element.scopes = [...parsedScopes];
      element.spendLimit = options.spendLimit ?? 0;

      if (options.agentColor !== undefined) {
        element.agentColor = options.agentColor;
      }

      const cleanup = (): void => {
        element.remove();
        container.remove();
        if (this.#consentContainer === container) {
          this.#consentContainer = null;
        }
      };

      element.addEventListener("consent-granted", (event) => {
        const detail = (event as CustomEvent<ConsentGrantedEventDetail>).detail;
        this.#grantedScopes.set(options.agent, [...detail.grantedScopes]);
        if (detail.spendLimit > 0) {
          this.#setupSpendingChecker(options.agent, detail.spendLimit);
        }

        // POST granted scopes to backend (fire-and-forget)
        void this.#postConsentToBackend(
          options.agent,
          detail.grantedScopes,
          [],
          detail.spendLimit,
          detail.timestamp,
        ).catch((error: unknown) => {
          // Log error but don't block the consent resolution
          // The user has already granted consent, so we resolve the promise
          // even if the backend call fails (fire-and-forget pattern)
          console.warn(
            "[MulticornShield] Failed to store consent to backend:",
            error instanceof Error ? error.message : String(error),
          );
        });

        cleanup();
        resolve({
          scopeRequest,
          grantedScopes: detail.grantedScopes,
          timestamp: detail.timestamp,
        });
      });

      element.addEventListener("consent-partial", (event) => {
        const detail = (event as CustomEvent<ConsentPartialEventDetail>).detail;
        this.#grantedScopes.set(options.agent, [...detail.grantedScopes]);
        if (detail.spendLimit > 0) {
          this.#setupSpendingChecker(options.agent, detail.spendLimit);
        }

        // POST granted and denied scopes to backend (fire-and-forget)
        void this.#postConsentToBackend(
          options.agent,
          detail.grantedScopes,
          detail.deniedScopes,
          detail.spendLimit,
          detail.timestamp,
        ).catch((error: unknown) => {
          // Log error but don't block the consent resolution
          console.warn(
            "[MulticornShield] Failed to store consent to backend:",
            error instanceof Error ? error.message : String(error),
          );
        });

        cleanup();
        resolve({
          scopeRequest,
          grantedScopes: detail.grantedScopes,
          timestamp: detail.timestamp,
        });
      });

      element.addEventListener("consent-denied", (event) => {
        const detail = (event as CustomEvent<ConsentDeniedEventDetail>).detail;
        this.#grantedScopes.set(options.agent, []);
        cleanup();
        resolve({
          scopeRequest,
          grantedScopes: [],
          timestamp: detail.timestamp,
        });
      });

      container.appendChild(element);
    });
  }

  /**
   * Log an action taken by an agent.
   *
   * Verifies that the agent has a granted permission for the target service
   * before submitting the log entry. Throws with a descriptive error if
   * access was never granted or has been revoked. Actions are never silently
   * discarded.
   *
   * @param action - The action to log.
   * @returns Resolves when the log entry has been submitted (or queued in batch mode).
   * @throws {Error} If the agent does not have a granted scope for the service.
   * @throws {Error} If the instance has been destroyed.
   *
   * @example
   * ```ts
   * await shield.logAction({
   *   agent: 'OpenClaw',
   *   service: 'gmail',
   *   action: 'send_email',
   *   status: 'approved',
   * });
   * ```
   */
  async logAction(action: ActionInput): Promise<void> {
    this.#assertNotDestroyed();

    const granted = this.#grantedScopes.get(action.agent) ?? [];
    const hasPermissionForService = granted.some((s) => s.service === action.service);

    const payload: ActionPayload = {
      agent: action.agent,
      service: action.service,
      actionType: action.action,
      status: hasPermissionForService ? action.status : "blocked",
      ...(action.cost !== undefined ? { cost: action.cost } : {}),
      ...(action.metadata !== undefined ? { metadata: action.metadata } : {}),
    };

    await this.#logger.logAction(payload);

    if (!hasPermissionForService) {
      const grantedServiceList = [...new Set(granted.map((s) => s.service))].join(", ") || "none";
      throw new Error(
        `[MulticornShield] Agent "${action.agent}" does not have permission to access "${action.service}". ` +
          `Services with granted access: ${grantedServiceList}. ` +
          "Call requestConsent() to grant access.",
      );
    }
  }

  /**
   * POST granted scopes to the backend consent endpoint.
   * @private
   */
  async #postConsentToBackend(
    agentName: string,
    grantedScopes: readonly Scope[],
    deniedScopes: readonly Scope[],
    spendLimit: number,
    timestamp: string,
  ): Promise<void> {
    this.#assertNotDestroyed();

    // Only POST if there are granted scopes (backend requires at least one)
    if (grantedScopes.length === 0) {
      return;
    }

    const endpoint = `${this.#baseUrl}/api/v1/consent`;
    const grantedScopeStrings = formatScopes(grantedScopes);
    const deniedScopeStrings = formatScopes(deniedScopes);

    // Convert spend limit from dollars to cents (backend expects cents)
    // Backend accepts null for spendLimit, so send null if 0
    const spendLimitCents = spendLimit > 0 ? Math.round(spendLimit * 100) : null;

    // Backend expects snake_case field names due to SNAKE_CASE Jackson strategy
    // agent maps to agentName via @JsonProperty("agent")
    const payload = {
      agent: agentName,
      granted_scopes: grantedScopeStrings,
      denied_scopes: deniedScopeStrings,
      spend_limit: spendLimitCents,
      timestamp: timestamp,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 10000); // 10 second timeout

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Multicorn-Key": this.#apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `Failed to store consent: ${String(response.status)} ${response.statusText}. ${errorText}`,
        );
      }
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Consent POST request timed out");
      }
      throw error;
    }
  }

  /**
   * Immediately revoke a specific scope for an agent.
   *
   * Any subsequent {@link logAction} calls that require access to that service
   * will be rejected. The revocation takes effect synchronously.
   *
   * @param agentId - The agent whose scope should be revoked.
   * @param scope - The scope string to revoke (e.g. `"write:calendar"`).
   * @throws {ScopeParseError} If the scope string is malformed.
   * @throws {Error} If the instance has been destroyed.
   *
   * @example
   * ```ts
   * // OpenClaw can no longer write to calendar
   * shield.revokeScope('OpenClaw', 'write:calendar');
   * ```
   */
  revokeScope(agentId: string, scope: string): void {
    this.#assertNotDestroyed();

    const parsed = parseScope(scope);
    const current = this.#grantedScopes.get(agentId) ?? [];

    this.#grantedScopes.set(
      agentId,
      current.filter(
        (s) => !(s.service === parsed.service && s.permissionLevel === parsed.permissionLevel),
      ),
    );
  }

  /**
   * Return the current granted scopes for an agent.
   *
   * @param agentId - The agent to query.
   * @returns The scopes granted to this agent. Empty array if none have been granted.
   * @throws {Error} If the instance has been destroyed.
   *
   * @example
   * ```ts
   * const scopes = shield.getGrantedScopes('OpenClaw');
   * // [{ service: 'gmail', permissionLevel: 'read' }, ...]
   * ```
   */
  getGrantedScopes(agentId: string): readonly Scope[] {
    this.#assertNotDestroyed();
    return this.#grantedScopes.get(agentId) ?? [];
  }

  /**
   * Pre-check whether a proposed spend would be allowed for an agent.
   *
   * This is a read-only check. It does **not** record the spend.
   * Call this before executing a transaction to surface limit violations
   * early. If no spending limit was configured via {@link requestConsent},
   * all amounts are allowed.
   *
   * @param agentId - The agent proposing the spend.
   * @param amount - The proposed spend amount in dollars (e.g. `49.99`).
   * @returns Whether the spend is allowed and what budget remains.
   * @throws {Error} If the instance has been destroyed.
   *
   * @example
   * ```ts
   * const result = shield.checkSpending('OpenClaw', 50);
   * if (!result.allowed) {
   *   console.error(result.reason);
   * }
   * ```
   */
  checkSpending(agentId: string, amount: number): SpendCheckResult {
    this.#assertNotDestroyed();

    const checker = this.#spendingCheckers.get(agentId);
    if (checker === undefined) {
      return {
        allowed: true,
        remainingBudget: {
          transaction: Number.MAX_SAFE_INTEGER,
          daily: Number.MAX_SAFE_INTEGER,
          monthly: Number.MAX_SAFE_INTEGER,
        },
      };
    }

    return checker.checkSpend(dollarsToCents(amount));
  }

  /**
   * Clean up the SDK instance.
   *
   * Flushes any pending log entries, removes the consent screen from the
   * DOM if it is still open, and marks the instance as destroyed. All
   * subsequent method calls will throw after `destroy()` is called.
   *
   * Safe to call multiple times. Subsequent calls are no-ops.
   *
   * @example
   * ```ts
   * // In a SPA teardown hook:
   * shield.destroy();
   * ```
   */
  destroy(): void {
    if (this.#isDestroyed) return;
    this.#isDestroyed = true;

    // Flush pending logs and release the timer (if batch mode is active).
    this.#logger.shutdown().catch(() => {
      // Errors during shutdown are intentionally swallowed. We're cleaning up.
    });

    if (this.#consentContainer !== null) {
      this.#consentContainer.remove();
      this.#consentContainer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  #assertNotDestroyed(): void {
    if (this.#isDestroyed) {
      throw new Error(
        "[MulticornShield] This instance has been destroyed. Create a new MulticornShield instance.",
      );
    }
  }

  #setupSpendingChecker(agentId: string, spendLimitDollars: number): void {
    const limitCents = dollarsToCents(spendLimitDollars);
    this.#spendingCheckers.set(
      agentId,
      createSpendingChecker({
        limits: {
          perTransaction: limitCents,
          // Daily and monthly limits are derived from the per-transaction limit
          // as sensible defaults. Developers needing tighter controls can use
          // the spending module directly.
          perDay: limitCents * 10,
          perMonth: limitCents * 100,
        },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

function validateApiKey(apiKey: string): void {
  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    throw new Error(
      `[MulticornShield] Invalid API key format. Keys must start with "${API_KEY_PREFIX}". ` +
        "Find your API key in the Multicorn dashboard under Settings → API Keys.",
    );
  }
  if (apiKey.length < MIN_API_KEY_LENGTH) {
    throw new Error(
      `[MulticornShield] API key is too short (${String(apiKey.length)} characters). ` +
        `Minimum length is ${String(MIN_API_KEY_LENGTH)} characters. ` +
        "Find your API key in the Multicorn dashboard under Settings → API Keys.",
    );
  }
}
