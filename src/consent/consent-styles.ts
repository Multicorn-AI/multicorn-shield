/**
 * Shield design system styles for the consent screen component.
 *
 * Uses Lit's `css` tagged template literal to define styles that are
 * isolated within the Shadow DOM.
 *
 * @module consent/consent-styles
 */

import { css, unsafeCSS, type CSSResult } from "lit";

/**
 * Shield design system color tokens.
 */
export const SHIELD_COLORS = {
  bg: "#0d0d14",
  surface: "#14141f",
  surfaceHover: "#1a1a2e",
  border: "#2a2a3d",
  borderLight: "#3a3a52",
  text: "#e8e8f0",
  textMuted: "#8888a0",
  textDim: "#5a5a72",
  accent: "#8b5cf6",
  accentLight: "#a78bfa",
  accentDim: "rgba(139, 92, 246, 0.12)",
  accentGlow: "rgba(139, 92, 246, 0.25)",
  green: "#22c55e",
  greenDim: "rgba(34, 197, 94, 0.12)",
  amber: "#f59e0b",
  amberDim: "rgba(245, 158, 11, 0.12)",
  red: "#ef4444",
  redDim: "rgba(239, 68, 68, 0.12)",
} as const;

/**
 * Main stylesheet for the consent component.
 *
 * Includes:
 * - Shield design system colors and typography
 * - Responsive layout (supports 375px viewport)
 * - Accessibility (focus visible, reduced motion)
 * - Modal backdrop and card styling
 */
export const consentStyles: CSSResult = css`
  :host {
    display: block;
    font-family:
      "DM Sans",
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      Roboto,
      sans-serif;
    color: ${unsafeCSS(SHIELD_COLORS.text)};
    --shield-bg: ${unsafeCSS(SHIELD_COLORS.bg)};
    --shield-surface: ${unsafeCSS(SHIELD_COLORS.surface)};
    --shield-surface-hover: ${unsafeCSS(SHIELD_COLORS.surfaceHover)};
    --shield-border: ${unsafeCSS(SHIELD_COLORS.border)};
    --shield-border-light: ${unsafeCSS(SHIELD_COLORS.borderLight)};
    --shield-text: ${unsafeCSS(SHIELD_COLORS.text)};
    --shield-text-muted: ${unsafeCSS(SHIELD_COLORS.textMuted)};
    --shield-text-dim: ${unsafeCSS(SHIELD_COLORS.textDim)};
    --shield-accent: ${unsafeCSS(SHIELD_COLORS.accent)};
    --shield-accent-light: ${unsafeCSS(SHIELD_COLORS.accentLight)};
    --shield-accent-dim: ${unsafeCSS(SHIELD_COLORS.accentDim)};
    --shield-accent-glow: ${unsafeCSS(SHIELD_COLORS.accentGlow)};
    --shield-green: ${unsafeCSS(SHIELD_COLORS.green)};
    --shield-green-dim: ${unsafeCSS(SHIELD_COLORS.greenDim)};
    --shield-amber: ${unsafeCSS(SHIELD_COLORS.amber)};
    --shield-amber-dim: ${unsafeCSS(SHIELD_COLORS.amberDim)};
    --shield-red: ${unsafeCSS(SHIELD_COLORS.red)};
    --shield-red-dim: ${unsafeCSS(SHIELD_COLORS.redDim)};
  }

  /* Modal backdrop */
  .backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    padding: 16px;
  }

  /* Main card container */
  .card {
    width: 100%;
    max-width: 420px;
    background: var(--shield-surface);
    border-radius: 20px;
    border: 1px solid var(--shield-border);
    overflow: hidden;
    box-shadow:
      0 0 80px var(--shield-accent-glow),
      0 20px 60px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
  }

  /* Inline mode: no backdrop, fill parent width */
  :host([mode="inline"]) .backdrop {
    position: static;
    background: transparent;
    padding: 0;
  }

  :host([mode="inline"]) .card {
    max-width: 100%;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  }

  /* Header section */
  .header {
    padding: 24px 24px 20px;
    border-bottom: 1px solid var(--shield-border);
    background: linear-gradient(180deg, rgba(139, 92, 246, 0.06) 0%, transparent 100%);
  }

  .header-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 20px;
  }

  .verified-badge {
    padding: 3px 10px;
    border-radius: 20px;
    background: var(--shield-green-dim);
    font-size: 11px;
    color: var(--shield-green);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .agent-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .agent-icon {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: linear-gradient(135deg, var(--shield-accent), #6d28d9);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    flex-shrink: 0;
  }

  .agent-name {
    font-weight: 600;
    font-size: 16px;
    color: var(--shield-text);
    margin: 0;
  }

  .agent-subtitle {
    font-size: 12px;
    color: var(--shield-text-muted);
    margin: 2px 0 0 0;
  }

  /* High-risk warning callout */
  .high-risk-warning {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 24px;
    margin: 0;
    background: var(--shield-amber-dim);
    border-top: 1px solid var(--shield-border);
    border-bottom: 1px solid var(--shield-border);
  }

  .warning-icon {
    font-size: 18px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .warning-text {
    font-size: 12.5px;
    color: var(--shield-text);
    line-height: 1.5;
    margin: 0;
  }

  /* Permissions section */
  .permissions {
    padding: 8px 24px 0;
  }

  .permissions-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--shield-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 12px 0 4px 0;
  }

  .permission-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 0;
    border-bottom: 1px solid var(--shield-border);
  }

  .permission-row:last-child {
    border-bottom: none;
  }

  .permission-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: var(--shield-accent-dim);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    flex-shrink: 0;
  }

  .permission-content {
    flex: 1;
    min-width: 0;
  }

  .permission-title {
    font-weight: 500;
    font-size: 13.5px;
    color: var(--shield-text);
    margin: 0;
  }

  .permission-description {
    font-size: 11.5px;
    color: var(--shield-text-muted);
    margin: 2px 0 0 0;
  }

  .permission-levels {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    flex-wrap: wrap;
  }

  .permission-level-button {
    padding: 3px 10px;
    border-radius: 6px;
    border: 1px solid var(--shield-border);
    background: transparent;
    color: var(--shield-text-dim);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .permission-level-button:focus-visible {
    outline: 2px solid var(--shield-accent);
    outline-offset: 2px;
  }

  .permission-level-button.active {
    border-color: var(--shield-accent);
    background: var(--shield-accent-dim);
    color: var(--shield-accent-light);
  }

  /* Toggle switch */
  .toggle {
    width: 40px;
    height: 22px;
    border-radius: 11px;
    border: none;
    background: var(--shield-border);
    cursor: pointer;
    position: relative;
    transition: background 0.2s;
    flex-shrink: 0;
    padding: 0;
  }

  .toggle:focus-visible {
    outline: 2px solid var(--shield-accent);
    outline-offset: 2px;
  }

  .toggle.enabled {
    background: var(--shield-accent);
  }

  .toggle-thumb {
    width: 16px;
    height: 16px;
    border-radius: 8px;
    background: #fff;
    position: absolute;
    top: 3px;
    left: 3px;
    transition: left 0.2s;
  }

  .toggle.enabled .toggle-thumb {
    left: 21px;
  }

  /* Spending limit section */
  .spending-limit {
    padding: 16px 24px;
    border-top: 1px solid var(--shield-border);
  }

  .spending-limit-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .spending-limit-label {
    font-weight: 500;
    font-size: 13px;
    color: var(--shield-text);
    margin: 0;
  }

  .spending-limit-description {
    font-size: 11.5px;
    color: var(--shield-text-muted);
    margin: 2px 0 0 0;
  }

  .spending-limit-amount {
    font-family: "DM Mono", "Courier New", monospace;
    font-size: 18px;
    font-weight: 600;
    color: var(--shield-accent);
  }

  /* Editable spending limit control */
  .spending-limit-control {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .spend-step-btn {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    border: 1px solid var(--shield-border);
    background: transparent;
    color: var(--shield-text-muted);
    font-size: 16px;
    font-family: inherit;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
    padding: 0;
    line-height: 1;
  }

  .spend-step-btn:hover:not(:disabled) {
    background: var(--shield-surface-hover);
    color: var(--shield-text);
    border-color: var(--shield-accent);
  }

  .spend-step-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .spend-step-btn:focus-visible {
    outline: 2px solid var(--shield-accent);
    outline-offset: 2px;
  }

  .spend-input-wrap {
    display: flex;
    align-items: center;
    gap: 1px;
    background: var(--shield-accent-dim);
    border: 1px solid var(--shield-accent);
    border-radius: 8px;
    padding: 4px 10px;
  }

  .spend-currency {
    font-family: "DM Mono", "Courier New", monospace;
    font-size: 16px;
    font-weight: 600;
    color: var(--shield-accent);
  }

  .spend-input {
    font-family: "DM Mono", "Courier New", monospace;
    font-size: 16px;
    font-weight: 600;
    color: var(--shield-accent-light);
    background: transparent;
    border: none;
    outline: none;
    width: 60px;
    text-align: left;
    padding: 0;
    -moz-appearance: textfield;
  }

  .spend-input::-webkit-outer-spin-button,
  .spend-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .spending-limit-hint {
    font-size: 11px;
    color: var(--shield-text-dim);
    margin-top: 8px;
    text-align: right;
  }

  /* Actions section */
  .actions {
    padding: 12px 24px 24px;
    display: flex;
    gap: 10px;
  }

  .button {
    padding: 12px 0;
    border-radius: 12px;
    font-family: inherit;
    font-weight: 500;
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s;
    border: none;
  }

  .button:focus-visible {
    outline: 2px solid var(--shield-accent);
    outline-offset: 2px;
  }

  .button-secondary {
    flex: 1;
    background: transparent;
    border: 1px solid var(--shield-border);
    color: var(--shield-text-muted);
  }

  .button-secondary:hover {
    background: var(--shield-surface-hover);
    color: var(--shield-text);
  }

  .button-primary {
    flex: 2;
    background: linear-gradient(135deg, var(--shield-accent), #6d28d9);
    color: #fff;
    font-weight: 600;
    box-shadow: 0 4px 20px var(--shield-accent-glow);
  }

  .button-primary:hover {
    box-shadow: 0 6px 24px var(--shield-accent-glow);
    transform: translateY(-1px);
  }

  .button-primary:active {
    transform: translateY(0);
  }

  /* Reduced motion support */
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* Responsive: small viewports (≤480px) */
  @media (max-width: 480px) {
    .card {
      max-width: 100%;
      border-radius: 16px;
    }

    .header {
      padding: 20px 16px 16px;
    }

    .permissions {
      padding: 8px 16px 0;
    }

    .permission-row {
      gap: 10px;
      padding: 12px 0;
    }

    .permission-icon {
      width: 32px;
      height: 32px;
      font-size: 14px;
    }

    .spending-limit {
      padding: 12px 16px;
    }

    .actions {
      padding: 12px 16px 20px;
    }
  }

  /* Responsive: very small viewports (≤375px) */
  @media (max-width: 375px) {
    .header {
      padding: 16px 12px 12px;
    }

    .agent-icon {
      width: 36px;
      height: 36px;
      font-size: 16px;
    }

    .agent-name {
      font-size: 14px;
    }

    .permissions {
      padding: 4px 12px 0;
    }

    .permission-row {
      gap: 8px;
      padding: 10px 0;
    }

    .permission-description {
      font-size: 10.5px;
    }

    .spending-limit {
      padding: 10px 12px;
    }

    .spending-limit-amount {
      font-size: 16px;
    }

    .actions {
      padding: 10px 12px 16px;
      flex-direction: column;
      gap: 8px;
    }

    .button {
      padding: 10px 0;
      font-size: 13px;
    }

    .button-primary,
    .button-secondary {
      flex: 1;
    }
  }

  /* Hidden class for conditional rendering */
  .hidden {
    display: none !important;
  }
`;
