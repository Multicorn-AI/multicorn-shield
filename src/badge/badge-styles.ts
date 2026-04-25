/**
 * Styles for the trust badge (injected as a `<style>` block in Shadow DOM).
 * Uses the same `SHIELD_COLORS` tokens as the consent screen.
 *
 * @module badge/badge-styles
 */

import { SHIELD_COLORS } from "../shared/shield-tokens.js";

const LIGHT_TEXT = "#0f172a";
const LIGHT_SURFACE = "#f8fafc";
const LIGHT_SURFACE_HOVER = "#f1f5f9";
const LIGHT_BORDER = "#e2e8f0";

/**
 * Isolated CSS string for `<multicorn-badge>`.
 * The CDN bundle is size-capped, so this stays a plain string (not Lit's `css` helper)
 * to avoid shipping the `lit` runtime in `badge.js`.
 */
export function getBadgeStyleText(): string {
  return `
:host { display: inline-block; line-height: 0; }
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  gap: 6px;
  min-height: 28px;
  padding: 4px 10px 4px 8px;
  border-radius: 9999px;
  text-decoration: none;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid ${SHIELD_COLORS.border};
  background: ${SHIELD_COLORS.surface};
  color: ${SHIELD_COLORS.text};
  transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}
:host([theme="light"]) .badge {
  border-color: ${LIGHT_BORDER};
  background: ${LIGHT_SURFACE};
  color: ${LIGHT_TEXT};
}
.badge:hover {
  background: ${SHIELD_COLORS.surfaceHover};
  border-color: ${SHIELD_COLORS.accent};
  box-shadow: 0 0 0 1px ${SHIELD_COLORS.accentDim};
}
:host([theme="light"]) .badge:hover {
  background: ${LIGHT_SURFACE_HOVER};
  border-color: ${SHIELD_COLORS.accent};
}
.badge:focus-visible {
  outline: 2px solid ${SHIELD_COLORS.accent};
  outline-offset: 2px;
}
.icon { flex-shrink: 0; display: block; }
.text { white-space: nowrap; }
:host([size="compact"]) .text { display: none; }
:host([size="compact"]) .badge { padding: 4px 6px; }
@media (prefers-reduced-motion: reduce) { .badge { transition: none; } }
  `.trim();
}
