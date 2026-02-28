/**
 * `<multicorn-consent>`: Lit web component for agent permission consent.
 *
 * This is the OAuth-style popup that users see when an agent requests access.
 * It displays requested scopes with human-readable labels, allows granular
 * permission control (read/write/execute per service), and emits custom events
 * when the user makes a decision.
 *
 * @module consent/multicorn-consent
 */

import { LitElement, type PropertyValues } from "lit";
import { html, type HTMLTemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Scope, PermissionLevel } from "../types/index.js";
import type {
  ConsentGrantedEventDetail,
  ConsentPartialEventDetail,
  ConsentDeniedEventDetail,
} from "./consent-events.js";
import {
  getScopeLabel,
  getScopeShortLabel,
  getServiceDisplayName,
  getServiceIcon,
} from "./scope-labels.js";
import { formatScope } from "../scopes/scope-parser.js";
import {
  isHighRiskScope,
  getScopeWarning,
  requiresExplicitOptIn,
} from "../scopes/scope-metadata.js";
import { consentStyles } from "./consent-styles.js";
import { createFocusTrap, type FocusTrap } from "./focus-trap.js";

/**
 * Custom element tag name for the consent component.
 */
export const CONSENT_ELEMENT_TAG = "multicorn-consent";

/**
 * Default agent icon color (Multicorn purple).
 */
const DEFAULT_AGENT_COLOR = "#8b5cf6";

/**
 * Pattern for validating hex color values.
 * Accepts 3, 4, 6, or 8 hex digit colors (e.g. #fff, #ff00ff, #ff00ff80).
 * Rejects anything else to prevent CSS injection via the style attribute.
 */
const HEX_COLOR_PATTERN = /^#[\da-fA-F]{3,8}$/;

/**
 * Sanitise a color value to prevent CSS injection.
 * Returns the color if it matches the hex pattern, otherwise falls back to the default.
 */
function sanitizeColor(color: string): string {
  return HEX_COLOR_PATTERN.test(color) ? color : DEFAULT_AGENT_COLOR;
}

/**
 * Group scopes by service for display.
 *
 * @param scopes - Array of scopes to group.
 * @returns Map of service name to array of permission levels requested for that service.
 */
function groupScopesByService(scopes: readonly Scope[]): Map<string, Set<PermissionLevel>> {
  const grouped = new Map<string, Set<PermissionLevel>>();
  for (const scope of scopes) {
    if (!grouped.has(scope.service)) {
      grouped.set(scope.service, new Set());
    }
    const serviceSet = grouped.get(scope.service);
    if (serviceSet) {
      serviceSet.add(scope.permissionLevel);
    }
  }
  return grouped;
}

/**
 * Create a unique key for a scope (used in Set tracking).
 *
 * @param scope - The scope to key.
 * @returns A string key like `"gmail:read"`.
 */
function scopeKey(scope: Scope): string {
  return `${scope.service}:${scope.permissionLevel}`;
}

/**
 * The `<multicorn-consent>` web component.
 *
 * @example
 * ```html
 * <multicorn-consent
 *   agent-name="My Agent"
 *   agent-color="#8b5cf6"
 *   scopes='[{"service":"gmail","permissionLevel":"read"}]'
 *   spend-limit="200"
 *   mode="modal"
 * ></multicorn-consent>
 * ```
 *
 * @example
 * ```ts
 * const element = document.querySelector('multicorn-consent');
 * element.addEventListener('consent-granted', (e) => {
 *   const detail = e.detail;
 *   console.log('Granted scopes:', detail.grantedScopes);
 * });
 * ```
 */
@customElement(CONSENT_ELEMENT_TAG)
export class MulticornConsent extends LitElement {
  static override styles = [consentStyles];

  /**
   * The name of the agent requesting access.
   *
   * @attr agent-name
   */
  @property({ type: String, attribute: "agent-name" })
  agentName = "";

  /**
   * The color to use for the agent icon (hex color).
   *
   * @attr agent-color
   */
  @property({ type: String, attribute: "agent-color" })
  agentColor = DEFAULT_AGENT_COLOR;

  /**
   * The requested scopes as a JSON string or array.
   *
   * Can be set as an attribute (JSON string) or property (array).
   *
   * @attr scopes
   */
  @property({ type: Array, attribute: "scopes" })
  scopes: Scope[] = [];

  /**
   * The spending limit per transaction (in dollars).
   *
   * @attr spend-limit
   */
  @property({ type: Number, attribute: "spend-limit" })
  spendLimit = 0;

  /**
   * Display mode: "modal" (with backdrop) or "inline" (embedded).
   *
   * @attr mode
   */
  @property({ type: String })
  mode: "modal" | "inline" = "modal";

  /**
   * Internal state: which scopes are currently granted.
   *
   * Uses scope keys (e.g., "gmail:read") for efficient lookups.
   */
  @state()
  private _grantedScopes = new Set<string>();

  /**
   * Internal state: the user-adjusted spending limit.
   * Initialised from `spendLimit` and can be lowered but not raised above it.
   */
  @state()
  private _adjustedSpendLimit = 0;

  /**
   * Internal state: whether the modal is open (for modal mode).
   */
  @state()
  private _isOpen = true;

  /**
   * Focus trap instance (only used in modal mode).
   */
  private _focusTrap: FocusTrap | null = null;

  /**
   * Previously focused element (for restoring focus after modal closes).
   */
  private readonly _previousActiveElement: HTMLElement | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Initialize granted scopes if scopes are already set
    if (Array.isArray(this.scopes) && this.scopes.length > 0) {
      this._initializeGrantedScopes();
    }
    // Set up keyboard handlers for modal mode
    this.addEventListener("keydown", this._handleKeyDown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this._handleKeyDown);
    this._cleanupFocusTrap();
  }

  override willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);
    // Parse scopes from attribute if needed
    if (changedProperties.has("scopes")) {
      if (!Array.isArray(this.scopes)) {
        const scopesAttr = this.getAttribute("scopes");
        if (scopesAttr) {
          try {
            const parsed = JSON.parse(scopesAttr) as Scope[];
            if (Array.isArray(parsed)) {
              this.scopes = parsed;
            }
          } catch {
            this.scopes = [];
          }
        } else {
          this.scopes = [];
        }
      }
      // Re-initialize granted scopes when scopes change (done in willUpdate to avoid extra render)
      this._initializeGrantedScopes();
    }
  }

  override updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);
    // Update focus trap when mode changes
    if (changedProperties.has("mode")) {
      this._updateFocusTrap();
    }
  }

  override firstUpdated(changedProperties: PropertyValues): void {
    super.firstUpdated(changedProperties);
    this._updateFocusTrap();
  }

  /**
   * Initialize the granted scopes set with all requested scopes.
   * High-risk scopes that require explicit opt-in are defaulted to OFF.
   */
  private _initializeGrantedScopes(): void {
    const scopes = Array.isArray(this.scopes) ? this.scopes : [];
    const granted = new Set<string>();

    for (const scope of scopes) {
      const scopeStr = formatScope(scope);
      // Only include non-high-risk scopes or high-risk scopes that don't require explicit opt-in
      if (!requiresExplicitOptIn(scopeStr)) {
        granted.add(scopeKey(scope));
      }
      // High-risk scopes that require explicit opt-in are excluded (default OFF)
    }

    this._grantedScopes = granted;
    this._adjustedSpendLimit = this.spendLimit;
  }

  /**
   * Handle keyboard events (Escape to deny).
   */
  private readonly _handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.mode === "modal" && this._isOpen) {
      e.preventDefault();
      this._emitDenied();
    }
  };

  /**
   * Update the focus trap based on current mode and open state.
   */
  private _updateFocusTrap(): void {
    this._cleanupFocusTrap();
    if (this.mode === "modal" && this._isOpen) {
      const firstFocusable = this.shadowRoot?.querySelector<HTMLElement>(
        'button, [href], input, [tabindex]:not([tabindex="-1"])',
      );
      this._focusTrap = createFocusTrap(this, firstFocusable ?? undefined);
      this._focusTrap.activate();
    }
  }

  /**
   * Clean up the focus trap.
   */
  private _cleanupFocusTrap(): void {
    if (this._focusTrap) {
      this._focusTrap.deactivate();
      this._focusTrap = null;
    }
  }

  /**
   * Toggle a specific scope's granted state.
   *
   * @param scope - The scope to toggle.
   */
  private _toggleScope(scope: Scope): void {
    const key = scopeKey(scope);
    if (this._grantedScopes.has(key)) {
      this._grantedScopes.delete(key);
    } else {
      this._grantedScopes.add(key);
    }
    // Trigger re-render
    this._grantedScopes = new Set(this._grantedScopes);
    this.requestUpdate();
  }

  /**
   * Check if a scope is currently granted.
   *
   * @param scope - The scope to check.
   * @returns True if the scope is granted.
   */
  private _isScopeGranted(scope: Scope): boolean {
    return this._grantedScopes.has(scopeKey(scope));
  }

  /**
   * Adjust the spending limit.
   * Clamps between 0 and the original requested spendLimit.
   */
  private _adjustSpendLimit(delta: number): void {
    this._adjustedSpendLimit = Math.max(
      0,
      Math.min(this.spendLimit, this._adjustedSpendLimit + delta),
    );
  }

  /**
   * Handle direct input of the spending limit.
   */
  private readonly _handleSpendLimitInput = (e: Event): void => {
    const input = e.target as HTMLInputElement;
    const value = parseInt(input.value, 10);
    this._adjustedSpendLimit = Number.isNaN(value)
      ? 0
      : Math.max(0, Math.min(this.spendLimit, value));
  };

  /**
   * Handle the "Authorize" button click.
   */
  private readonly _handleAuthorize = (): void => {
    const granted: Scope[] = [];
    const denied: Scope[] = [];
    const scopes = Array.isArray(this.scopes) ? this.scopes : [];

    for (const scope of scopes) {
      if (this._isScopeGranted(scope)) {
        granted.push(scope);
      } else {
        denied.push(scope);
      }
    }

    if (granted.length === 0) {
      // All denied, emit denied event
      this._emitDenied();
    } else if (denied.length === 0) {
      // All granted, emit granted event
      this._emitGranted(granted);
    } else {
      // Partial, emit partial event
      this._emitPartial(granted, denied);
    }

    // Close modal if in modal mode
    if (this.mode === "modal") {
      this._isOpen = false;
      this._cleanupFocusTrap();
    }
  };

  /**
   * Handle the "Deny" button click.
   */
  private readonly _handleDeny = (): void => {
    this._emitDenied();
    if (this.mode === "modal") {
      this._isOpen = false;
      this._cleanupFocusTrap();
    }
  };

  /**
   * Emit a consent-granted event.
   */
  private _emitGranted(grantedScopes: Scope[]): void {
    const detail: ConsentGrantedEventDetail = {
      grantedScopes,
      spendLimit: this._adjustedSpendLimit,
      timestamp: new Date().toISOString(),
    };
    this.dispatchEvent(
      new CustomEvent<ConsentGrantedEventDetail>("consent-granted", {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Emit a consent-partial event.
   */
  private _emitPartial(grantedScopes: Scope[], deniedScopes: Scope[]): void {
    const detail: ConsentPartialEventDetail = {
      grantedScopes,
      deniedScopes,
      spendLimit: this._adjustedSpendLimit,
      timestamp: new Date().toISOString(),
    };
    this.dispatchEvent(
      new CustomEvent<ConsentPartialEventDetail>("consent-partial", {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Emit a consent-denied event.
   */
  private _emitDenied(): void {
    const scopes = Array.isArray(this.scopes) ? this.scopes : [];
    const detail: ConsentDeniedEventDetail = {
      deniedScopes: [...scopes],
      timestamp: new Date().toISOString(),
    };
    this.dispatchEvent(
      new CustomEvent<ConsentDeniedEventDetail>("consent-denied", {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Get parsed scopes (already handled by property converter).
   */
  private _getParsedScopes(): Scope[] {
    return Array.isArray(this.scopes) ? this.scopes : [];
  }

  override render(): HTMLTemplateResult {
    const parsedScopes = this._getParsedScopes();

    // Don't render if closed in modal mode
    if (this.mode === "modal" && !this._isOpen) {
      return html`` as HTMLTemplateResult;
    }

    // Don't render if no scopes provided
    if (parsedScopes.length === 0) {
      return html`
        <div class="card">
          <div class="header">
            <h2 class="agent-name">${this.agentName || "Agent"}</h2>
            <p class="agent-subtitle" style="color: var(--shield-text-dim);">
              No permissions requested.
            </p>
          </div>
        </div>
      ` as HTMLTemplateResult;
    }

    const groupedScopes = groupScopesByService(parsedScopes);
    const isModal = this.mode === "modal" && this._isOpen;

    // Check for high-risk scopes and get warning message
    const highRiskScopes = parsedScopes.filter((scope) => isHighRiskScope(formatScope(scope)));
    const firstHighRiskScope = highRiskScopes[0];
    const warningMessage =
      firstHighRiskScope !== undefined
        ? getScopeWarning(formatScope(firstHighRiskScope))
        : undefined;

    const content: HTMLTemplateResult = html`
      <div
        class="card"
        role="dialog"
        aria-modal="${isModal ? "true" : "false"}"
        aria-labelledby="agent-name"
      >
        <!-- Header -->
        <div class="header">
          <div class="header-top">
            <div class="verified-badge">Verified Agent</div>
          </div>
          <div class="agent-info">
            <div
              class="agent-icon"
              style="background: linear-gradient(135deg, ${sanitizeColor(
                this.agentColor,
              )}, #6d28d9);"
            >
              🤖
            </div>
            <div>
              <h2 class="agent-name" id="agent-name">${this.agentName || "Agent"}</h2>
              <p class="agent-subtitle">wants access to your services</p>
            </div>
          </div>
        </div>

        <!-- High-Risk Warning -->
        ${warningMessage
          ? (html`
              <div class="high-risk-warning">
                <div class="warning-icon">⚠️</div>
                <div class="warning-text">${warningMessage}</div>
              </div>
            ` as HTMLTemplateResult)
          : (html`` as HTMLTemplateResult)}

        <!-- Permissions -->
        <div class="permissions">
          <div class="permissions-title">Permissions</div>
          ${Array.from(groupedScopes.entries()).map(
            ([service, permissionLevels]): HTMLTemplateResult => {
              const serviceDisplayName = getServiceDisplayName(service);
              const serviceIcon = getServiceIcon(service);
              const serviceScopes = parsedScopes.filter((s) => s.service === service);

              return html`
                <div class="permission-row">
                  <div class="permission-icon">${serviceIcon}</div>
                  <div class="permission-content">
                    <div class="permission-title">${serviceDisplayName}</div>
                    <div class="permission-description">
                      ${serviceScopes.map((scope) => getScopeLabel(scope)).join(", ")}
                    </div>
                    <div class="permission-levels">
                      ${Array.from(permissionLevels).map((level): HTMLTemplateResult => {
                        const scope: Scope = { service, permissionLevel: level };
                        const isGranted = this._isScopeGranted(scope);
                        const label = getScopeShortLabel(scope);

                        return html`
                          <button
                            class="permission-level-button ${isGranted ? "active" : ""}"
                            @click="${() => {
                              this._toggleScope(scope);
                            }}"
                            aria-label="Toggle ${label}"
                            type="button"
                          >
                            ${level.charAt(0).toUpperCase() + level.slice(1)}
                          </button>
                        ` as HTMLTemplateResult;
                      })}
                    </div>
                  </div>
                  <button
                    class="toggle ${this._areAllServiceScopesGranted(service, serviceScopes)
                      ? "enabled"
                      : ""}"
                    @click="${() => {
                      this._toggleAllServiceScopes(service, serviceScopes);
                    }}"
                    aria-label="Toggle all permissions for ${serviceDisplayName}"
                    type="button"
                  >
                    <div class="toggle-thumb"></div>
                  </button>
                </div>
              ` as HTMLTemplateResult;
            },
          )}
        </div>

        <!-- Spending Limit -->
        ${this.spendLimit > 0
          ? (html`
              <div class="spending-limit">
                <div class="spending-limit-header">
                  <div>
                    <div class="spending-limit-label">Spending limit</div>
                    <div class="spending-limit-description">Per transaction without approval</div>
                  </div>
                  <div class="spending-limit-control">
                    <button
                      class="spend-step-btn"
                      @click="${() => {
                        this._adjustSpendLimit(-10);
                      }}"
                      aria-label="Decrease spending limit"
                      type="button"
                      ?disabled="${this._adjustedSpendLimit <= 0}"
                    >
                      −
                    </button>
                    <div class="spend-input-wrap">
                      <span class="spend-currency">$</span>
                      <input
                        class="spend-input"
                        type="number"
                        min="0"
                        max="${this.spendLimit}"
                        .value="${String(this._adjustedSpendLimit)}"
                        @change="${this._handleSpendLimitInput}"
                        aria-label="Spending limit amount"
                      />
                    </div>
                    <button
                      class="spend-step-btn"
                      @click="${() => {
                        this._adjustSpendLimit(10);
                      }}"
                      aria-label="Increase spending limit"
                      type="button"
                      ?disabled="${this._adjustedSpendLimit >= this.spendLimit}"
                    >
                      +
                    </button>
                  </div>
                </div>
                ${this._adjustedSpendLimit < this.spendLimit
                  ? (html`<div class="spending-limit-hint">
                      Agent requested $${this.spendLimit}
                    </div>` as HTMLTemplateResult)
                  : (html`` as HTMLTemplateResult)}
              </div>
            ` as HTMLTemplateResult)
          : (html`` as HTMLTemplateResult)}

        <!-- Actions -->
        <div class="actions">
          <button class="button button-secondary" @click="${this._handleDeny}" type="button">
            Deny
          </button>
          <button class="button button-primary" @click="${this._handleAuthorize}" type="button">
            Authorize Agent
          </button>
        </div>
      </div>
    `;

    if (isModal) {
      return html` <div class="backdrop">${content}</div> ` as HTMLTemplateResult;
    }

    return content;
  }

  /**
   * Check if all scopes for a service are granted.
   */
  private _areAllServiceScopesGranted(service: string, serviceScopes: Scope[]): boolean {
    return serviceScopes.every((scope) => this._isScopeGranted(scope));
  }

  /**
   * Toggle all scopes for a service.
   */
  private _toggleAllServiceScopes(service: string, serviceScopes: Scope[]): void {
    const allGranted = this._areAllServiceScopesGranted(service, serviceScopes);
    for (const scope of serviceScopes) {
      const key = scopeKey(scope);
      if (allGranted) {
        this._grantedScopes.delete(key);
      } else {
        this._grantedScopes.add(key);
      }
    }
    this._grantedScopes = new Set(this._grantedScopes);
    this.requestUpdate();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [CONSENT_ELEMENT_TAG]: MulticornConsent;
  }
}
