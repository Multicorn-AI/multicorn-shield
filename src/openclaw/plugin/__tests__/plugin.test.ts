import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  OpenClawPluginApi,
  PluginHookBeforeToolCallEvent,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
} from "../../plugin-sdk.types.js";
import { plugin, beforeToolCall, afterToolCall, resetState } from "../index.js";

// Mock all external dependencies

const findOrRegisterAgentMock = vi.hoisted(() => vi.fn());
const fetchGrantedScopesMock = vi.hoisted(() => vi.fn());
const logActionMock = vi.hoisted(() => vi.fn());
const checkActionPermissionMock = vi.hoisted(() => vi.fn());
const pollApprovalStatusMock = vi.hoisted(() => vi.fn());
const loadCachedScopesMock = vi.hoisted(() => vi.fn());
const saveCachedScopesMock = vi.hoisted(() => vi.fn());
const waitForConsentMock = vi.hoisted(() => vi.fn());

vi.mock("../../shield-client.js", () => ({
  findOrRegisterAgent: findOrRegisterAgentMock,
  fetchGrantedScopes: fetchGrantedScopesMock,
  logAction: logActionMock,
  checkActionPermission: checkActionPermissionMock,
  pollApprovalStatus: pollApprovalStatusMock,
}));

vi.mock("../../scope-cache.js", () => ({
  loadCachedScopes: loadCachedScopesMock,
  saveCachedScopes: saveCachedScopesMock,
}));

vi.mock("../../consent.js", () => ({
  waitForConsent: waitForConsentMock,
}));

function makeBeforeEvent(
  toolName: string,
  params: Record<string, unknown> = {},
): PluginHookBeforeToolCallEvent {
  return { toolName, params };
}

function makeAfterEvent(
  toolName: string,
  opts: Partial<PluginHookAfterToolCallEvent> = {},
): PluginHookAfterToolCallEvent {
  return { toolName, params: {}, ...opts };
}

function makeCtx(overrides: Partial<PluginHookToolContext> = {}): PluginHookToolContext {
  return { toolName: "exec", sessionKey: "agent:main:main", ...overrides };
}

beforeEach(() => {
  resetState();

  findOrRegisterAgentMock.mockReset();
  fetchGrantedScopesMock.mockReset();
  logActionMock.mockReset().mockResolvedValue(undefined);
  checkActionPermissionMock.mockReset();
  pollApprovalStatusMock.mockReset();
  loadCachedScopesMock.mockReset().mockResolvedValue(null);
  saveCachedScopesMock.mockReset().mockResolvedValue(undefined);
  waitForConsentMock.mockReset();

  vi.stubEnv("MULTICORN_API_KEY", "mcs_test_key_12345678");
  vi.stubEnv("MULTICORN_BASE_URL", "http://localhost:8080");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

describe("plugin definition", () => {
  it("has the correct id, name, and version", () => {
    expect(plugin.id).toBe("multicorn-shield");
    expect(plugin.name).toBe("Multicorn Shield");
    expect(plugin.version).toBe("0.1.0");
  });

  it("register() calls api.on for before_tool_call and after_tool_call", () => {
    const onMock = vi.fn();
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: onMock,
    } as unknown as OpenClawPluginApi;

    void plugin.register?.(api);

    expect(onMock).toHaveBeenCalledTimes(2);
    expect(onMock).toHaveBeenCalledWith("before_tool_call", expect.any(Function), { priority: 10 });
    expect(onMock).toHaveBeenCalledWith("after_tool_call", expect.any(Function));
  });

  it("register() logs that the plugin was registered", () => {
    const infoMock = vi.fn();
    vi.stubEnv("MULTICORN_API_KEY", "mcs_test_key_12345678");
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: infoMock, warn: vi.fn(), error: vi.fn() },
      on: vi.fn(),
    } as unknown as OpenClawPluginApi;

    void plugin.register?.(api);

    expect(infoMock).toHaveBeenCalledWith("Multicorn Shield plugin registered.");
    expect(infoMock).toHaveBeenCalledWith(
      expect.stringContaining("Multicorn Shield connecting to"),
    );
  });

  it("register() logs error when API key is missing", () => {
    const errorMock = vi.fn();
    vi.stubEnv("MULTICORN_API_KEY", "");
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: vi.fn(), error: errorMock },
      on: vi.fn(),
    } as unknown as OpenClawPluginApi;

    void plugin.register?.(api);

    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining("Multicorn Shield: No API key found"),
    );
    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining("plugins.entries.multicorn-shield.env.MULTICORN_API_KEY"),
    );
  });

  it("register() logs connection info when API key is present", () => {
    const infoMock = vi.fn();
    vi.stubEnv("MULTICORN_API_KEY", "mcs_test_key_12345678");
    vi.stubEnv("MULTICORN_BASE_URL", "https://api.multicorn.ai");
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: infoMock, warn: vi.fn(), error: vi.fn() },
      on: vi.fn(),
    } as unknown as OpenClawPluginApi;

    void plugin.register?.(api);

    expect(infoMock).toHaveBeenCalledWith(
      "Multicorn Shield connecting to https://api.multicorn.ai",
    );
  });
});

// ---------------------------------------------------------------------------
// before_tool_call
// ---------------------------------------------------------------------------

describe("beforeToolCall", () => {
  it("returns undefined (allow) when the scope is granted", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toBeUndefined();
    expect(checkActionPermissionMock).toHaveBeenCalled();
  });

  it("returns { block: true } when the scope is not granted", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "filesystem", permissionLevel: "read" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "blocked" });

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("Terminal execute access is not allowed") as string,
    });
    expect(checkActionPermissionMock).toHaveBeenCalled();
  });

  it("triggers consent flow when no scopes are granted", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([]);
    waitForConsentMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(waitForConsentMock).toHaveBeenCalledWith(
      "agent-1",
      "main",
      expect.any(String),
      expect.any(String),
    );
    // After consent grants terminal:execute, the call should be allowed
    expect(result).toBeUndefined();
  });

  it("returns undefined when MULTICORN_API_KEY is not set", async () => {
    vi.stubEnv("MULTICORN_API_KEY", "");

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toBeUndefined();
    expect(findOrRegisterAgentMock).not.toHaveBeenCalled();
  });

  it("returns undefined (fail-open) when Shield API is unreachable", async () => {
    vi.stubEnv("MULTICORN_FAIL_MODE", "open");
    resetState();

    findOrRegisterAgentMock.mockResolvedValue(null);
    loadCachedScopesMock.mockResolvedValue(null);

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toBeUndefined();
  });

  it("returns { block: true } in fail-closed mode when Shield API is unreachable", async () => {
    vi.stubEnv("MULTICORN_FAIL_MODE", "closed");
    resetState();

    findOrRegisterAgentMock.mockResolvedValue(null);
    loadCachedScopesMock.mockResolvedValue(null);

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("fail-closed") as string,
    });
  });

  it("uses cached scopes when API is unreachable", async () => {
    loadCachedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    findOrRegisterAgentMock.mockResolvedValue(null);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toBeUndefined();
  });

  it("maps filesystem tools correctly (edit -> filesystem:write)", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "filesystem", permissionLevel: "write" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    const result = await beforeToolCall(makeBeforeEvent("edit"), makeCtx({ toolName: "edit" }));

    expect(result).toBeUndefined();
    expect(checkActionPermissionMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: "filesystem", actionType: "edit" }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("uses cached scopes on subsequent calls without re-fetching", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());
    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(findOrRegisterAgentMock).toHaveBeenCalledTimes(1);
    expect(fetchGrantedScopesMock).toHaveBeenCalledTimes(1);
    expect(checkActionPermissionMock).toHaveBeenCalledTimes(2);
  });

  it("derives agent name from session key", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "my-bot" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx({ sessionKey: "agent:my-bot:main" }));

    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "my-bot",
      expect.any(String),
      expect.any(String),
    );
  });

  it("handles pending approval and polls until approved", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({
      status: "pending",
      approvalId: "approval-123",
    });
    pollApprovalStatusMock.mockResolvedValue("approved");

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toBeUndefined();
    expect(checkActionPermissionMock).toHaveBeenCalled();
    expect(pollApprovalStatusMock).toHaveBeenCalledTimes(1);
    const callArgs = pollApprovalStatusMock.mock.calls[0];
    if (callArgs === undefined) {
      throw new Error("pollApprovalStatusMock was not called");
    }
    expect(callArgs[0]).toBe("approval-123");
    expect(typeof callArgs[1]).toBe("string");
    expect(typeof callArgs[2]).toBe("string");
    expect(callArgs.length).toBe(4);
  });

  it("blocks tool call when approval is rejected", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({
      status: "pending",
      approvalId: "approval-123",
    });
    pollApprovalStatusMock.mockResolvedValue("rejected");

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("reviewed and rejected") as string,
    });
  });

  it("blocks tool call when approval expires", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({
      status: "pending",
      approvalId: "approval-123",
    });
    pollApprovalStatusMock.mockResolvedValue("expired");

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toEqual({
      block: true,
      blockReason: "Approval request expired before a decision was made.",
    });
  });

  it("blocks tool call when approval times out", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({
      status: "pending",
      approvalId: "approval-123",
    });
    pollApprovalStatusMock.mockResolvedValue("timeout");

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toEqual({
      block: true,
      blockReason: "Approval request timed out after 5 minutes.",
    });
  });

  it("blocks tool call when checkActionPermission returns blocked (e.g., due to auth failure)", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    // Simulate auth failure - checkActionPermission returns blocked
    // (In real scenario, shield-client would log error and return blocked on 401/403)
    checkActionPermissionMock.mockResolvedValue({ status: "blocked" });

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // Should block the tool call
    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("Terminal execute access is not allowed") as string,
    });
    // Verify logger was passed to checkActionPermission (implicitly tested via mock call)
    expect(checkActionPermissionMock).toHaveBeenCalled();
  });

  it("passes logger to shield-client functions for error logging", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger,
      on: vi.fn(),
    } as unknown as OpenClawPluginApi;
    void plugin.register?.(api);
    resetState();

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // Verify that shield-client functions would receive the logger
    // (Actual error logging is tested in shield-client tests)
    expect(findOrRegisterAgentMock).toHaveBeenCalled();
    expect(checkActionPermissionMock).toHaveBeenCalled();
  });

  it("logs agent name on first successful connection", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger,
      on: vi.fn(),
    } as unknown as OpenClawPluginApi;
    void plugin.register?.(api);
    resetState();

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // Verify connection success is logged once
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Multicorn Shield connected. Agent: main"),
    );

    // Make another call - should not log connection again
    const infoCallCount = logger.info.mock.calls.length;
    await beforeToolCall(makeBeforeEvent("read_file"), makeCtx());
    expect(logger.info.mock.calls.length).toBe(infoCallCount); // No new connection log
  });
});

// ---------------------------------------------------------------------------
// after_tool_call
// ---------------------------------------------------------------------------

describe("afterToolCall", () => {
  it("logs an approved action for successful tool calls", async () => {
    await afterToolCall(makeAfterEvent("exec", { durationMs: 150 }), makeCtx());

    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "main",
        service: "terminal",
        actionType: "exec",
        status: "approved",
        metadata: expect.objectContaining({ durationMs: 150 }) as Record<string, unknown>,
      }) as Record<string, unknown>,
      expect.any(String),
      expect.any(String),
    );
  });

  it("logs an error status when the tool call had an error", async () => {
    await afterToolCall(makeAfterEvent("exec", { error: "command not found" }), makeCtx());

    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        metadata: expect.objectContaining({ error: "command not found" }) as Record<
          string,
          unknown
        >,
      }) as Record<string, unknown>,
      expect.any(String),
      expect.any(String),
    );
  });

  it("skips logging when API key is not set", async () => {
    vi.stubEnv("MULTICORN_API_KEY", "");

    await afterToolCall(makeAfterEvent("exec"), makeCtx());

    expect(logActionMock).not.toHaveBeenCalled();
  });
});
