import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import {
  findAgentByName,
  registerAgent,
  findOrRegisterAgent,
  fetchGrantedScopes,
  logAction,
  checkActionPermission,
  pollApprovalStatus,
  pollContentReviewStatus,
  requestContentReview,
  resetAuthErrorFlag,
} from "../shield-client.js";
import type { PluginLogger } from "../plugin-sdk.types.js";

const TEST_API_KEY = "mcs_test_key_never_logged";
const TEST_BASE_URL = "http://localhost:8080";

let fetchMock: ReturnType<typeof vi.fn>;
let stderrSpy: MockInstance;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  resetAuthErrorFlag(); // Reset auth error flag before each test
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("findAgentByName", () => {
  it("returns the matching agent when found", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: [
            { id: "agent-1", name: "openclaw" },
            { id: "agent-2", name: "other" },
          ],
        }),
    });

    const result = await findAgentByName("openclaw", TEST_API_KEY, TEST_BASE_URL);

    expect(result).toEqual({ id: "agent-1", name: "openclaw" });
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_BASE_URL}/api/v1/agents`,
      expect.objectContaining({
        headers: { "X-Multicorn-Key": TEST_API_KEY },
      }),
    );
  });

  it("returns null when the agent is not in the list", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: [{ id: "agent-2", name: "other" }],
        }),
    });

    const result = await findAgentByName("openclaw", TEST_API_KEY, TEST_BASE_URL);
    expect(result).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const result = await findAgentByName("openclaw", TEST_API_KEY, TEST_BASE_URL);
    expect(result).toBeNull();
  });

  it("returns null on network failure", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await findAgentByName("openclaw", TEST_API_KEY, TEST_BASE_URL);
    expect(result).toBeNull();
  });

  it("logs auth error once on 401 and returns null", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    const result1 = await findAgentByName("openclaw", TEST_API_KEY, TEST_BASE_URL, logger);
    const result2 = await findAgentByName("openclaw", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Authentication failed"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Authentication failed"));
  });

  it("logs auth error once on 403 and returns null", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({ ok: false, status: 403 });

    const result1 = await findAgentByName("openclaw", TEST_API_KEY, TEST_BASE_URL, logger);
    const result2 = await findAgentByName("openclaw", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Authentication failed"));
  });

  it("logs rate limit message on 429", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({ ok: false, status: 429 });

    const result = await findAgentByName("openclaw", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Rate limited by Shield API"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Rate limited"));
  });

  it("logs server error message on 5xx", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const result = await findAgentByName("openclaw", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Shield API error (500)"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Shield API error"));
  });
});

describe("registerAgent", () => {
  it("returns the new agent ID on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { id: "new-agent-id", name: "openclaw" },
        }),
    });

    const id = await registerAgent("openclaw", TEST_API_KEY, TEST_BASE_URL);

    expect(id).toBe("new-agent-id");
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_BASE_URL}/api/v1/agents`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "openclaw", platform: "openclaw" }),
      }),
    );
  });

  it("throws on HTTP error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: () => Promise.resolve({}) });

    await expect(registerAgent("openclaw", TEST_API_KEY, TEST_BASE_URL)).rejects.toThrow(
      "Failed to register agent",
    );
  });

  it("throws on malformed response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: {} }),
    });

    await expect(registerAgent("openclaw", TEST_API_KEY, TEST_BASE_URL)).rejects.toThrow(
      "unexpected response format",
    );
  });

  it("logs auth error once on 401 and throws", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) });

    await expect(registerAgent("openclaw", TEST_API_KEY, TEST_BASE_URL, logger)).rejects.toThrow();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Authentication failed"));
  });

  it("logs auth error once on 403 and throws", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { message: "Forbidden" } }),
    });

    await expect(registerAgent("openclaw", TEST_API_KEY, TEST_BASE_URL, logger)).rejects.toThrow();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Authentication failed"));
  });
});

describe("findOrRegisterAgent", () => {
  it("returns existing agent without registering", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: [{ id: "existing-id", name: "openclaw" }],
        }),
    });

    const result = await findOrRegisterAgent("openclaw", TEST_API_KEY, TEST_BASE_URL);

    expect(result).toEqual({ id: "existing-id", name: "openclaw" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("registers a new agent when none exists", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { id: "new-id", name: "openclaw" },
          }),
      });

    const result = await findOrRegisterAgent("openclaw", TEST_API_KEY, TEST_BASE_URL);

    expect(result).toEqual({ id: "new-id", name: "openclaw" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when API is unreachable for both find and register", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await findOrRegisterAgent("openclaw", TEST_API_KEY, TEST_BASE_URL);
    expect(result).toBeNull();
  });

  it("throws when agent limit is reached during registration", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({
            error: { message: "Agent limit reached for your plan" },
          }),
      });

    await expect(findOrRegisterAgent("openclaw", TEST_API_KEY, TEST_BASE_URL)).rejects.toThrow(
      "Agent limit reached. Upgrade your plan at app.multicorn.ai/settings.",
    );
  });
});

describe("fetchGrantedScopes", () => {
  it("returns parsed scopes from agent detail", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            permissions: [
              { service: "filesystem", read: true, write: true, execute: false, revoked_at: null },
              { service: "terminal", read: false, write: false, execute: true, revoked_at: null },
            ],
          },
        }),
    });

    const scopes = await fetchGrantedScopes("agent-1", TEST_API_KEY, TEST_BASE_URL);

    expect(scopes).toEqual([
      { service: "filesystem", permissionLevel: "read" },
      { service: "filesystem", permissionLevel: "write" },
      { service: "terminal", permissionLevel: "execute" },
    ]);
  });

  it("excludes revoked permissions", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            permissions: [
              {
                service: "filesystem",
                read: true,
                write: true,
                execute: false,
                revoked_at: "2026-03-01T00:00:00Z",
              },
              { service: "terminal", read: false, write: false, execute: true, revoked_at: null },
            ],
          },
        }),
    });

    const scopes = await fetchGrantedScopes("agent-1", TEST_API_KEY, TEST_BASE_URL);

    expect(scopes).toEqual([{ service: "terminal", permissionLevel: "execute" }]);
  });

  it("returns empty array on HTTP error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    const scopes = await fetchGrantedScopes("agent-1", TEST_API_KEY, TEST_BASE_URL);
    expect(scopes).toEqual([]);
  });

  it("returns empty array on network failure", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));

    const scopes = await fetchGrantedScopes("agent-1", TEST_API_KEY, TEST_BASE_URL);
    expect(scopes).toEqual([]);
  });

  it("logs auth error once on 401 and returns empty array", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    const scopes1 = await fetchGrantedScopes("agent-1", TEST_API_KEY, TEST_BASE_URL, logger);
    const scopes2 = await fetchGrantedScopes("agent-1", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(scopes1).toEqual([]);
    expect(scopes2).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Authentication failed"));
  });

  it("logs auth error once on 403 and returns empty array", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({ ok: false, status: 403 });

    const scopes1 = await fetchGrantedScopes("agent-1", TEST_API_KEY, TEST_BASE_URL, logger);
    const scopes2 = await fetchGrantedScopes("agent-1", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(scopes1).toEqual([]);
    expect(scopes2).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("logAction", () => {
  it("sends the correct payload to POST /api/v1/actions", async () => {
    fetchMock.mockResolvedValue({ ok: true });

    await logAction(
      {
        agent: "openclaw",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_BASE_URL}/api/v1/actions`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Multicorn-Key": TEST_API_KEY,
        },
        body: JSON.stringify({
          agent: "openclaw",
          service: "terminal",
          actionType: "exec",
          status: "approved",
        }),
      }),
    );
  });

  it("logs server error on 5xx without throwing", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await logAction(
      { agent: "openclaw", service: "terminal", actionType: "exec", status: "approved" },
      TEST_API_KEY,
      TEST_BASE_URL,
      logger,
    );

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Shield API error (500)"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Shield API error"));
  });

  it("logs auth error once on 401 without throwing", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    await logAction(
      { agent: "openclaw", service: "terminal", actionType: "exec", status: "approved" },
      TEST_API_KEY,
      TEST_BASE_URL,
      logger,
    );
    await logAction(
      { agent: "openclaw", service: "terminal", actionType: "exec", status: "approved" },
      TEST_API_KEY,
      TEST_BASE_URL,
      logger,
    );

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Authentication failed"));
  });

  it("logs rate limit message on 429", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({ ok: false, status: 429 });

    await logAction(
      { agent: "openclaw", service: "terminal", actionType: "exec", status: "approved" },
      TEST_API_KEY,
      TEST_BASE_URL,
      logger,
    );

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Rate limited"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Rate limited"));
  });

  it("writes to stderr on network error without throwing", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await logAction(
      { agent: "openclaw", service: "terminal", actionType: "exec", status: "approved" },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("never includes the API key in error output", async () => {
    fetchMock.mockRejectedValue(new Error("connection failed"));

    await logAction(
      { agent: "openclaw", service: "terminal", actionType: "exec", status: "approved" },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    for (const call of stderrSpy.mock.calls) {
      const output = String(call[0]);
      expect(output).not.toContain(TEST_API_KEY);
    }
  });

  it("includes metadata in payload when provided", async () => {
    fetchMock.mockResolvedValue({ ok: true });

    await logAction(
      {
        agent: "openclaw",
        service: "filesystem",
        actionType: "write",
        status: "approved",
        metadata: { path: "/tmp/test.txt" },
      },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body["metadata"]).toEqual({ path: "/tmp/test.txt" });
  });
});

describe("checkActionPermission", () => {
  it("returns { status: 'approved' } on 201 response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
    });

    const result = await checkActionPermission(
      {
        agent: "openclaw",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(result).toEqual({ status: "approved" });
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_BASE_URL}/api/v1/actions`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Multicorn-Key": TEST_API_KEY,
        },
      }),
    );
  });

  it("returns { status: 'pending', approvalId } on 202 response with approvalId", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          success: true,
          data: { approval_id: "approval-123" },
        }),
    });

    const result = await checkActionPermission(
      {
        agent: "openclaw",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(result).toEqual({ status: "pending", approvalId: "approval-123" });
  });

  it("returns { status: 'blocked' } on 202 response without approvalId", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 202,
      json: () =>
        Promise.resolve({
          success: true,
          data: {},
        }),
    });

    const result = await checkActionPermission(
      {
        agent: "openclaw",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(result).toEqual({ status: "blocked" });
  });

  it("returns { status: 'blocked' } on 202 response with invalid response format", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ success: false }),
    });

    const result = await checkActionPermission(
      {
        agent: "openclaw",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(result).toEqual({ status: "blocked" });
  });

  it("logs auth error once on 401 and returns blocked", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
    });

    const result1 = await checkActionPermission(
      {
        agent: "openclaw",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      },
      TEST_API_KEY,
      TEST_BASE_URL,
      logger,
    );
    const result2 = await checkActionPermission(
      {
        agent: "openclaw",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      },
      TEST_API_KEY,
      TEST_BASE_URL,
      logger,
    );

    expect(result1).toEqual({ status: "blocked" });
    expect(result2).toEqual({ status: "blocked" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Authentication failed"));
  });

  it("logs auth error once on 403 and returns blocked", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
    });

    const result1 = await checkActionPermission(
      {
        agent: "openclaw",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      },
      TEST_API_KEY,
      TEST_BASE_URL,
      logger,
    );
    const result2 = await checkActionPermission(
      {
        agent: "openclaw",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      },
      TEST_API_KEY,
      TEST_BASE_URL,
      logger,
    );

    expect(result1).toEqual({ status: "blocked" });
    expect(result2).toEqual({ status: "blocked" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Authentication failed"));
  });

  it("logs rate limit message on 429 and returns blocked", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
    });

    const result = await checkActionPermission(
      {
        agent: "openclaw",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      },
      TEST_API_KEY,
      TEST_BASE_URL,
      logger,
    );

    expect(result).toEqual({ status: "blocked" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Rate limited"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Rate limited"));
  });

  it("logs server error on 5xx and returns blocked", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await checkActionPermission(
      {
        agent: "openclaw",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      },
      TEST_API_KEY,
      TEST_BASE_URL,
      logger,
    );

    expect(result).toEqual({ status: "blocked" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Shield API error (500)"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Shield API error"));
  });

  it("returns { status: 'blocked' } on network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await checkActionPermission(
      {
        agent: "openclaw",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(result).toEqual({ status: "blocked" });
  });
});

describe("pollApprovalStatus", () => {
  let logger: PluginLogger;

  beforeEach(() => {
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  it("returns 'approved' when approval status is approved", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            id: "approval-123",
            status: "approved",
            decided_at: "2026-03-01T00:00:00Z",
          },
        }),
    });

    const result = await pollApprovalStatus("approval-123", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(result).toBe("approved");
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_BASE_URL}/api/v1/approvals/approval-123`,
      expect.objectContaining({
        headers: { "X-Multicorn-Key": TEST_API_KEY },
      }),
    );
  });

  it("returns 'rejected' when approval status is rejected", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            id: "approval-123",
            status: "rejected",
            decided_at: "2026-03-01T00:00:00Z",
          },
        }),
    });

    const result = await pollApprovalStatus("approval-123", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(result).toBe("rejected");
  });

  it("returns 'expired' when approval status is expired", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            id: "approval-123",
            status: "expired",
            decided_at: null,
          },
        }),
    });

    const result = await pollApprovalStatus("approval-123", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(result).toBe("expired");
  });

  it("polls multiple times when status is pending", async () => {
    let pollCount = 0;
    fetchMock.mockImplementation(() => {
      pollCount++;
      if (pollCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: {
                id: "approval-123",
                status: "pending",
                decided_at: null,
              },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              id: "approval-123",
              status: "approved",
              decided_at: "2026-03-01T00:00:00Z",
            },
          }),
      });
    });

    vi.useFakeTimers();
    const resultPromise = pollApprovalStatus("approval-123", TEST_API_KEY, TEST_BASE_URL, logger);

    // Wait for first poll
    await vi.runAllTimersAsync();
    // Advance time for second poll
    vi.advanceTimersByTime(3000);
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe("approved");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("returns 'timeout' after max polls", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            id: "approval-123",
            status: "pending",
            decided_at: null,
          },
        }),
    });

    vi.useFakeTimers();
    const resultPromise = pollApprovalStatus("approval-123", TEST_API_KEY, TEST_BASE_URL, logger);

    // Advance time to exceed timeout (100 polls * 3 seconds = 300 seconds)
    vi.advanceTimersByTime(300000);
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe("timeout");

    vi.useRealTimers();
  });

  it("retries on HTTP error with exponential backoff", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              id: "approval-123",
              status: "approved",
              decided_at: "2026-03-01T00:00:00Z",
            },
          }),
      });
    });

    vi.useFakeTimers();
    const resultPromise = pollApprovalStatus("approval-123", TEST_API_KEY, TEST_BASE_URL, logger);

    // Wait for retries with backoff
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(1000); // First retry backoff
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(2000); // Second retry backoff
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe("approved");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it("handles network errors gracefully and continues polling", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              id: "approval-123",
              status: "approved",
              decided_at: "2026-03-01T00:00:00Z",
            },
          }),
      });
    });

    vi.useFakeTimers();
    const resultPromise = pollApprovalStatus("approval-123", TEST_API_KEY, TEST_BASE_URL, logger);

    // Wait for error retry
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(3000); // Next poll interval
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe("approved");

    vi.useRealTimers();
  });

  it("works without logger", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            id: "approval-123",
            status: "approved",
            decided_at: "2026-03-01T00:00:00Z",
          },
        }),
    });

    const result = await pollApprovalStatus("approval-123", TEST_API_KEY, TEST_BASE_URL);

    expect(result).toBe("approved");
  });

  it("logs auth error once on 401 and returns timeout", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    const result = await pollApprovalStatus("approval-123", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(result).toBe("timeout");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Authentication failed"));
  });

  it("logs auth error once on 403 and returns timeout", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });

    const result = await pollApprovalStatus("approval-123", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(result).toBe("timeout");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Authentication failed"));
  });

  it("logs rate limit message on 429 and continues polling", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: false, status: 429 });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              id: "approval-123",
              status: "approved",
              decided_at: "2026-03-01T00:00:00Z",
            },
          }),
      });
    });

    vi.useFakeTimers();
    const resultPromise = pollApprovalStatus("approval-123", TEST_API_KEY, TEST_BASE_URL, logger);

    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(1000); // Retry delay
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(3000); // Poll interval
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe("approved");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Rate limited"));

    vi.useRealTimers();
  });

  it("logs server error on 5xx and continues polling", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              id: "approval-123",
              status: "approved",
              decided_at: "2026-03-01T00:00:00Z",
            },
          }),
      });
    });

    vi.useFakeTimers();
    const resultPromise = pollApprovalStatus("approval-123", TEST_API_KEY, TEST_BASE_URL, logger);

    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(1000); // Retry delay
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(3000); // Poll interval
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBe("approved");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Shield API error (500)"));

    vi.useRealTimers();
  });
});

describe("pollContentReviewStatus", () => {
  let logger: PluginLogger;

  beforeEach(() => {
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  it("returns approved when status goes from pending to approved", async () => {
    let n = 0;
    fetchMock.mockImplementation(() => {
      n++;
      if (n === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: { id: "rev-1", status: "pending" },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { id: "rev-1", status: "approved" },
          }),
      });
    });

    vi.useFakeTimers();
    const resultPromise = pollContentReviewStatus("rev-1", TEST_API_KEY, TEST_BASE_URL, logger);
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(3000);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toEqual({ status: "approved", reviewId: "rev-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_BASE_URL}/api/v1/content-reviews/rev-1/status`,
      expect.objectContaining({ headers: { "X-Multicorn-Key": TEST_API_KEY } }),
    );
    vi.useRealTimers();
  });

  it("returns blocked when status becomes blocked", async () => {
    let n = 0;
    fetchMock.mockImplementation(() => {
      n++;
      if (n === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: { id: "rev-1", status: "pending" },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { id: "rev-1", status: "blocked" },
          }),
      });
    });

    vi.useFakeTimers();
    const resultPromise = pollContentReviewStatus("rev-1", TEST_API_KEY, TEST_BASE_URL, logger);
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(3000);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toEqual({
      status: "blocked",
      reason: "blocked_by_reviewer",
      reviewId: "rev-1",
    });
    vi.useRealTimers();
  });

  it("returns timeout after max polls while pending", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { id: "rev-1", status: "pending" },
        }),
    });

    vi.useFakeTimers();
    const resultPromise = pollContentReviewStatus("rev-1", TEST_API_KEY, TEST_BASE_URL, logger);
    vi.advanceTimersByTime(300000);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toEqual({
      status: "timeout",
      reason: "decision_window_exceeded",
      reviewId: "rev-1",
    });
    vi.useRealTimers();
  });

  it("returns review_not_found on 404 without further polling", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    const result = await pollContentReviewStatus("rev-1", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(result).toEqual({
      status: "blocked",
      reason: "review_not_found",
      reviewId: "rev-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns plan_tier_insufficient on 403 with PLAN_TIER_INSUFFICIENT", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: () =>
        Promise.resolve({
          success: false,
          error: { code: "PLAN_TIER_INSUFFICIENT", message: "Upgrade required" },
        }),
    });

    const result = await pollContentReviewStatus("rev-1", TEST_API_KEY, TEST_BASE_URL, logger);

    expect(result).toEqual({
      status: "blocked",
      reason: "plan_tier_insufficient",
      reviewId: "rev-1",
    });
  });

  it("retries on HTTP error with exponential backoff then succeeds", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { id: "rev-1", status: "approved" },
          }),
      });
    });

    vi.useFakeTimers();
    const resultPromise = pollContentReviewStatus("rev-1", TEST_API_KEY, TEST_BASE_URL, logger);
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(2000);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toEqual({ status: "approved", reviewId: "rev-1" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("handles network errors and continues polling", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { id: "rev-1", status: "approved" },
          }),
      });
    });

    vi.useFakeTimers();
    const resultPromise = pollContentReviewStatus("rev-1", TEST_API_KEY, TEST_BASE_URL, logger);
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(3000);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toEqual({ status: "approved", reviewId: "rev-1" });
    vi.useRealTimers();
  });
});

describe("requestContentReview", () => {
  it("POSTs with cost 0 by default, then polls until approved", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: () =>
          Promise.resolve({
            success: true,
            data: { content_review_id: "rev-abc" },
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { id: "rev-abc", status: "approved" },
          }),
      });

    const result = await requestContentReview(
      { agent: "agent-1", service: "public_content", actionType: "post" },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(result).toEqual({ status: "approved", reviewId: "rev-abc" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(first[0]).toBe(`${TEST_BASE_URL}/api/v1/actions`);
    expect(JSON.parse(first[1].body as string)).toMatchObject({
      agent: "agent-1",
      service: "public_content",
      actionType: "post",
      status: "requires_approval",
      cost: 0,
    });
  });

  it("includes explicit cost in POST body when provided", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: () =>
          Promise.resolve({
            success: true,
            data: { content_review_id: "rev-abc" },
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { id: "rev-abc", status: "approved" },
          }),
      });

    await requestContentReview(
      {
        agent: "agent-1",
        service: "public_content",
        actionType: "post",
        cost: 2.5,
      },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    const first = fetchMock.mock.calls[0] as [string, RequestInit];
    const postBody = JSON.parse(first[1].body as string) as { cost?: number };
    expect(postBody.cost).toBe(2.5);
  });

  it("returns no_review_id when 202 body omits content_review_id", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ success: true, data: {} }),
    });

    const result = await requestContentReview(
      { agent: "a", service: "web", actionType: "deploy" },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(result).toEqual({ status: "blocked", reason: "no_review_id" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns plan_tier_insufficient on 403 without polling", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: () =>
        Promise.resolve({
          success: false,
          error: { code: "PLAN_TIER_INSUFFICIENT", message: "nope" },
        }),
    });

    const result = await requestContentReview(
      { agent: "a", service: "web", actionType: "deploy" },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(result).toEqual({ status: "blocked", reason: "plan_tier_insufficient" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns network_error when POST throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await requestContentReview(
      { agent: "a", service: "web", actionType: "deploy" },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(result).toEqual({ status: "blocked", reason: "network_error" });
  });

  it("returns no_review_id on unexpected 201", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({}) });

    const result = await requestContentReview(
      { agent: "a", service: "web", actionType: "deploy" },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(result).toEqual({ status: "blocked", reason: "no_review_id" });
  });
});
