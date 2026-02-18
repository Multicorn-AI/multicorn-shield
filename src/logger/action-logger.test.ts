/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createActionLogger, type ActionLogger, type ActionPayload } from "./action-logger.js";
import { ACTION_STATUSES, type ActionStatus } from "../types/index.js";

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/**
 * Mock fetch for testing HTTP interactions.
 */
function createFetchMock(): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; options: RequestInit }[];
  mockResponse: (status: number, body?: string) => void;
  mockNetworkError: (message: string) => void;
  mockTimeout: () => void;
} {
  const calls: { url: string; options: RequestInit }[] = [];
  let responseStatus = 200;
  let responseBody = "";
  let shouldThrowNetworkError = false;
  let networkErrorMessage = "";
  let shouldTimeout = false;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, options: init ?? {} });

    if (shouldTimeout) {
      // Simulate timeout by waiting for abort signal
      return new Promise((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        }
      });
    }

    if (shouldThrowNetworkError) {
      throw new Error(networkErrorMessage);
    }

    return {
      ok: responseStatus >= 200 && responseStatus < 300,
      status: responseStatus,
      statusText: responseStatus === 200 ? "OK" : "Error",
      text: () => Promise.resolve(responseBody),
    } as Response;
  });

  const fetch = fetchMock as unknown as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    mockResponse: (status: number, body = "") => {
      responseStatus = status;
      responseBody = body;
      shouldThrowNetworkError = false;
      shouldTimeout = false;
    },
    mockNetworkError: (message: string) => {
      shouldThrowNetworkError = true;
      networkErrorMessage = message;
      shouldTimeout = false;
    },
    mockTimeout: () => {
      shouldTimeout = true;
      shouldThrowNetworkError = false;
    },
  };
}

/**
 * Wait for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("createActionLogger", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof createFetchMock>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = createFetchMock();
    globalThis.fetch = fetchMock.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ---------------------------------------------------------------------------
  // Configuration validation
  // ---------------------------------------------------------------------------

  describe("configuration validation", () => {
    it("throws if API key is missing", () => {
      expect(() => {
        createActionLogger({ apiKey: "" });
      }).toThrow(/API key is required/);
    });

    it("throws if API key is only whitespace", () => {
      expect(() => {
        createActionLogger({ apiKey: "   " });
      }).toThrow(/API key is required/);
    });

    it("throws if base URL is not HTTPS", () => {
      expect(() => {
        createActionLogger({
          apiKey: "test-key",
          baseUrl: "http://api.multicorn.ai",
        });
      }).toThrow(/must use HTTPS/);
    });

    it("allows http://localhost for local development", () => {
      expect(() => {
        createActionLogger({
          apiKey: "test-key",
          baseUrl: "http://localhost:3000",
        });
      }).not.toThrow();
    });

    it("uses default base URL if not provided", () => {
      const logger = createActionLogger({ apiKey: "test-key" });
      expect(logger).toBeDefined();
    });

    it("uses default timeout if not provided", () => {
      const logger = createActionLogger({ apiKey: "test-key" });
      expect(logger).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Successful logging (immediate mode)
  // ---------------------------------------------------------------------------

  describe("successful logging (immediate mode)", () => {
    let logger: ActionLogger;

    beforeEach(() => {
      logger = createActionLogger({
        apiKey: "test-key",
        baseUrl: "https://api.multicorn.ai",
      });
      fetchMock.mockResponse(200);
    });

    afterEach(async () => {
      await logger.shutdown();
    });

    it("sends a valid action to the API", async () => {
      const action: ActionPayload = {
        agent: "email-assistant",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      };

      await logger.logAction(action);
      await sleep(50); // Give time for fire-and-forget to complete

      expect(fetchMock.calls).toHaveLength(1);
      expect(fetchMock.calls[0]?.url).toBe("https://api.multicorn.ai/api/v1/actions");

      const options = fetchMock.calls[0]?.options;
      expect(options?.method).toBe("POST");
      expect(options?.headers).toMatchObject({
        "Content-Type": "application/json",
        "X-Multicorn-Key": "test-key",
      });

      const body: unknown = JSON.parse(options?.body as string);
      expect(body).toEqual(action);
    });

    it("sends action with cost and metadata", async () => {
      const action: ActionPayload = {
        agent: "inbox-assistant",
        service: "gmail",
        actionType: "read_message",
        status: ACTION_STATUSES.Approved,
        cost: 0.002,
        metadata: {
          messageId: "msg-123",
          subject: "Weekly report",
          read: true,
        },
      };

      await logger.logAction(action);
      await sleep(50);

      expect(fetchMock.calls).toHaveLength(1);
      const body: unknown = JSON.parse(fetchMock.calls[0]?.options.body as string);
      expect(body).toEqual(action);
    });

    it("sends multiple actions independently", async () => {
      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await logger.logAction({
        agent: "agent-2",
        service: "slack",
        actionType: "post_message",
        status: ACTION_STATUSES.Blocked,
      });

      await sleep(50);

      expect(fetchMock.calls).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Action validation
  // ---------------------------------------------------------------------------

  describe("action validation", () => {
    let logger: ActionLogger;

    beforeEach(() => {
      logger = createActionLogger({ apiKey: "test-key" });
      fetchMock.mockResponse(200);
    });

    afterEach(async () => {
      await logger.shutdown();
    });

    it("throws if agent is missing", () => {
      expect(() =>
        logger.logAction({
          agent: "",
          service: "gmail",
          actionType: "send_email",
          status: ACTION_STATUSES.Approved,
        }),
      ).toThrow(/non-empty 'agent'/);
    });

    it("throws if service is missing", () => {
      expect(() =>
        logger.logAction({
          agent: "agent-1",
          service: "",
          actionType: "send_email",
          status: ACTION_STATUSES.Approved,
        }),
      ).toThrow(/non-empty 'service'/);
    });

    it("throws if actionType is missing", () => {
      expect(() =>
        logger.logAction({
          agent: "agent-1",
          service: "gmail",
          actionType: "",
          status: ACTION_STATUSES.Approved,
        }),
      ).toThrow(/non-empty 'actionType'/);
    });

    it("throws if status is missing", () => {
      expect(() =>
        logger.logAction({
          agent: "agent-1",
          service: "gmail",
          actionType: "send_email",
          status: "" as ActionStatus,
        }),
      ).toThrow(/non-empty 'status'/);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling (4xx)
  // ---------------------------------------------------------------------------

  describe("error handling (4xx client errors)", () => {
    let logger: ActionLogger;
    let errorHandler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      errorHandler = vi.fn();
      logger = createActionLogger({
        apiKey: "test-key",
        onError: errorHandler,
      });
    });

    afterEach(async () => {
      await logger.shutdown();
    });

    it("does not retry on 400 Bad Request", async () => {
      fetchMock.mockResponse(400, "Invalid payload");

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(50);

      expect(fetchMock.calls).toHaveLength(1);
      expect(errorHandler).toHaveBeenCalledOnce();

      expect(errorHandler.mock.calls[0]?.[0]?.message).toContain("Client error (400)");
    });

    it("does not retry on 401 Unauthorized", async () => {
      fetchMock.mockResponse(401, "Invalid API key");

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(50);

      expect(fetchMock.calls).toHaveLength(1);
      expect(errorHandler).toHaveBeenCalledOnce();

      expect(errorHandler.mock.calls[0]?.[0]?.message).toContain("Client error (401)");
    });

    it("does not retry on 404 Not Found", async () => {
      fetchMock.mockResponse(404);

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(50);

      expect(fetchMock.calls).toHaveLength(1);
      expect(errorHandler).toHaveBeenCalledOnce();
    });

    it("includes response body in error message", async () => {
      fetchMock.mockResponse(400, '{"error":"Invalid agent ID"}');

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(50);

      expect(errorHandler.mock.calls[0]?.[0]?.message).toContain("Invalid agent ID");
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling (5xx)
  // ---------------------------------------------------------------------------

  describe("error handling (5xx server errors)", () => {
    let logger: ActionLogger;
    let errorHandler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      errorHandler = vi.fn();
      logger = createActionLogger({
        apiKey: "test-key",
        onError: errorHandler,
      });
    });

    afterEach(async () => {
      await logger.shutdown();
    });

    it("retries once on 500 Internal Server Error", async () => {
      fetchMock.mockResponse(500);

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(400); // Wait for retry (100ms + 200ms + overhead)

      expect(fetchMock.calls).toHaveLength(2);
      expect(errorHandler).toHaveBeenCalledOnce();

      expect(errorHandler.mock.calls[0]?.[0]?.message).toContain("Server error (500)");
    });

    it("retries once on 503 Service Unavailable", async () => {
      fetchMock.mockResponse(503);

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(400);

      expect(fetchMock.calls).toHaveLength(2);
      expect(errorHandler).toHaveBeenCalledOnce();
    });

    it("succeeds on retry if server recovers", async () => {
      let callCount = 0;

      (fetchMock.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          fetchMock.calls.push({ url, options: init ?? {} });
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              ok: false,
              status: 500,
              statusText: "Internal Server Error",
              text: () => Promise.resolve(""),
            } as Response);
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: "OK",
            text: () => Promise.resolve(""),
          } as Response);
        },
      );

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(400);

      expect(fetchMock.calls).toHaveLength(2);
      expect(errorHandler).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Network errors
  // ---------------------------------------------------------------------------

  describe("network errors", () => {
    let logger: ActionLogger;
    let errorHandler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      errorHandler = vi.fn();
      logger = createActionLogger({
        apiKey: "test-key",
        onError: errorHandler,
      });
    });

    afterEach(async () => {
      await logger.shutdown();
    });

    it("retries once on network failure", async () => {
      fetchMock.mockNetworkError("Failed to fetch");

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(400);

      expect(fetchMock.calls).toHaveLength(2);
      expect(errorHandler).toHaveBeenCalledOnce();

      expect(errorHandler.mock.calls[0]?.[0]?.message).toContain("Network error");
    });

    it("succeeds on retry if network recovers", async () => {
      let callCount = 0;

      (fetchMock.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          fetchMock.calls.push({ url, options: init ?? {} });
          callCount++;
          if (callCount === 1) {
            throw new Error("Network error");
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: "OK",
            text: () => Promise.resolve(""),
          } as Response);
        },
      );

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(400);

      expect(fetchMock.calls).toHaveLength(2);
      expect(errorHandler).not.toHaveBeenCalled();
    });

    it("reports network error with descriptive message for DNS failure", async () => {
      fetchMock.mockNetworkError("getaddrinfo ENOTFOUND api.multicorn.ai");

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(400);

      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler.mock.calls[0]?.[0]?.message).toContain("Network error");
      expect(errorHandler.mock.calls[0]?.[0]?.message).toContain("ENOTFOUND");
    });

    it("reports network error with descriptive message for connection refused", async () => {
      fetchMock.mockNetworkError("connect ECONNREFUSED 127.0.0.1:443");

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(400);

      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler.mock.calls[0]?.[0]?.message).toContain("Network error");
      expect(errorHandler.mock.calls[0]?.[0]?.message).toContain("ECONNREFUSED");
    });

    it("handles non-Error thrown by fetch gracefully", async () => {
      (fetchMock.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          fetchMock.calls.push({ url, options: init ?? {} });
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw "string error, not an Error object";
        },
      );

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(400);

      expect(errorHandler).toHaveBeenCalled();
      expect(errorHandler.mock.calls[0]?.[0]?.message).toContain("Unknown error");
    });
  });

  // ---------------------------------------------------------------------------
  // Timeout handling
  // ---------------------------------------------------------------------------

  describe("timeout handling", () => {
    let logger: ActionLogger;
    let errorHandler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      errorHandler = vi.fn();
      logger = createActionLogger({
        apiKey: "test-key",
        timeout: 100,
        onError: errorHandler,
      });
    });

    afterEach(async () => {
      await logger.shutdown();
    });

    it("aborts request after timeout", async () => {
      fetchMock.mockTimeout();

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(500);

      expect(errorHandler).toHaveBeenCalled();

      expect(errorHandler.mock.calls[0]?.[0]?.message).toContain("timeout");
    });

    it("retries once on timeout", async () => {
      fetchMock.mockTimeout();

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(500);

      expect(fetchMock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Batch mode
  // ---------------------------------------------------------------------------

  describe("batch mode", () => {
    let logger: ActionLogger;

    afterEach(async () => {
      await logger.shutdown();
    });

    it("queues actions and flushes when batch size is reached", async () => {
      logger = createActionLogger({
        apiKey: "test-key",
        batchMode: { enabled: true, maxSize: 3, flushIntervalMs: 10000 },
      });
      fetchMock.mockResponse(200);

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });
      await logger.logAction({
        agent: "agent-2",
        service: "slack",
        actionType: "post_message",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(50);
      expect(fetchMock.calls).toHaveLength(0); // Not flushed yet

      await logger.logAction({
        agent: "agent-3",
        service: "calendar",
        actionType: "create_event",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(50);
      expect(fetchMock.calls).toHaveLength(1); // Flushed after 3 actions

      const call = fetchMock.calls[0];
      if (call) {
        const body: unknown = JSON.parse(call.options.body as string);
        expect((body as { actions: unknown[] }).actions).toHaveLength(3);
      }
    });

    it("flushes actions after interval", async () => {
      logger = createActionLogger({
        apiKey: "test-key",
        batchMode: { enabled: true, maxSize: 10, flushIntervalMs: 200 },
      });
      fetchMock.mockResponse(200);

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(50);
      expect(fetchMock.calls).toHaveLength(0); // Not flushed yet

      await sleep(200);
      expect(fetchMock.calls).toHaveLength(1); // Flushed after interval

      const call = fetchMock.calls[0];
      if (call) {
        const body: unknown = JSON.parse(call.options.body as string);
        expect((body as { actions: unknown[] }).actions).toHaveLength(1);
      }
    });

    it("flush() sends all queued actions immediately", async () => {
      logger = createActionLogger({
        apiKey: "test-key",
        batchMode: { enabled: true, maxSize: 10, flushIntervalMs: 10000 },
      });
      fetchMock.mockResponse(200);

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });
      await logger.logAction({
        agent: "agent-2",
        service: "slack",
        actionType: "post_message",
        status: ACTION_STATUSES.Approved,
      });

      expect(fetchMock.calls).toHaveLength(0);

      await logger.flush();

      expect(fetchMock.calls).toHaveLength(1);
      const call = fetchMock.calls[0];
      if (call) {
        const body: unknown = JSON.parse(call.options.body as string);
        expect((body as { actions: unknown[] }).actions).toHaveLength(2);
      }
    });

    it("flush() is a no-op in immediate mode", async () => {
      logger = createActionLogger({
        apiKey: "test-key",
        batchMode: { enabled: false },
      });
      fetchMock.mockResponse(200);

      await logger.flush();

      expect(fetchMock.calls).toHaveLength(0);
    });

    it("shutdown() flushes remaining actions", async () => {
      logger = createActionLogger({
        apiKey: "test-key",
        batchMode: { enabled: true, maxSize: 10, flushIntervalMs: 10000 },
      });
      fetchMock.mockResponse(200);

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      expect(fetchMock.calls).toHaveLength(0);

      await logger.shutdown();

      expect(fetchMock.calls).toHaveLength(1);
      const call = fetchMock.calls[0];
      if (call) {
        const body: unknown = JSON.parse(call.options.body as string);
        expect((body as { actions: unknown[] }).actions).toHaveLength(1);
      }
    });

    it("throws if logging after shutdown", async () => {
      logger = createActionLogger({
        apiKey: "test-key",
      });

      await logger.shutdown();

      expect(() =>
        logger.logAction({
          agent: "agent-1",
          service: "gmail",
          actionType: "send_email",
          status: ACTION_STATUSES.Approved,
        }),
      ).toThrow(/after shutdown/);
    });

    it("shutdown is idempotent in batch mode", async () => {
      logger = createActionLogger({
        apiKey: "test-key",
        batchMode: { enabled: true, maxSize: 10, flushIntervalMs: 10000 },
      });
      fetchMock.mockResponse(200);

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await logger.shutdown();
      await logger.shutdown(); // Second call should be a no-op

      expect(fetchMock.calls).toHaveLength(1); // Only flushed once
    });

    it("shutdown flushes remaining actions even when flush timer has not fired", async () => {
      logger = createActionLogger({
        apiKey: "test-key",
        batchMode: { enabled: true, maxSize: 100, flushIntervalMs: 60000 },
      });
      fetchMock.mockResponse(200);

      // Queue 5 actions (well below maxSize of 100)
      for (let i = 0; i < 5; i++) {
        await logger.logAction({
          agent: `agent-${String(i)}`,
          service: "gmail",
          actionType: "send_email",
          status: ACTION_STATUSES.Approved,
        });
      }

      // Nothing flushed yet
      expect(fetchMock.calls).toHaveLength(0);

      // Shutdown should flush all 5
      await logger.shutdown();

      expect(fetchMock.calls).toHaveLength(1);
      const call = fetchMock.calls[0];
      if (call) {
        const body: unknown = JSON.parse(call.options.body as string);
        expect((body as { actions: unknown[] }).actions).toHaveLength(5);
      }
    });

    it("silently handles errors without onError callback in immediate mode", async () => {
      logger = createActionLogger({
        apiKey: "test-key",
        // intentionally no onError callback
      });
      fetchMock.mockNetworkError("Network failure");

      // Should not throw — fire-and-forget
      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(400);

      // No crash, calls were attempted
      expect(fetchMock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Fire-and-forget behaviour
  // ---------------------------------------------------------------------------

  describe("fire-and-forget behaviour", () => {
    it("does not block on network errors", async () => {
      const errorHandler = vi.fn();
      const logger = createActionLogger({
        apiKey: "test-key",
        onError: errorHandler,
      });
      fetchMock.mockNetworkError("Network failure");

      const start = Date.now();
      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });
      const elapsed = Date.now() - start;

      // Should return immediately (< 50ms)
      expect(elapsed).toBeLessThan(50);

      await logger.shutdown();
    });

    it("does not block on 5xx errors", async () => {
      const errorHandler = vi.fn();
      const logger = createActionLogger({
        apiKey: "test-key",
        onError: errorHandler,
      });
      fetchMock.mockResponse(500);

      const start = Date.now();
      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);

      await logger.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Error propagation from onError callback
  // ---------------------------------------------------------------------------

  describe("error propagation from onError callback", () => {
    it("swallows errors when onError callback itself throws in immediate mode", async () => {
      const logger = createActionLogger({
        apiKey: "test-key",
        onError: () => {
          throw new Error("onError handler crashed");
        },
      });
      fetchMock.mockNetworkError("Network failure");

      // Should not throw — the internal .catch() safety net catches it
      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(400);

      // No crash — fire-and-forget design holds
      expect(fetchMock.calls.length).toBeGreaterThanOrEqual(1);

      await logger.shutdown();
    });

    it("swallows errors when onError callback throws in batch mode at max size", async () => {
      const logger = createActionLogger({
        apiKey: "test-key",
        batchMode: { enabled: true, maxSize: 2, flushIntervalMs: 60000 },
        onError: () => {
          throw new Error("onError handler crashed");
        },
      });
      fetchMock.mockNetworkError("Network failure");

      // Queue two actions to trigger flush (maxSize = 2)
      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });
      await logger.logAction({
        agent: "agent-2",
        service: "gmail",
        actionType: "read_inbox",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(400);

      // No crash — the catch handler in logAction absorbed it
      expect(fetchMock.calls.length).toBeGreaterThanOrEqual(1);

      await logger.shutdown();
    });

    it("swallows errors when onError callback throws during interval flush", async () => {
      const logger = createActionLogger({
        apiKey: "test-key",
        batchMode: { enabled: true, maxSize: 100, flushIntervalMs: 100 },
        onError: () => {
          throw new Error("onError handler crashed in interval");
        },
      });
      fetchMock.mockNetworkError("Network failure");

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      // Wait for the interval to fire (100ms + retry backoff + overhead)
      await sleep(600);

      // No crash — the catch handler in setInterval absorbed it
      expect(fetchMock.calls.length).toBeGreaterThanOrEqual(1);

      await logger.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // API key security
  // ---------------------------------------------------------------------------

  describe("API key security", () => {
    it("includes API key in X-Multicorn-Key header", async () => {
      const logger = createActionLogger({
        apiKey: "secret-key-123",
      });
      fetchMock.mockResponse(200);

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(50);

      const options = fetchMock.calls[0]?.options;
      expect(options?.headers).toMatchObject({
        "X-Multicorn-Key": "secret-key-123",
      });

      await logger.shutdown();
    });

    it("does not include API key in request body", async () => {
      const logger = createActionLogger({
        apiKey: "secret-key-123",
      });
      fetchMock.mockResponse(200);

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(50);

      const call = fetchMock.calls[0];
      if (call) {
        const body = call.options.body as string;
        expect(body).not.toContain("secret-key-123");
      }

      await logger.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Custom base URL
  // ---------------------------------------------------------------------------

  describe("custom base URL", () => {
    it("uses custom base URL for API requests", async () => {
      const logger = createActionLogger({
        apiKey: "test-key",
        baseUrl: "https://custom.multicorn.ai",
      });
      fetchMock.mockResponse(200);

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(50);

      expect(fetchMock.calls[0]?.url).toBe("https://custom.multicorn.ai/api/v1/actions");

      await logger.shutdown();
    });

    it("supports localhost for development", async () => {
      const logger = createActionLogger({
        apiKey: "test-key",
        baseUrl: "http://localhost:3000",
      });
      fetchMock.mockResponse(200);

      await logger.logAction({
        agent: "agent-1",
        service: "gmail",
        actionType: "send_email",
        status: ACTION_STATUSES.Approved,
      });

      await sleep(50);

      expect(fetchMock.calls[0]?.url).toBe("http://localhost:3000/api/v1/actions");

      await logger.shutdown();
    });
  });
});
