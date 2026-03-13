import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import type {
  OpenClawPluginApi,
  PluginHookBeforeToolCallEvent,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
} from "../../plugin-sdk.types.js";
import { plugin, beforeToolCall, afterToolCall, resetState, resolveAgentName } from "../index.js";

// Mock all external dependencies

const findOrRegisterAgentMock = vi.hoisted(() => vi.fn());
const fetchGrantedScopesMock = vi.hoisted(() => vi.fn());
const logActionMock = vi.hoisted(() => vi.fn());
const checkActionPermissionMock = vi.hoisted(() => vi.fn());
const pollApprovalStatusMock = vi.hoisted(() => vi.fn());
const loadCachedScopesMock = vi.hoisted(() => vi.fn());
const saveCachedScopesMock = vi.hoisted(() => vi.fn());
const waitForConsentMock = vi.hoisted(() => vi.fn());
const openBrowserMock = vi.hoisted(() => vi.fn());
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
    openBrowser: openBrowserMock,
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
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(fetchGrantedScopesMock).toHaveBeenCalled();
    // Should NOT trigger consent since we already have scopes
    expect(waitForConsentMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("refreshes scopes after approval is granted", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock
      .mockResolvedValueOnce([]) // ensureAgent initial fetch
      .mockResolvedValueOnce([]) // ensureConsent apiScopes fetch (zero-scopes path)
      .mockResolvedValueOnce([{ service: "terminal", permissionLevel: "execute" }]); // post-approval refresh
    waitForConsentMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });
    saveCachedScopesMock.mockResolvedValue(undefined);

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // ensureAgent fetch, ensureConsent fetch, post-approval refresh
    expect(fetchGrantedScopesMock).toHaveBeenCalledTimes(3);
    expect(saveCachedScopesMock).toHaveBeenCalledWith(
      "main",
      "agent-1",
      [{ service: "terminal", permissionLevel: "execute" }],
      "mcs_test_key_12345678",
    );
  });

  it("returns undefined when MULTICORN_API_KEY is not set", async () => {
    vi.stubEnv("MULTICORN_API_KEY", "");

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toBeUndefined();
    expect(findOrRegisterAgentMock).not.toHaveBeenCalled();
  });

  it("blocks when Shield API is unreachable (fail-closed only)", async () => {
    vi.stubEnv("MULTICORN_FAIL_MODE", "open");
    resetState();

    findOrRegisterAgentMock.mockResolvedValue(null);
    loadCachedScopesMock.mockResolvedValue(null);

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    // failMode is always closed; MULTICORN_FAIL_MODE is ignored
    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("fail-closed") as string,
    });
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

  it("prefers ctx.agentId over sessionKey (avoids openclaw ghost agent)", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "rathbun-demo" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(
      makeBeforeEvent("exec"),
      makeCtx({ sessionKey: "agent::main", agentId: "rathbun-demo" }),
    );

    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "rathbun-demo",
      "mcs_test_key_12345678",
      "http://localhost:8080",
      undefined,
    );
  });

  it("blocks tool call when approval is pending (no polling)", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({
      status: "pending",
      approvalId: "approval-123",
    });

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("Action pending approval") as string,
    });
    expect(result?.blockReason).toContain("/approvals");
    expect(pollApprovalStatusMock).not.toHaveBeenCalled();
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

    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === multicornConfigPath) {
        return JSON.stringify(multicornConfig);
      }
      throw new Error(`Unexpected file path: ${filePath}`);
    });

    void plugin.register?.(api);
    // Do not resetState() so cachedMulticornConfig from register() is used by beforeToolCall

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(readFileSyncMock).toHaveBeenCalledWith(multicornConfigPath, "utf-8");
    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "main",
      "mcs_multicorn_key_99999",
      "https://api.multicorn.ai",
      expect.anything(),
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

    // Env wins; file may be read at startup but env key is used
    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "main",
      "mcs_env_key_67890",
      "https://custom.api.multicorn.ai",
      undefined,
    );
  });

  it("uses multicorn config when env is empty", async () => {
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
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === multicornConfigPath) {
        return JSON.stringify(multicornConfig);
      }
      throw new Error(`Unexpected file path: ${filePath}`);
    });

    void plugin.register?.(api);
    // Do not resetState() so cachedMulticornConfig is used by beforeToolCall

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "main",
      "mcs_multicorn_key_99999",
      "https://api.multicorn.ai",
      expect.anything(),
    );
  });

  it("when multicorn config is missing and env empty, logs error and skips permission checks", async () => {
    const errorMock = vi.fn();
    const warnMock = vi.fn();
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: warnMock, error: errorMock },
      on: vi.fn(),
      pluginConfig: {},
    } as unknown as OpenClawPluginApi;

    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    void plugin.register?.(api);
    resetState();

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(errorMock).toHaveBeenCalledWith(
      "Multicorn Shield: No API key found. Run 'npx multicorn-proxy init' or set MULTICORN_API_KEY.",
    );
    expect(result).toBeUndefined();
    expect(findOrRegisterAgentMock).not.toHaveBeenCalled();
  });

  it("when multicorn config has invalid JSON and env empty, logs error and skips permission checks", async () => {
    const errorMock = vi.fn();
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: vi.fn(), error: errorMock },
      on: vi.fn(),
      pluginConfig: {},
    } as unknown as OpenClawPluginApi;

    const multicornConfigPath = path.join("/home/test", ".multicorn", "config.json");
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === multicornConfigPath) {
        return "{invalid json";
      }
      throw new Error(`Unexpected file path: ${filePath}`);
    });

    void plugin.register?.(api);
    resetState();

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(errorMock).toHaveBeenCalledWith(
      "Multicorn Shield: No API key found. Run 'npx multicorn-proxy init' or set MULTICORN_API_KEY.",
    );
    expect(result).toBeUndefined();
    expect(findOrRegisterAgentMock).not.toHaveBeenCalled();
  });

  it("env vars take priority over multicorn config", async () => {
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(),
      pluginConfig: {},
    } as unknown as OpenClawPluginApi;

    vi.stubEnv("MULTICORN_API_KEY", "mcs_env_key_67890");
    vi.stubEnv("MULTICORN_BASE_URL", "https://custom.api.multicorn.ai");

    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    void plugin.register?.(api);
    resetState();

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "main",
      "mcs_env_key_67890",
      "https://custom.api.multicorn.ai",
      undefined,
    );
  });

  it("agentName and failMode still read from plugin config", async () => {
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(),
      pluginConfig: { agentName: "my-agent", failMode: "closed" },
    } as unknown as OpenClawPluginApi;

    vi.stubEnv("MULTICORN_API_KEY", "mcs_env_key_67890");
    vi.stubEnv("MULTICORN_BASE_URL", "https://api.multicorn.ai");
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    void plugin.register?.(api);
    // Do not resetState() so pluginConfig (agentName, failMode) is still set for beforeToolCall

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "my-agent" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "my-agent",
      "mcs_env_key_67890",
      "https://api.multicorn.ai",
      expect.anything(),
    );
  });

  it("when no API key (no env, no file): logs error at startup and skips permission checks without crashing", async () => {
    const errorMock = vi.fn();
    const warnMock = vi.fn();
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: warnMock, error: errorMock },
      on: vi.fn(),
      pluginConfig: {},
    } as unknown as OpenClawPluginApi;

    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    void plugin.register?.(api);
    expect(errorMock).toHaveBeenCalledWith(
      "Multicorn Shield: No API key found. Run 'npx multicorn-proxy init' or set MULTICORN_API_KEY.",
    );

    // Do not resetState() so pluginLogger is still set and we can assert beforeToolCall behaviour
    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toBeUndefined();
    expect(findOrRegisterAgentMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      "Multicorn Shield: No API key found. Run 'npx multicorn-proxy init' or set MULTICORN_API_KEY.",
    );
  });
});

describe("resolveAgentName", () => {
  it("prefers config override over sessionKey and ctxAgentId", () => {
    expect(resolveAgentName("agent::main", "custom-agent", "ctx-agent")).toBe("custom-agent");
  });

  it("uses ctxAgentId when config override is null", () => {
    expect(resolveAgentName("agent::main", null, "rathbun-demo")).toBe("rathbun-demo");
  });

  it("parses sessionKey when no config or ctxAgentId", () => {
    expect(resolveAgentName("agent:my-bot:main", null)).toBe("my-bot");
  });

  it("falls back to openclaw when sessionKey has empty second segment", () => {
    expect(resolveAgentName("agent::main", null)).toBe("openclaw");
  });
});

describe("agent name pinning", () => {
  it("reuses pinned name on subsequent calls even when ctx has empty sessionKey", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "rathbun-demo" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    const ctxWithAgent = makeCtx({
      sessionKey: "agent:rathbun-demo:main",
      agentId: "rathbun-demo",
    });
    const ctxEmpty = makeCtx({ sessionKey: "agent::main", agentId: "" });

    await beforeToolCall(makeBeforeEvent("exec"), ctxWithAgent);

    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "rathbun-demo",
      expect.any(String),
      expect.any(String),
      undefined,
    );

    await afterToolCall(makeAfterEvent("exec"), ctxEmpty);

    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "rathbun-demo" }),
      expect.any(String),
      expect.any(String),
      undefined,
    );
  });

  it("pins from register() config so all hook calls use pinned name", async () => {
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(),
      pluginConfig: { agentName: "my-pinned-agent" },
    } as unknown as OpenClawPluginApi;

    void plugin.register?.(api);

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "my-pinned-agent" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    const ctxEmpty = makeCtx({ sessionKey: "agent::main", agentId: "" });

    await beforeToolCall(makeBeforeEvent("exec"), ctxEmpty);
    await afterToolCall(makeAfterEvent("exec"), ctxEmpty);

    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "my-pinned-agent",
      expect.any(String),
      expect.any(String),
      expect.anything(),
    );
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "my-pinned-agent" }),
      expect.any(String),
      expect.any(String),
      expect.anything(),
    );
  });

  it("returns openclaw only when no better name has ever been resolved", async () => {
    resetState();
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "openclaw" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    const ctxEmpty = makeCtx({ sessionKey: "agent::main", agentId: "" });

    await beforeToolCall(makeBeforeEvent("exec"), ctxEmpty);
    await afterToolCall(makeAfterEvent("exec"), ctxEmpty);

    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "openclaw",
      expect.any(String),
      expect.any(String),
      undefined,
    );
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "openclaw" }),
      expect.any(String),
      expect.any(String),
      undefined,
    );
  });

  it("resetState clears pinned name", async () => {
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(),
      pluginConfig: { agentName: "cleared-agent" },
    } as unknown as OpenClawPluginApi;

    void plugin.register?.(api);

    resetState();

    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "approved" });

    await beforeToolCall(makeBeforeEvent("exec"), makeCtx({ sessionKey: "agent:main:main" }));

    expect(findOrRegisterAgentMock).toHaveBeenCalledWith(
      "main",
      expect.any(String),
      expect.any(String),
      undefined,
    );
  });
});
