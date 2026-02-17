/**
 * Client-side spend checks for agent transactions.
 *
 * Enforces spending limits before actions are executed,
 * preventing agents from exceeding configured thresholds.
 *
 * @module spending
 */

export {
  createSpendingChecker,
  dollarsToCents,
  centsToDollars,
  type SpendingChecker,
  type SpendingLimits,
  type SpendingTrackerConfig,
  type SpendingCheckResult,
  type RemainingBudget,
} from "./spending-checker.js";
