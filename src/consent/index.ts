/**
 * Consent screen web component for agent permission authorisation.
 *
 * Uses Shadow DOM to prevent CSS injection from host pages.
 *
 * @module consent
 */

// Re-export public API
export { MulticornConsent, CONSENT_ELEMENT_TAG } from "./multicorn-consent.js";
export type {
  ConsentEventDetail,
  ConsentGrantedEventDetail,
  ConsentPartialEventDetail,
  ConsentDeniedEventDetail,
  ConsentEventMap,
  ConsentEventName,
} from "./consent-events.js";
export {
  getScopeLabel,
  getScopeShortLabel,
  getServiceDisplayName,
  getServiceIcon,
  getPermissionLabel,
} from "./scope-labels.js";
export { createFocusTrap, type FocusTrap } from "./focus-trap.js";
