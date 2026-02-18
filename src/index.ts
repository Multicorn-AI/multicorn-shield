/**
 * Multicorn Shield SDK
 *
 * The control layer for AI agents — permissions, consent, spending limits,
 * and audit logging.
 *
 * @packageDocumentation
 */

export * from "./types/index.js";

// Module re-exports — enabled as each module gains public API surface.
export * from "./scopes/index.js";
export * from "./consent/index.js";
export * from "./logger/index.js";
export * from "./spending/index.js";
export * from "./mcp/index.js";

// Main SDK entry point
export {
  MulticornShield,
  type MulticornShieldConfig,
  type ConsentOptions,
  type ActionInput,
  type SpendCheckResult,
} from "./multicorn-shield.js";
