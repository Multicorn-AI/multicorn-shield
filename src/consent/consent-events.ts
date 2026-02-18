/**
 * Custom event types emitted by the `<multicorn-consent>` web component.
 *
 * These events follow the standard CustomEvent interface and can be listened to
 * via `addEventListener` on the component element.
 *
 * @module consent/consent-events
 */

import type { Scope } from "../types/index.js";

/**
 * Base interface for all consent events.
 */
export interface ConsentEventDetail {
  /** Timestamp when the event was emitted (ISO 8601 string). */
  readonly timestamp: string;
}

/**
 * Event detail for when the user grants all requested scopes.
 *
 * @example
 * ```ts
 * element.addEventListener('consent-granted', (e) => {
 *   const detail = (e as CustomEvent<ConsentGrantedEventDetail>).detail;
 *   console.log('Granted scopes:', detail.grantedScopes);
 * });
 * ```
 */
export interface ConsentGrantedEventDetail extends ConsentEventDetail {
  /** All scopes that were requested and granted. */
  readonly grantedScopes: readonly Scope[];
  /** The spending limit approved by the user (may be lower than requested). */
  readonly spendLimit: number;
}

/**
 * Event detail for when the user grants some but not all requested scopes.
 *
 * @example
 * ```ts
 * element.addEventListener('consent-partial', (e) => {
 *   const detail = (e as CustomEvent<ConsentPartialEventDetail>).detail;
 *   console.log('Granted:', detail.grantedScopes);
 *   console.log('Denied:', detail.deniedScopes);
 * });
 * ```
 */
export interface ConsentPartialEventDetail extends ConsentEventDetail {
  /** Scopes that were granted by the user. */
  readonly grantedScopes: readonly Scope[];
  /** Scopes that were requested but denied by the user. */
  readonly deniedScopes: readonly Scope[];
  /** The spending limit approved by the user (may be lower than requested). */
  readonly spendLimit: number;
}

/**
 * Event detail for when the user denies the consent request entirely.
 *
 * @example
 * ```ts
 * element.addEventListener('consent-denied', (e) => {
 *   const detail = (e as CustomEvent<ConsentDeniedEventDetail>).detail;
 *   console.log('User denied at:', detail.timestamp);
 * });
 * ```
 */
export interface ConsentDeniedEventDetail extends ConsentEventDetail {
  /** All scopes that were requested but denied. */
  readonly deniedScopes: readonly Scope[];
}

/**
 * Type map for consent event names to their detail types.
 *
 * Useful for TypeScript consumers to get proper type inference when
 * listening to events.
 *
 * @example
 * ```ts
 * type ConsentEventMap = {
 *   'consent-granted': ConsentGrantedEventDetail;
 *   'consent-partial': ConsentPartialEventDetail;
 *   'consent-denied': ConsentDeniedEventDetail;
 * };
 * ```
 */
export interface ConsentEventMap {
  "consent-granted": ConsentGrantedEventDetail;
  "consent-partial": ConsentPartialEventDetail;
  "consent-denied": ConsentDeniedEventDetail;
}

/**
 * Union of all consent event names.
 */
export type ConsentEventName = keyof ConsentEventMap;
