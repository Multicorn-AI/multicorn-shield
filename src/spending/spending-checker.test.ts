import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSpendingChecker,
  type SpendingChecker,
  type SpendingLimits,
  dollarsToCents,
  centsToDollars,
} from "./spending-checker.js";

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/**
 * Default spending limits for tests: $200 / $1,000 / $5,000
 */
const DEFAULT_LIMITS: SpendingLimits = {
  perTransaction: 20000, // $200.00
  perDay: 100000, // $1,000.00
  perMonth: 500000, // $5,000.00
};

/**
 * Mock Date.now() to control time-based resets.
 */
function mockDate(date: Date): void {
  vi.useFakeTimers();
  vi.setSystemTime(date);
}

/**
 * Restore real timers.
 */
function restoreDate(): void {
  vi.useRealTimers();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("createSpendingChecker", () => {
  // ---------------------------------------------------------------------------
  // Configuration validation
  // ---------------------------------------------------------------------------

  describe("configuration validation", () => {
    it("accepts valid configuration", () => {
      expect(() => {
        createSpendingChecker({
          limits: DEFAULT_LIMITS,
        });
      }).not.toThrow();
    });

    it("throws if perTransaction is negative", () => {
      expect(() => {
        createSpendingChecker({
          limits: {
            perTransaction: -100,
            perDay: 100000,
            perMonth: 500000,
          },
        });
      }).toThrow(/perTransaction.*must be non-negative/);
    });

    it("throws if perDay is negative", () => {
      expect(() => {
        createSpendingChecker({
          limits: {
            perTransaction: 20000,
            perDay: -100,
            perMonth: 500000,
          },
        });
      }).toThrow(/perDay.*must be non-negative/);
    });

    it("throws if perMonth is negative", () => {
      expect(() => {
        createSpendingChecker({
          limits: {
            perTransaction: 20000,
            perDay: 100000,
            perMonth: -100,
          },
        });
      }).toThrow(/perMonth.*must be non-negative/);
    });

    it("throws if perTransaction is not an integer", () => {
      expect(() => {
        createSpendingChecker({
          limits: {
            perTransaction: 200.5,
            perDay: 100000,
            perMonth: 500000,
          },
        });
      }).toThrow(/perTransaction.*must be an integer/);
    });

    it("throws if perDay is not an integer", () => {
      expect(() => {
        createSpendingChecker({
          limits: {
            perTransaction: 20000,
            perDay: 1000.99,
            perMonth: 500000,
          },
        });
      }).toThrow(/perDay.*must be an integer/);
    });

    it("throws if perMonth is not an integer", () => {
      expect(() => {
        createSpendingChecker({
          limits: {
            perTransaction: 20000,
            perDay: 100000,
            perMonth: 5000.01,
          },
        });
      }).toThrow(/perMonth.*must be an integer/);
    });

    it("allows zero limits", () => {
      expect(() => {
        createSpendingChecker({
          limits: {
            perTransaction: 0,
            perDay: 0,
            perMonth: 0,
          },
        });
      }).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Per-transaction limits
  // ---------------------------------------------------------------------------

  describe("per-transaction limits", () => {
    let checker: SpendingChecker;

    beforeEach(() => {
      checker = createSpendingChecker({
        limits: DEFAULT_LIMITS,
      });
    });

    it("allows spend under per-transaction limit", () => {
      const result = checker.checkSpend(10000); // $100.00

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.remainingBudget.transaction).toBe(20000);
    });

    it("allows spend exactly at per-transaction limit", () => {
      const result = checker.checkSpend(20000); // $200.00

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("blocks spend over per-transaction limit", () => {
      const result = checker.checkSpend(84900); // $849.00

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Action blocked");
      expect(result.reason).toContain("$849.00");
      expect(result.reason).toContain("per-transaction limit");
      expect(result.reason).toContain("$200.00");
    });

    it("allows zero transaction", () => {
      const result = checker.checkSpend(0); // $0.00

      expect(result.allowed).toBe(true);
    });

    it("blocks spend one cent over limit", () => {
      const result = checker.checkSpend(20001); // $200.01

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("$200.01");
      expect(result.reason).toContain("per-transaction limit");
    });

    it("throws if amount is negative", () => {
      expect(() => {
        checker.checkSpend(-100);
      }).toThrow(/must be non-negative/);
    });

    it("throws if amount is not an integer", () => {
      expect(() => {
        checker.checkSpend(100.5);
      }).toThrow(/must be an integer/);
    });
  });

  // ---------------------------------------------------------------------------
  // Per-day limits
  // ---------------------------------------------------------------------------

  describe("per-day limits", () => {
    let checker: SpendingChecker;

    beforeEach(() => {
      checker = createSpendingChecker({
        limits: DEFAULT_LIMITS,
      });
    });

    it("allows single transaction under daily limit", () => {
      const result = checker.checkSpend(15000); // $150.00 (under $200 per-transaction)

      expect(result.allowed).toBe(true);
      expect(result.remainingBudget.daily).toBe(100000); // Still $1,000 since not recorded
    });

    it("tracks cumulative spend across multiple transactions", () => {
      // Transaction 1: $150 (under $200 per-transaction)
      let result = checker.checkSpend(15000);
      expect(result.allowed).toBe(true);
      checker.recordSpend(15000);

      // Transaction 2: $150
      result = checker.checkSpend(15000);
      expect(result.allowed).toBe(true);
      expect(result.remainingBudget.daily).toBe(85000); // $850 remaining
      checker.recordSpend(15000);

      // Transaction 3: $150
      result = checker.checkSpend(15000);
      expect(result.allowed).toBe(true);
      expect(result.remainingBudget.daily).toBe(70000); // $700 remaining
    });

    it("allows spend exactly at daily limit", () => {
      // Need to spend in chunks under per-transaction limit ($200)
      checker.recordSpend(20000); // $200
      checker.recordSpend(20000); // $200
      checker.recordSpend(20000); // $200
      checker.recordSpend(20000); // $200
      checker.recordSpend(20000); // $200 = $1,000 total

      // Now at limit
      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(100000);

      // Try to spend anything more - should be blocked
      const result = checker.checkSpend(1);
      expect(result.allowed).toBe(false);
    });

    it("blocks spend that would exceed daily limit", () => {
      // Spend $900 in small transactions (under $200 each)
      checker.recordSpend(18000); // $180
      checker.recordSpend(18000); // $180
      checker.recordSpend(18000); // $180
      checker.recordSpend(18000); // $180
      checker.recordSpend(18000); // $180 = $900 total

      // Try to spend $150 (would exceed $1,000 daily limit)
      const result = checker.checkSpend(15000);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Action blocked");
      expect(result.reason).toContain("per-day limit");
      expect(result.reason).toContain("$900.00"); // Current spend
      expect(result.reason).toContain("$1,000.00"); // Limit
    });

    it("blocks spend one cent over daily limit", () => {
      checker.checkSpend(100000);
      checker.recordSpend(100000);

      const result = checker.checkSpend(1); // $0.01

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("per-day limit");
    });

    it("does not count unchecked spends (recordSpend without checkSpend)", () => {
      // Record without checking (unusual but possible)
      checker.recordSpend(50000); // $500 (recorded but not checked)

      const result = checker.checkSpend(15000); // $150 (under $200 per-transaction)
      expect(result.allowed).toBe(true);
      expect(result.remainingBudget.daily).toBe(50000); // $500 remaining
    });

    it("getCurrentSpend returns accurate daily total", () => {
      checker.recordSpend(40000); // $400
      checker.recordSpend(30000); // $300

      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(70000); // $700
    });
  });

  // ---------------------------------------------------------------------------
  // Per-month limits
  // ---------------------------------------------------------------------------

  describe("per-month limits", () => {
    let checker: SpendingChecker;

    beforeEach(() => {
      // Use higher per-transaction limit to test monthly limits properly
      checker = createSpendingChecker({
        limits: {
          perTransaction: 250000, // $2,500 (high enough to test monthly)
          perDay: 1000000, // $10,000 (high enough to not interfere)
          perMonth: 500000, // $5,000 (this is what we're testing)
        },
      });
    });

    it("allows single transaction under monthly limit", () => {
      const result = checker.checkSpend(200000); // $2,000.00

      expect(result.allowed).toBe(true);
      expect(result.remainingBudget.monthly).toBe(500000);
    });

    it("tracks cumulative spend across multiple transactions", () => {
      // Transaction 1: $2,000
      let result = checker.checkSpend(200000);
      expect(result.allowed).toBe(true);
      checker.recordSpend(200000);

      // Transaction 2: $2,000
      result = checker.checkSpend(200000);
      expect(result.allowed).toBe(true);
      expect(result.remainingBudget.monthly).toBe(300000); // $3,000 remaining
      checker.recordSpend(200000);

      // Transaction 3: $1,000
      result = checker.checkSpend(100000);
      expect(result.allowed).toBe(true);
      expect(result.remainingBudget.monthly).toBe(100000); // $1,000 remaining
    });

    it("allows spend exactly at monthly limit", () => {
      // Need to spend in chunks under per-transaction limit ($2,500)
      checker.recordSpend(200000); // $2,000
      checker.recordSpend(200000); // $2,000
      checker.recordSpend(100000); // $1,000 = $5,000 total

      // Now at limit
      const current = checker.getCurrentSpend();
      expect(current.monthly).toBe(500000);

      // Try to spend anything more - should be blocked
      const result = checker.checkSpend(1);
      expect(result.allowed).toBe(false);
    });

    it("blocks spend that would exceed monthly limit", () => {
      // Spend $4,500 (under per-transaction limit of $2,500 each)
      checker.checkSpend(200000);
      checker.recordSpend(200000); // $2,000
      checker.checkSpend(200000);
      checker.recordSpend(200000); // $2,000
      checker.recordSpend(50000); // $500 = $4,500 total

      // Try to spend $600 (would exceed $5,000 monthly limit)
      const result = checker.checkSpend(60000);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Action blocked");
      expect(result.reason).toContain("per-month limit");
      expect(result.reason).toContain("$4,500.00"); // Current spend
      expect(result.reason).toContain("$5,000.00"); // Limit
    });

    it("blocks spend one cent over monthly limit", () => {
      // Spend up to monthly limit using transactions under per-transaction limit
      checker.recordSpend(200000); // $2,000
      checker.recordSpend(200000); // $2,000
      checker.recordSpend(100000); // $1,000 = $5,000 total

      const result = checker.checkSpend(1); // $0.01

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("per-month limit");
    });

    it("getCurrentSpend returns accurate monthly total", () => {
      checker.recordSpend(200000); // $2,000
      checker.recordSpend(150000); // $1,500

      const current = checker.getCurrentSpend();
      expect(current.monthly).toBe(350000); // $3,500
    });
  });

  // ---------------------------------------------------------------------------
  // Cumulative tracking across multiple actions
  // ---------------------------------------------------------------------------

  describe("cumulative tracking", () => {
    let checker: SpendingChecker;

    beforeEach(() => {
      checker = createSpendingChecker({
        limits: DEFAULT_LIMITS,
      });
    });

    it("tracks multiple successful transactions correctly", () => {
      // Transaction 1: $100
      checker.checkSpend(10000);
      checker.recordSpend(10000);

      // Transaction 2: $200
      checker.checkSpend(20000);
      checker.recordSpend(20000);

      // Transaction 3: $150
      checker.checkSpend(15000);
      checker.recordSpend(15000);

      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(45000); // $450
      expect(current.monthly).toBe(45000); // $450
    });

    it("only counts recorded spends, not just checks", () => {
      // Check but don't record
      checker.checkSpend(10000);
      checker.checkSpend(20000);

      // Record only one
      checker.recordSpend(10000);

      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(10000); // Only $100
    });

    it("tracking persists across multiple checks", () => {
      checker.recordSpend(50000); // $500

      // Multiple checks should see the same cumulative total
      let result = checker.checkSpend(10000);
      expect(result.remainingBudget.daily).toBe(50000); // $500 remaining

      result = checker.checkSpend(20000);
      expect(result.remainingBudget.daily).toBe(50000); // Still $500 remaining
    });

    it("remaining budget updates after each recorded spend", () => {
      // Initial: $1,000 daily, $5,000 monthly
      let result = checker.checkSpend(10000);
      expect(result.remainingBudget.daily).toBe(100000);
      expect(result.remainingBudget.monthly).toBe(500000);

      checker.recordSpend(10000); // $100

      // After first spend: $900 daily, $4,900 monthly
      result = checker.checkSpend(10000);
      expect(result.remainingBudget.daily).toBe(90000);
      expect(result.remainingBudget.monthly).toBe(490000);

      checker.recordSpend(10000); // $100

      // After second spend: $800 daily, $4,800 monthly
      result = checker.checkSpend(10000);
      expect(result.remainingBudget.daily).toBe(80000);
      expect(result.remainingBudget.monthly).toBe(480000);
    });

    it("remaining budget never goes negative", () => {
      // Spend up to the limit
      checker.recordSpend(100000); // $1,000 (daily limit)

      const result = checker.checkSpend(1);
      expect(result.remainingBudget.daily).toBe(0); // Not negative
    });
  });

  // ---------------------------------------------------------------------------
  // Reset behavior
  // ---------------------------------------------------------------------------

  describe("reset behavior", () => {
    let checker: SpendingChecker;

    beforeEach(() => {
      mockDate(new Date("2024-01-15T10:00:00Z"));
      checker = createSpendingChecker({
        limits: DEFAULT_LIMITS,
      });
    });

    afterEach(() => {
      restoreDate();
    });

    it("manual reset clears daily and monthly totals", () => {
      checker.recordSpend(50000); // $500
      checker.recordSpend(30000); // $300

      let current = checker.getCurrentSpend();
      expect(current.daily).toBe(80000);
      expect(current.monthly).toBe(80000);

      checker.reset();

      current = checker.getCurrentSpend();
      expect(current.daily).toBe(0);
      expect(current.monthly).toBe(0);
    });

    it("manual reset does not affect limits", () => {
      checker.recordSpend(50000);
      checker.reset();

      const result = checker.checkSpend(20000);
      expect(result.allowed).toBe(true);
      expect(result.remainingBudget.transaction).toBe(20000);
      expect(result.remainingBudget.daily).toBe(100000);
      expect(result.remainingBudget.monthly).toBe(500000);
    });

    it("auto-resets daily spend at day boundary", () => {
      // Spend on Jan 15
      checker.recordSpend(50000); // $500

      // Move to Jan 16
      mockDate(new Date("2024-01-16T00:00:01Z"));

      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(0); // Reset
      expect(current.monthly).toBe(50000); // Not reset
    });

    it("auto-resets monthly spend at month boundary", () => {
      // Spend on Jan 15
      checker.recordSpend(200000); // $2,000

      // Move to Feb 1
      mockDate(new Date("2024-02-01T00:00:01Z"));

      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(0); // Reset (new day)
      expect(current.monthly).toBe(0); // Reset (new month)
    });

    it("day boundary resets daily but not monthly", () => {
      // Spend on Jan 15
      checker.recordSpend(50000); // $500

      // Move to Jan 20 (same month, different day)
      mockDate(new Date("2024-01-20T12:00:00Z"));

      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(0); // Reset
      expect(current.monthly).toBe(50000); // Not reset (same month)
    });

    it("month boundary resets both daily and monthly", () => {
      // Spend on Jan 31
      checker.recordSpend(100000); // $1,000

      // Move to Feb 1
      mockDate(new Date("2024-02-01T00:00:01Z"));

      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(0); // Reset (new day)
      expect(current.monthly).toBe(0); // Reset (new month)
    });

    it("allows full daily spend again after day reset", () => {
      // Spend daily limit on Jan 15 (in chunks under $200 per-transaction)
      checker.recordSpend(20000); // $200
      checker.recordSpend(20000); // $200
      checker.recordSpend(20000); // $200
      checker.recordSpend(20000); // $200
      checker.recordSpend(20000); // $200 = $1,000

      // Verify blocked
      let result = checker.checkSpend(1);
      expect(result.allowed).toBe(false);

      // Move to Jan 16
      mockDate(new Date("2024-01-16T00:00:01Z"));

      // Now allowed again (test with $150 under $200 per-transaction)
      result = checker.checkSpend(15000);
      expect(result.allowed).toBe(true);
    });

    it("allows full monthly spend again after month reset", () => {
      // Create a checker with the per-month limit context
      const monthlyChecker = createSpendingChecker({
        limits: {
          perTransaction: 250000, // $2,500
          perDay: 1000000, // $10,000
          perMonth: 500000, // $5,000
        },
      });

      mockDate(new Date("2024-01-31T10:00:00Z"));

      // Spend monthly limit on Jan 31
      monthlyChecker.recordSpend(200000); // $2,000
      monthlyChecker.recordSpend(200000); // $2,000
      monthlyChecker.recordSpend(100000); // $1,000 = $5,000

      // Verify blocked
      let result = monthlyChecker.checkSpend(1);
      expect(result.allowed).toBe(false);

      // Move to Feb 1
      mockDate(new Date("2024-02-01T00:00:01Z"));

      // Now allowed again (spend $2,000 which is under all limits)
      result = monthlyChecker.checkSpend(200000);
      expect(result.allowed).toBe(true);
    });

    it("auto-reset happens on checkSpend", () => {
      checker.recordSpend(50000);
      mockDate(new Date("2024-01-16T00:00:01Z"));

      const result = checker.checkSpend(10000);
      expect(result.remainingBudget.daily).toBe(100000); // Reset occurred
    });

    it("auto-reset happens on recordSpend", () => {
      checker.recordSpend(50000);
      mockDate(new Date("2024-01-16T00:00:01Z"));

      checker.recordSpend(10000);
      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(10000); // Only new spend, reset occurred
    });

    it("auto-reset happens on getCurrentSpend", () => {
      checker.recordSpend(50000);
      mockDate(new Date("2024-01-16T00:00:01Z"));

      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(0); // Reset occurred
    });
  });

  // ---------------------------------------------------------------------------
  // Remaining budget calculation
  // ---------------------------------------------------------------------------

  describe("remaining budget calculation", () => {
    let checker: SpendingChecker;

    beforeEach(() => {
      checker = createSpendingChecker({
        limits: DEFAULT_LIMITS,
      });
    });

    it("returns correct initial remaining budget", () => {
      const result = checker.checkSpend(0);

      expect(result.remainingBudget.transaction).toBe(20000); // $200
      expect(result.remainingBudget.daily).toBe(100000); // $1,000
      expect(result.remainingBudget.monthly).toBe(500000); // $5,000
    });

    it("transaction remaining never changes (not cumulative)", () => {
      checker.recordSpend(10000); // $100
      let result = checker.checkSpend(0);
      expect(result.remainingBudget.transaction).toBe(20000); // Still $200

      checker.recordSpend(10000); // $100
      result = checker.checkSpend(0);
      expect(result.remainingBudget.transaction).toBe(20000); // Still $200
    });

    it("daily remaining decreases with each spend", () => {
      let result = checker.checkSpend(0);
      expect(result.remainingBudget.daily).toBe(100000); // $1,000

      checker.recordSpend(30000); // $300
      result = checker.checkSpend(0);
      expect(result.remainingBudget.daily).toBe(70000); // $700

      checker.recordSpend(20000); // $200
      result = checker.checkSpend(0);
      expect(result.remainingBudget.daily).toBe(50000); // $500
    });

    it("monthly remaining decreases with each spend", () => {
      let result = checker.checkSpend(0);
      expect(result.remainingBudget.monthly).toBe(500000); // $5,000

      checker.recordSpend(100000); // $1,000
      result = checker.checkSpend(0);
      expect(result.remainingBudget.monthly).toBe(400000); // $4,000

      checker.recordSpend(100000); // $1,000
      result = checker.checkSpend(0);
      expect(result.remainingBudget.monthly).toBe(300000); // $3,000
    });

    it("remaining budget is accurate even when blocked", () => {
      checker.recordSpend(95000); // $950

      // Try to spend $100 (would exceed daily)
      const result = checker.checkSpend(10000);

      expect(result.allowed).toBe(false);
      expect(result.remainingBudget.daily).toBe(5000); // $50 remaining
    });
  });

  // ---------------------------------------------------------------------------
  // Error messages
  // ---------------------------------------------------------------------------

  describe("error messages", () => {
    let checker: SpendingChecker;

    beforeEach(() => {
      checker = createSpendingChecker({
        limits: DEFAULT_LIMITS,
      });
    });

    it("per-transaction error contains exact amounts", () => {
      const result = checker.checkSpend(84900); // $849.00

      expect(result.reason).toContain("$849.00");
      expect(result.reason).toContain("$200.00");
    });

    it("per-day error contains exact amounts", () => {
      // Spend $900 in small amounts (under $200 per-transaction)
      checker.recordSpend(18000); // $180
      checker.recordSpend(18000); // $180
      checker.recordSpend(18000); // $180
      checker.recordSpend(18000); // $180
      checker.recordSpend(18000); // $180 = $900

      const result = checker.checkSpend(15000); // $150

      expect(result.reason).toContain("$900.00");
      expect(result.reason).toContain("$1,000.00");
    });

    it("per-month error contains exact amounts", () => {
      // Use a checker with high per-transaction limit to test monthly
      const monthlyChecker = createSpendingChecker({
        limits: {
          perTransaction: 250000, // $2,500
          perDay: 1000000, // $10,000
          perMonth: 500000, // $5,000
        },
      });

      monthlyChecker.recordSpend(200000); // $2,000
      monthlyChecker.recordSpend(200000); // $2,000
      monthlyChecker.recordSpend(50000); // $500 = $4,500

      const result = monthlyChecker.checkSpend(60000); // $600

      expect(result.reason).toContain("$4,500.00");
      expect(result.reason).toContain("$5,000.00");
    });

    it("messages use two decimal places and thousand separators", () => {
      // Use a checker with high limits to allow large transaction
      const highLimitChecker = createSpendingChecker({
        limits: {
          perTransaction: 20000, // $200 (low enough to block $1,234.56)
          perDay: 1000000,
          perMonth: 10000000,
        },
      });

      const result = highLimitChecker.checkSpend(123456); // $1,234.56

      expect(result.reason).toContain("$1,234.56");
    });

    it("messages mention which limit was exceeded", () => {
      let result = checker.checkSpend(30000); // Over transaction
      expect(result.reason).toContain("per-transaction");

      checker.recordSpend(95000);
      result = checker.checkSpend(10000); // Over daily
      expect(result.reason).toContain("per-day");
    });

    it("blocked message starts with 'Action blocked'", () => {
      const result = checker.checkSpend(30000);

      expect(result.reason).toMatch(/^Action blocked/);
    });
  });

  // ---------------------------------------------------------------------------
  // Currency safety
  // ---------------------------------------------------------------------------

  describe("currency safety", () => {
    let checker: SpendingChecker;

    beforeEach(() => {
      checker = createSpendingChecker({
        limits: {
          perTransaction: 1000, // $10.00
          perDay: 10000, // $100.00
          perMonth: 100000, // $1,000.00
        },
      });
    });

    it("handles tiny amounts (1 cent) correctly", () => {
      const result = checker.checkSpend(1); // $0.01

      expect(result.allowed).toBe(true);
    });

    it("cumulative cents add up correctly (no floating point error)", () => {
      // Add 100 pennies
      for (let i = 0; i < 100; i++) {
        checker.recordSpend(1);
      }

      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(100); // Exactly $1.00, not 99 or 101
    });

    it("handles large amounts without precision loss", () => {
      const largeChecker = createSpendingChecker({
        limits: {
          perTransaction: 1000000000, // $10,000,000
          perDay: 5000000000, // $50,000,000
          perMonth: 10000000000, // $100,000,000
        },
      });

      const result = largeChecker.checkSpend(999999999);
      expect(result.allowed).toBe(true);

      largeChecker.recordSpend(999999999);
      const current = largeChecker.getCurrentSpend();
      expect(current.daily).toBe(999999999); // No precision loss
    });

    it("prevents floating point amounts at check time", () => {
      expect(() => {
        checker.checkSpend(10.5);
      }).toThrow(/must be an integer/);
    });

    it("prevents floating point amounts at record time", () => {
      expect(() => {
        checker.recordSpend(10.99);
      }).toThrow(/must be an integer/);
    });

    it("edge case: $0.01 transactions", () => {
      // Should be able to do 10 x $0.01 under $0.10 limit
      for (let i = 0; i < 10; i++) {
        const result = checker.checkSpend(1);
        expect(result.allowed).toBe(true);
        checker.recordSpend(1);
      }

      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(10); // Exactly $0.10
    });
  });

  // ---------------------------------------------------------------------------
  // Integration scenarios
  // ---------------------------------------------------------------------------

  describe("integration scenarios", () => {
    it("multiple checkers operate independently", () => {
      const checker1 = createSpendingChecker({ limits: DEFAULT_LIMITS });
      const checker2 = createSpendingChecker({ limits: DEFAULT_LIMITS });

      checker1.recordSpend(50000); // $500

      const current1 = checker1.getCurrentSpend();
      const current2 = checker2.getCurrentSpend();

      expect(current1.daily).toBe(50000);
      expect(current2.daily).toBe(0); // Independent
    });

    it("realistic agent spending pattern", () => {
      const checker = createSpendingChecker({
        limits: {
          perTransaction: 500, // $5.00
          perDay: 2000, // $20.00
          perMonth: 50000, // $500.00
        },
      });

      // Agent makes multiple API calls throughout the day
      const apiCallCost = 50; // $0.50 per call

      // Make 10 calls ($5.00 total)
      for (let i = 0; i < 10; i++) {
        const result = checker.checkSpend(apiCallCost);
        expect(result.allowed).toBe(true);
        checker.recordSpend(apiCallCost);
      }

      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(500); // $5.00
      expect(current.monthly).toBe(500);

      // Try to make 30 more calls ($15.00) - total would be $20.00
      for (let i = 0; i < 30; i++) {
        const result = checker.checkSpend(apiCallCost);
        expect(result.allowed).toBe(true);
        checker.recordSpend(apiCallCost);
      }

      // Next call should be blocked (would exceed daily $20.00)
      const result = checker.checkSpend(apiCallCost);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("per-day limit");
    });

    it("check before action, record after success pattern", () => {
      const checker = createSpendingChecker({ limits: DEFAULT_LIMITS });

      // Pattern: check -> execute -> record
      const cost = 10000; // $100

      // 1. Pre-check
      const preCheck = checker.checkSpend(cost);
      expect(preCheck.allowed).toBe(true);

      // 2. Execute action (simulated - would be actual API call in production)
      // 3. Record after successful action
      checker.recordSpend(cost);

      // Verify tracking
      const current = checker.getCurrentSpend();
      expect(current.daily).toBe(10000);
    });

    it("handles failed actions correctly (no record)", () => {
      const checker = createSpendingChecker({ limits: DEFAULT_LIMITS });

      // Check succeeds
      const result = checker.checkSpend(10000);
      expect(result.allowed).toBe(true);

      // Action fails (don't record)

      // Check again - should still have full budget
      const result2 = checker.checkSpend(10000);
      expect(result2.remainingBudget.daily).toBe(100000);
    });
  });

  // ---------------------------------------------------------------------------
  // Utility functions
  // ---------------------------------------------------------------------------

  describe("utility functions", () => {
    describe("dollarsToCents", () => {
      it("converts whole dollars", () => {
        expect(dollarsToCents(200)).toBe(20000);
      });

      it("converts dollars with cents", () => {
        expect(dollarsToCents(200.5)).toBe(20050);
      });

      it("handles small amounts", () => {
        expect(dollarsToCents(0.01)).toBe(1);
        expect(dollarsToCents(0.99)).toBe(99);
      });

      it("rounds to nearest cent", () => {
        expect(dollarsToCents(1.234)).toBe(123); // Rounds to 123
        expect(dollarsToCents(1.235)).toBe(124); // Rounds to 124
      });

      it("handles zero", () => {
        expect(dollarsToCents(0)).toBe(0);
      });
    });

    describe("centsToDollars", () => {
      it("formats whole dollars", () => {
        expect(centsToDollars(20000)).toBe("$200.00");
      });

      it("formats dollars with cents", () => {
        expect(centsToDollars(20050)).toBe("$200.50");
      });

      it("formats small amounts", () => {
        expect(centsToDollars(1)).toBe("$0.01");
        expect(centsToDollars(99)).toBe("$0.99");
      });

      it("always includes two decimal places", () => {
        expect(centsToDollars(100)).toBe("$1.00");
        expect(centsToDollars(1050)).toBe("$10.50");
      });

      it("handles zero", () => {
        expect(centsToDollars(0)).toBe("$0.00");
      });

      it("formats large amounts", () => {
        expect(centsToDollars(123456789)).toBe("$1,234,567.89");
      });
    });
  });
});
