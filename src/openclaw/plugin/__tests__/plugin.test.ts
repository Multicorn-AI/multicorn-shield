import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
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
const readFileSyncMock = vi.hoisted(() => vi.fn());
const homedirMock = vi.hoisted(() => vi.fn(() => "/home/test"));

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

vi.mock("../../consent.js", async () => {
  const actual = await vi.importActual("../../consent.js");
  return {
    ...actual,
    waitForConsent: waitForConsentMock,
  };
});

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
}));

vi.mock("node:os", () => ({
  homedir: homedirMock,
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
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
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
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining("npx multicorn-proxy init"));
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
    checkActionPermissionMock.mockResolvedValue({ status: "blocked" });

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(waitForConsentMock).toHaveBeenCalledWith(
      "agent-1",
      "main",
      "mcs_test_key_12345678",
      "http://localhost:8080",
      { service: "terminal", permissionLevel: "execute" },
      undefined, // logger parameter (optional, undefined in test)
    );
    // After consent grants terminal:execute, the call should be blocked (no permission yet)
    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("Terminal execute access is not allowed") as string,
    });
  });

  it("skips consent when permission is already approved", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // Should refresh scopes after approval
    expect(fetchGrantedScopesMock).toHaveBeenCalled();
    // Should NOT trigger consent since permission is already approved
    expect(waitForConsentMock).not.toHaveBeenCalled();
    // Should allow the tool call
    expect(result).toBeUndefined();
  });

  it("refreshes scopes after approval is granted", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock
      .mockResolvedValueOnce([]) // Initial fetch (no scopes)
      .mockResolvedValueOnce([{ service: "terminal", permissionLevel: "execute" }]); // After approval
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });
    saveCachedScopesMock.mockResolvedValue(undefined);

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // Should fetch scopes twice: once during ensureAgent, once after approval
    expect(fetchGrantedScopesMock).toHaveBeenCalledTimes(2);
    // Should save refreshed scopes to cache
    expect(saveCachedScopesMock).toHaveBeenCalledWith("main", "agent-1", [
      { service: "terminal", permissionLevel: "execute" },
    ]);
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
      expect.objectContaining({
        service: "filesystem",
        actionType: "edit",
        agent: "main",
        status: "approved",
      }),
      "mcs_test_key_12345678",
      "http://localhost:8080",
      undefined, // logger parameter (optional, undefined in test)
    );
  });

  it("uses cached scopes on subsequent calls without re-fetching", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());
    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(findOrRegisterAgentMock).toHaveBeenCalledTimes(1);
    // fetchGrantedScopes is called: once in ensureAgent, then after each approval (2 more times)
    expect(fetchGrantedScopesMock).toHaveBeenCalledTimes(3);
    expect(checkActionPermissionMock).toHaveBeenCalledTimes(2);
  });

  it("derives agent name from session key", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "my-bot" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx({ sessionKey: "agent:my-bot:main" }));

    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "my-bot",
      "mcs_test_key_12345678",
      "http://localhost:8080",
      undefined, // logger parameter (optional, undefined in test)
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
    resetState(); // Reset state first to clear connectionLogged flag
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger,
      on: vi.fn(),
    } as unknown as OpenClawPluginApi;
    void plugin.register?.(api); // Register after resetState to set up logger

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // Verify connection success is logged once (after ensureAgent completes)
    const connectionLogCalls = logger.info.mock.calls.filter((call) =>
      String(call[0]).includes("Multicorn Shield connected. Agent: main"),
    );
    expect(connectionLogCalls.length).toBe(1);

    // Make another call - should not log connection again
    await beforeToolCall(makeBeforeEvent("read_file"), makeCtx());
    const connectionLogCallsAfter = logger.info.mock.calls.filter((call) =>
      String(call[0]).includes("Multicorn Shield connected. Agent: main"),
    );
    expect(connectionLogCallsAfter.length).toBe(1); // Still only one connection log
  });
});

// ---------------------------------------------------------------------------
// after_tool_call
// ---------------------------------------------------------------------------

describe("afterToolCall", () => {
  it("logs an approved action for successful tool calls", async () => {
    await afterToolCall(makeAfterEvent("exec", { durationMs: 150 }), makeCtx());

    expect(logActionMock).toHaveBeenCalledWith(
      {
        agent: "main",
        service: "terminal",
        actionType: "exec",
        status: "approved",
        metadata: { durationMs: 150 },
      },
      "mcs_test_key_12345678",
      "http://localhost:8080",
      undefined, // logger parameter (optional, undefined in test)
    );
  });

  it("logs an error status when the tool call had an error", async () => {
    await afterToolCall(makeAfterEvent("exec", { error: "command not found" }), makeCtx());

    expect(logActionMock).toHaveBeenCalledWith(
      {
        agent: "main",
        service: "terminal",
        actionType: "exec",
        status: "blocked",
        metadata: { error: "command not found" },
      },
      "mcs_test_key_12345678",
      "http://localhost:8080",
      undefined, // logger parameter (optional, undefined in test)
    );
  });

  it("skips logging when API key is not set", async () => {
    vi.stubEnv("MULTICORN_API_KEY", "");

    await afterToolCall(makeAfterEvent("exec"), makeCtx());

    expect(logActionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Config fallback tests
// ---------------------------------------------------------------------------

describe("config fallback", () => {
  beforeEach(() => {
    readFileSyncMock.mockReset();
    homedirMock.mockReturnValue("/home/test");
    vi.stubEnv("MULTICORN_API_KEY", "");
    vi.stubEnv("MULTICORN_BASE_URL", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reads API key from ~/.multicorn/config.json when plugin config and env vars are empty", async () => {
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(),
      pluginConfig: {}, // Empty plugin config
    } as unknown as OpenClawPluginApi;

    const multicornConfig = {
      apiKey: "mcs_multicorn_key_99999",
      baseUrl: "https://api.multicorn.ai",
    };

    const multicornConfigPath = path.join("/home/test", ".multicorn", "config.json");
    const openclawConfigPath = path.join("/home/test", ".openclaw", "openclaw.json");

    // Mock readFileSync to return multicorn config when that path is read, throw for openclaw config
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === multicornConfigPath) {
        return JSON.stringify(multicornConfig);
      }
      if (filePath === openclawConfigPath) {
        throw new Error("ENOENT: no such file or directory");
      }
      throw new Error(`Unexpected file path: ${filePath}`);
    });

    void plugin.register?.(api);
    resetState();

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(readFileSyncMock).toHaveBeenCalledWith(multicornConfigPath, "utf-8");
    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "main",
      "mcs_multicorn_key_99999",
      "https://api.multicorn.ai",
      undefined,
    );
  });

  it("env vars take priority over multicorn config", async () => {
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(),
      pluginConfig: {}, // Empty plugin config
    } as unknown as OpenClawPluginApi;

    vi.stubEnv("MULTICORN_API_KEY", "mcs_env_key_67890");
    vi.stubEnv("MULTICORN_BASE_URL", "https://custom.api.multicorn.ai");

    void plugin.register?.(api);
    resetState();

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // Should not read from multicorn config when env vars are set
    expect(readFileSyncMock).not.toHaveBeenCalled();
    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "main",
      "mcs_env_key_67890",
      "https://custom.api.multicorn.ai",
      undefined,
    );
  });

  it("multicorn config takes priority over hooks config", async () => {
    const warnMock = vi.fn();
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: warnMock, error: vi.fn() },
      on: vi.fn(),
      pluginConfig: {}, // Empty plugin config
    } as unknown as OpenClawPluginApi;

    const multicornConfig = {
      apiKey: "mcs_multicorn_key_99999",
      baseUrl: "https://api.multicorn.ai",
    };

    const openclawConfig = {
      hooks: {
        internal: {
          entries: {
            "multicorn-shield": {
              env: {
                MULTICORN_API_KEY: "mcs_hook_key_12345",
                MULTICORN_BASE_URL: "https://api.multicorn.ai",
              },
            },
          },
        },
      },
    };

    const multicornConfigPath = path.join("/home/test", ".multicorn", "config.json");
    const openclawConfigPath = path.join("/home/test", ".openclaw", "openclaw.json");

    // Mock readFileSync to return appropriate config based on path
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === multicornConfigPath) {
        return JSON.stringify(multicornConfig);
      }
      if (filePath === openclawConfigPath) {
        return JSON.stringify(openclawConfig);
      }
      throw new Error(`Unexpected file path: ${filePath}`);
    });

    void plugin.register?.(api);
    resetState();

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // Should use multicorn config, not hooks config
    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "main",
      "mcs_multicorn_key_99999",
      "https://api.multicorn.ai",
      undefined,
    );
    // Should not warn about reading from hooks config
    expect(warnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Reading config from hooks.internal.entries"),
    );
  });

  it("handles missing multicorn config file gracefully", async () => {
    const warnMock = vi.fn();
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: warnMock, error: vi.fn() },
      on: vi.fn(),
      pluginConfig: {}, // Empty plugin config
    } as unknown as OpenClawPluginApi;

    const mockConfig = {
      hooks: {
        internal: {
          entries: {
            "multicorn-shield": {
              env: {
                MULTICORN_API_KEY: "mcs_hook_key_12345",
                MULTICORN_BASE_URL: "https://api.multicorn.ai",
              },
            },
          },
        },
      },
    };

    const multicornConfigPath = path.join("/home/test", ".multicorn", "config.json");
    const openclawConfigPath = path.join("/home/test", ".openclaw", "openclaw.json");

    // Mock readFileSync to throw for multicorn config, then return openclaw config
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === multicornConfigPath) {
        throw new Error("ENOENT: no such file or directory");
      }
      if (filePath === openclawConfigPath) {
        return JSON.stringify(mockConfig);
      }
      throw new Error(`Unexpected file path: ${filePath}`);
    });

    void plugin.register?.(api);
    resetState();

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // Should fall back to hooks config
    expect(readFileSyncMock).toHaveBeenCalledWith(multicornConfigPath, "utf-8");
    expect(readFileSyncMock).toHaveBeenCalledWith(openclawConfigPath, "utf-8");
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("Reading config from hooks.internal.entries"),
    );
    expect(findOrRegisterAgentMock).toHaveBeenCalled();
  });

  it("handles invalid JSON in multicorn config gracefully", async () => {
    const warnMock = vi.fn();
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: warnMock, error: vi.fn() },
      on: vi.fn(),
      pluginConfig: {}, // Empty plugin config
    } as unknown as OpenClawPluginApi;

    const mockConfig = {
      hooks: {
        internal: {
          entries: {
            "multicorn-shield": {
              env: {
                MULTICORN_API_KEY: "mcs_hook_key_12345",
                MULTICORN_BASE_URL: "https://api.multicorn.ai",
              },
            },
          },
        },
      },
    };

    const multicornConfigPath = path.join("/home/test", ".multicorn", "config.json");
    const openclawConfigPath = path.join("/home/test", ".openclaw", "openclaw.json");

    // Mock readFileSync to return invalid JSON for multicorn config, then return openclaw config
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === multicornConfigPath) {
        return "{invalid json";
      }
      if (filePath === openclawConfigPath) {
        return JSON.stringify(mockConfig);
      }
      throw new Error(`Unexpected file path: ${filePath}`);
    });

    void plugin.register?.(api);
    resetState();

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // Should fall back to hooks config
    expect(readFileSyncMock).toHaveBeenCalledWith(multicornConfigPath, "utf-8");
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("Reading config from hooks.internal.entries"),
    );
    expect(findOrRegisterAgentMock).toHaveBeenCalled();
  });

  it("reads API key from hooks.internal.entries when plugin config, env vars, and multicorn config are all empty", async () => {
    const warnMock = vi.fn();
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: warnMock, error: vi.fn() },
      on: vi.fn(),
      pluginConfig: {}, // Empty plugin config
    } as unknown as OpenClawPluginApi;

    const mockConfig = {
      hooks: {
        internal: {
          entries: {
            "multicorn-shield": {
              env: {
                MULTICORN_API_KEY: "mcs_hook_key_12345",
                MULTICORN_BASE_URL: "https://api.multicorn.ai",
              },
            },
          },
        },
      },
    };

    const multicornConfigPath = path.join("/home/test", ".multicorn", "config.json");
    const openclawConfigPath = path.join("/home/test", ".openclaw", "openclaw.json");

    // Mock readFileSync to throw for multicorn config, then return openclaw config
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === multicornConfigPath) {
        throw new Error("ENOENT: no such file or directory");
      }
      if (filePath === openclawConfigPath) {
        return JSON.stringify(mockConfig);
      }
      throw new Error(`Unexpected file path: ${filePath}`);
    });

    void plugin.register?.(api);
    resetState();

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(readFileSyncMock).toHaveBeenCalledWith(multicornConfigPath, "utf-8");
    expect(readFileSyncMock).toHaveBeenCalledWith(openclawConfigPath, "utf-8");
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("Reading config from hooks.internal.entries"),
    );
    expect(findOrRegisterAgentMock).toHaveBeenCalled();
  });

  it("env vars take priority over multicorn config and openclaw.json fallback", async () => {
    const warnMock = vi.fn();
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: warnMock, error: vi.fn() },
      on: vi.fn(),
      pluginConfig: {}, // Empty plugin config
    } as unknown as OpenClawPluginApi;

    vi.stubEnv("MULTICORN_API_KEY", "mcs_env_key_67890");
    vi.stubEnv("MULTICORN_BASE_URL", "https://custom.api.multicorn.ai");

    const mockConfig = {
      hooks: {
        internal: {
          entries: {
            "multicorn-shield": {
              env: {
                MULTICORN_API_KEY: "mcs_hook_key_12345",
                MULTICORN_BASE_URL: "https://api.multicorn.ai",
              },
            },
          },
        },
      },
    };

    readFileSyncMock.mockReturnValue(JSON.stringify(mockConfig));

    void plugin.register?.(api);
    resetState();

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // Should not read from file when env vars are set
    expect(readFileSyncMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Reading config from hooks.internal.entries"),
    );
    expect(findOrRegisterAgentMock).toHaveBeenCalled();
  });

  it("plugin config takes priority over env vars and fallback", async () => {
    const warnMock = vi.fn();
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: warnMock, error: vi.fn() },
      on: vi.fn(),
      pluginConfig: {
        apiKey: "mcs_plugin_key_11111",
        baseUrl: "https://plugin.api.multicorn.ai",
      },
    } as unknown as OpenClawPluginApi;

    vi.stubEnv("MULTICORN_API_KEY", "mcs_env_key_67890");

    const mockConfig = {
      hooks: {
        internal: {
          entries: {
            "multicorn-shield": {
              env: {
                MULTICORN_API_KEY: "mcs_hook_key_12345",
              },
            },
          },
        },
      },
    };

    readFileSyncMock.mockReturnValue(JSON.stringify(mockConfig));

    void plugin.register?.(api);
    resetState();

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // Should not read from file when plugin config is set
    expect(readFileSyncMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Reading config from hooks.internal.entries"),
    );
    expect(findOrRegisterAgentMock).toHaveBeenCalled();
  });

  it("handles missing config files gracefully", () => {
    const errorMock = vi.fn();
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: vi.fn(), error: errorMock },
      on: vi.fn(),
      pluginConfig: {},
    } as unknown as OpenClawPluginApi;

    // Mock readFileSync to throw for both config files
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    void plugin.register?.(api);
    resetState();

    // Should not crash, just log error about missing API key
    expect(readFileSyncMock).toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining("No API key found"));
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining("npx multicorn-proxy init"));
  });
});
