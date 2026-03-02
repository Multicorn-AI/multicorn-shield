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
    const api = {
      id: "multicorn-shield",
      name: "Multicorn Shield",
      source: "test",
      logger: { info: infoMock, warn: vi.fn(), error: vi.fn() },
      on: vi.fn(),
    } as unknown as OpenClawPluginApi;

    void plugin.register?.(api);

    expect(infoMock).toHaveBeenCalledWith("Multicorn Shield plugin registered.");
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
