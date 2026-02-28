/**
 * Client-side spending control for Multicorn Shield.
 *
 * Pre-checks proposed actions against configured spending limits before they
 * execute. The server validates too, but client-side checks provide instant
 * feedback and reduce unnecessary API calls.
 *
 * **Design principles:**
 * - **Security (Jordan persona)**: Currency-safe arithmetic using integer cents
 *   prevents floating point bypass tricks (e.g. $0.01 + $0.02 !== $0.03).
 * - **Clear errors (Yuki persona)**: Descriptive messages with exact amounts,
 *   not just "limit exceeded".
 * - **Transparency (Sarah persona)**: Remaining budget always visible so users
 *   understand what happened.
 *
 * **Important**: This is a client-side pre-check only. The server is the source
 * of truth and performs final validation. In-memory tracking resets on page reload.
 *
 * @module spending/spending-checker
 */

// Configuration types

/**
 * Spending limits for an agent in integer cents.
 *
 * All amounts are stored as integer cents to avoid floating point precision
 * issues. For example, $200.00 is stored as 20000 cents.
 *
 * @example
 * ```ts
 * const limits: SpendingLimits = {
 *   perTransaction: 20000,  // $200.00
 *   perDay: 100000,         // $1,000.00
 *   perMonth: 500000,       // $5,000.00
 * };
 * ```
 */
export interface SpendingLimits {
  /**
   * Maximum amount (in cents) allowed for a single transaction.
   * Must be a positive integer.
   */
  readonly perTransaction: number;

  /**
   * Maximum cumulative amount (in cents) allowed per calendar day.
   * Resets at midnight local time.
   * Must be a positive integer.
   */
  readonly perDay: number;

  /**
   * Maximum cumulative amount (in cents) allowed per calendar month.
   * Resets on the first day of each month at midnight local time.
   * Must be a positive integer.
   */
  readonly perMonth: number;
}

/**
 * Configuration options for the spending checker.
 *
 * @example
 * ```ts
 * const config: SpendingTrackerConfig = {
 *   limits: {
 *     perTransaction: 20000,  // $200.00
 *     perDay: 100000,         // $1,000.00
 *     perMonth: 500000,       // $5,000.00
 *   },
 * };
 * ```
 */
export interface SpendingTrackerConfig {
  /**
   * The spending limits to enforce.
   * All values must be positive integers representing cents.
   */
  readonly limits: SpendingLimits;
}

// Result types

/**
 * Remaining budget across all three limit types.
 *
 * All amounts are in integer cents. Calculated as:
 * - `transaction`: Always the per-transaction limit (doesn't accumulate)
 * - `daily`: `perDay - dailySpend`
 * - `monthly`: `perMonth - monthlySpend`
 *
 * @example
 * ```ts
 * const remaining: RemainingBudget = {
 *   transaction: 20000,  // $200.00 per-transaction limit
 *   daily: 75000,        // $750.00 remaining today
 *   monthly: 425000,     // $4,250.00 remaining this month
 * };
 * ```
 */
export interface RemainingBudget {
  /** Remaining per-transaction budget in cents. */
  readonly transaction: number;

  /** Remaining daily budget in cents. */
  readonly daily: number;

  /** Remaining monthly budget in cents. */
  readonly monthly: number;
}

/**
 * The result of a spending check.
 *
 * - When `allowed` is `true`, the action can proceed (no `reason` present).
 * - When `allowed` is `false`, `reason` contains a descriptive explanation
 *   with exact dollar amounts.
 *
 * The `remainingBudget` is always present to provide transparency.
 *
 * @example Successful check
 * ```ts
 * const result = checker.checkSpend(5000); // $50.00
 * // {
 * //   allowed: true,
 * //   remainingBudget: {
 * //     transaction: 20000,
 * //     daily: 95000,
 * //     monthly: 495000,
 * //   }
 * // }
 * ```
 *
 * @example Blocked check
 * ```ts
 * const result = checker.checkSpend(84900); // $849.00
 * // {
 * //   allowed: false,
 * //   reason: "Action blocked: $849.00 exceeds per-transaction limit of $200.00",
 * //   remainingBudget: {
 * //     transaction: 20000,
 * //     daily: 100000,
 * //     monthly: 500000,
 * //   }
 * // }
 * ```
 */
export interface SpendingCheckResult {
  /**
   * Whether the proposed spend is allowed under the configured limits.
   */
  readonly allowed: boolean;

  /**
   * Human-readable explanation of why the spend was blocked.
   * Only present when `allowed` is `false`.
   *
   * Format: "Action blocked: $X.XX exceeds [limit type] of $Y.YY"
   */
  readonly reason?: string;

  /**
   * Remaining budget across all three limit types.
   * Always present for transparency.
   */
  readonly remainingBudget: RemainingBudget;
}

// Spending Checker Client

/**
 * Client-side spending checker for pre-validating agent transactions.
 *
 * Tracks cumulative spend in memory and enforces per-transaction, per-day,
 * and per-month limits. Provides instant feedback before API calls.
 *
 * **Important**: This is a client-side cache that resets on page reload.
 * The server is the source of truth and performs final validation.
 *
 * @example Basic usage
 * ```ts
 * const checker = createSpendingChecker({
 *   limits: {
 *     perTransaction: 20000,  // $200.00
 *     perDay: 100000,         // $1,000.00
 *     perMonth: 500000,       // $5,000.00
 *   },
 * });
 *
 * // Pre-check before executing action
 * const result = checker.checkSpend(5000); // $50.00
 * if (!result.allowed) {
 *   console.error(`Blocked: ${result.reason}`);
 *   return;
 * }
 *
 * // Execute the action...
 * await executeAction();
 *
 * // Record successful spend for tracking
 * checker.recordSpend(5000);
 * ```
 *
 * @example Checking remaining budget
 * ```ts
 * const current = checker.getCurrentSpend();
 * console.log(`Spent today: $${(current.daily / 100).toFixed(2)}`);
 * console.log(`Spent this month: $${(current.monthly / 100).toFixed(2)}`);
 * ```
 */
export interface SpendingChecker {
  /**
   * Check whether a proposed spend would be allowed under the configured limits.
   *
   * This is a read-only pre-check that does NOT record the spend.
   * Call {@link recordSpend} after a successful transaction to update tracking.
   *
   * Checks are performed in order:
   * 1. Per-transaction limit
   * 2. Per-day cumulative limit
   * 3. Per-month cumulative limit
   *
   * The check fails at the **first** violated limit with a specific error message.
   *
   * @param amountCents - The proposed spend amount in integer cents.
   * @returns A {@link SpendingCheckResult} indicating whether the spend is allowed.
   * @throws {Error} If the amount is negative or not an integer.
   *
   * @example
   * ```ts
   * const result = checker.checkSpend(5000); // $50.00
   * if (result.allowed) {
   *   console.log(`OK. Remaining today: $${(result.remainingBudget.daily / 100).toFixed(2)}`);
   * } else {
   *   console.error(result.reason);
   * }
   * ```
   */
  checkSpend(amountCents: number): SpendingCheckResult;

  /**
   * Record a successful spend for cumulative tracking.
   *
   * Call this **after** an action has been successfully executed and charged.
   * This updates the daily and monthly cumulative spend totals.
   *
   * @param amountCents - The actual spend amount in integer cents.
   * @throws {Error} If the amount is negative or not an integer.
   *
   * @example
   * ```ts
   * const result = checker.checkSpend(5000);
   * if (result.allowed) {
   *   await executeAction();
   *   checker.recordSpend(5000); // Track the successful spend
   * }
   * ```
   */
  recordSpend(amountCents: number): void;

  /**
   * Get the current cumulative spend totals.
   *
   * Useful for displaying budget usage to users or debugging.
   *
   * @returns Current daily and monthly spend in integer cents.
   *
   * @example
   * ```ts
   * const current = checker.getCurrentSpend();
   * console.log(`Today: $${(current.daily / 100).toFixed(2)}`);
   * console.log(`This month: $${(current.monthly / 100).toFixed(2)}`);
   * ```
   */
  getCurrentSpend(): { daily: number; monthly: number };

  /**
   * Reset all cumulative spend tracking.
   *
   * Clears daily and monthly totals. Primarily useful for testing.
   * In production, resets happen automatically at day/month boundaries.
   */
  reset(): void;
}

// Factory function

/**
 * Create a new spending checker client.
 *
 * The checker tracks cumulative spend in memory and automatically resets
 * at day and month boundaries (local time).
 *
 * @param config - Configuration options including spending limits.
 * @returns A {@link SpendingChecker} instance.
 * @throws {Error} If any limit is negative or not an integer.
 *
 * @example
 * ```ts
 * const checker = createSpendingChecker({
 *   limits: {
 *     perTransaction: 20000,  // $200.00
 *     perDay: 100000,         // $1,000.00
 *     perMonth: 500000,       // $5,000.00
 *   },
 * });
 * ```
 */
export function createSpendingChecker(config: SpendingTrackerConfig): SpendingChecker {
  // Validate configuration
  validateLimits(config.limits);

  // Internal state: all amounts in integer cents
  let dailySpendCents = 0;
  let monthlySpendCents = 0;
  let lastDailyReset = new Date();
  let lastMonthlyReset = new Date();

  // Internal helpers

  /**
   * Validate that an amount is a non-negative integer.
   */
  function validateAmount(amountCents: number, context: string): void {
    if (!Number.isInteger(amountCents)) {
      throw new Error(
        `[SpendingChecker] ${context} must be an integer (cents). ` +
          `Received: ${String(amountCents)}. ` +
          "Convert dollars to cents by multiplying by 100.",
      );
    }
    if (amountCents < 0) {
      throw new Error(
        `[SpendingChecker] ${context} must be non-negative. ` +
          `Received: ${String(amountCents)} cents.`,
      );
    }
  }

  /**
   * Format cents as a dollar string with two decimal places and thousand separators.
   */
  function formatCents(cents: number): string {
    const dollars = cents / 100;
    return `$${dollars.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  /**
   * Check if the day boundary has been crossed and reset if needed.
   */
  function checkAndResetDaily(): void {
    const now = new Date();
    if (shouldResetDaily(lastDailyReset, now)) {
      dailySpendCents = 0;
      lastDailyReset = now;
    }
  }

  /**
   * Check if the month boundary has been crossed and reset if needed.
   */
  function checkAndResetMonthly(): void {
    const now = new Date();
    if (shouldResetMonthly(lastMonthlyReset, now)) {
      monthlySpendCents = 0;
      lastMonthlyReset = now;
    }
  }

  /**
   * Determine if daily spend should reset.
   */
  function shouldResetDaily(lastReset: Date, now: Date): boolean {
    return (
      lastReset.getDate() !== now.getDate() ||
      lastReset.getMonth() !== now.getMonth() ||
      lastReset.getFullYear() !== now.getFullYear()
    );
  }

  /**
   * Determine if monthly spend should reset.
   */
  function shouldResetMonthly(lastReset: Date, now: Date): boolean {
    return lastReset.getMonth() !== now.getMonth() || lastReset.getFullYear() !== now.getFullYear();
  }

  /**
   * Calculate remaining budget across all limit types.
   */
  function calculateRemainingBudget(): RemainingBudget {
    return {
      transaction: config.limits.perTransaction,
      daily: Math.max(0, config.limits.perDay - dailySpendCents),
      monthly: Math.max(0, config.limits.perMonth - monthlySpendCents),
    };
  }

  // Public API

  return {
    checkSpend(amountCents: number): SpendingCheckResult {
      validateAmount(amountCents, "Spend amount");

      // Auto-reset at day/month boundaries
      checkAndResetDaily();
      checkAndResetMonthly();

      // Check 1: Per-transaction limit
      if (amountCents > config.limits.perTransaction) {
        return {
          allowed: false,
          reason: `Action blocked: ${formatCents(amountCents)} exceeds per-transaction limit of ${formatCents(config.limits.perTransaction)}`,
          remainingBudget: calculateRemainingBudget(),
        };
      }

      // Check 2: Per-day cumulative limit
      const projectedDaily = dailySpendCents + amountCents;
      if (projectedDaily > config.limits.perDay) {
        return {
          allowed: false,
          reason:
            `Action blocked: ${formatCents(amountCents)} would exceed per-day limit. ` +
            `Current spend today: ${formatCents(dailySpendCents)}, ` +
            `limit: ${formatCents(config.limits.perDay)}`,
          remainingBudget: calculateRemainingBudget(),
        };
      }

      // Check 3: Per-month cumulative limit
      const projectedMonthly = monthlySpendCents + amountCents;
      if (projectedMonthly > config.limits.perMonth) {
        return {
          allowed: false,
          reason:
            `Action blocked: ${formatCents(amountCents)} would exceed per-month limit. ` +
            `Current spend this month: ${formatCents(monthlySpendCents)}, ` +
            `limit: ${formatCents(config.limits.perMonth)}`,
          remainingBudget: calculateRemainingBudget(),
        };
      }

      // All checks passed
      return {
        allowed: true,
        remainingBudget: calculateRemainingBudget(),
      };
    },

    recordSpend(amountCents: number): void {
      validateAmount(amountCents, "Spend amount");

      // Auto-reset at day/month boundaries
      checkAndResetDaily();
      checkAndResetMonthly();

      // Update cumulative totals
      dailySpendCents += amountCents;
      monthlySpendCents += amountCents;
    },

    getCurrentSpend(): { daily: number; monthly: number } {
      // Auto-reset before returning current state
      checkAndResetDaily();
      checkAndResetMonthly();

      return {
        daily: dailySpendCents,
        monthly: monthlySpendCents,
      };
    },

    reset(): void {
      dailySpendCents = 0;
      monthlySpendCents = 0;
      lastDailyReset = new Date();
      lastMonthlyReset = new Date();
    },
  };
}

// Validation helpers

/**
 * Validate spending limits configuration.
 */
function validateLimits(limits: SpendingLimits): void {
  const checks = [
    { value: limits.perTransaction, name: "perTransaction" },
    { value: limits.perDay, name: "perDay" },
    { value: limits.perMonth, name: "perMonth" },
  ];

  for (const check of checks) {
    if (!Number.isInteger(check.value)) {
      throw new Error(
        `[SpendingChecker] Limit "${check.name}" must be an integer (cents). ` +
          `Received: ${String(check.value)}. ` +
          "All limits must be specified in integer cents.",
      );
    }
    if (check.value < 0) {
      throw new Error(
        `[SpendingChecker] Limit "${check.name}" must be non-negative. ` +
          `Received: ${String(check.value)} cents.`,
      );
    }
  }
}

// Utility exports

/**
 * Convert dollars to cents for use with the spending checker.
 *
 * @param dollars - Amount in dollars (can have decimal places).
 * @returns Integer cents.
 *
 * @example
 * ```ts
 * const cents = dollarsToCents(200.00);  // 20000
 * const cents = dollarsToCents(0.99);    // 99
 * ```
 */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/**
 * Convert cents to dollars for display.
 *
 * @param cents - Amount in integer cents.
 * @returns Formatted dollar string with two decimal places and thousand separators.
 *
 * @example
 * ```ts
 * const display = centsToDollars(20000);  // "$200.00"
 * const display = centsToDollars(99);     // "$0.99"
 * const display = centsToDollars(123456789);  // "$1,234,567.89"
 * ```
 */
export function centsToDollars(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
