import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import {
  findAgentByName,
  registerAgent,
  findOrRegisterAgent,
  fetchGrantedScopes,
  logAction,
  checkActionPermission,
  pollApprovalStatus,
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
        body: JSON.stringify({ name: "openclaw" }),
      }),
    );
  });

  it("throws on HTTP error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 });

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

  it("writes to stderr on HTTP error without throwing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await logAction(
      { agent: "openclaw", service: "terminal", actionType: "exec", status: "approved" },
      TEST_API_KEY,
      TEST_BASE_URL,
    );

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Action log failed: HTTP 500"));
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
          data: { approvalId: "approval-123" },
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

  it("returns { status: 'blocked' } on 403 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
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
});
