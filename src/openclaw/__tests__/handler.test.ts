import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import type { OpenClawEvent } from "../types.js";
import { handler, resolveAgentName, resetState } from "../hook/handler.js";

// Mock all external dependencies so handler tests are isolated

const findOrRegisterAgentMock = vi.hoisted(() => vi.fn());
const fetchGrantedScopesMock = vi.hoisted(() => vi.fn());
const logActionMock = vi.hoisted(() => vi.fn());
const loadCachedScopesMock = vi.hoisted(() => vi.fn());
const saveCachedScopesMock = vi.hoisted(() => vi.fn());
const waitForConsentMock = vi.hoisted(() => vi.fn());

vi.mock("../shield-client.js", () => ({
  findOrRegisterAgent: findOrRegisterAgentMock,
  fetchGrantedScopes: fetchGrantedScopesMock,
  logAction: logActionMock,
}));

vi.mock("../scope-cache.js", () => ({
  loadCachedScopes: loadCachedScopesMock,
  saveCachedScopes: saveCachedScopesMock,
}));

vi.mock("../consent.js", () => ({
  waitForConsent: waitForConsentMock,
}));

let stderrSpy: MockInstance;

function createToolCallEvent(toolName: string, args: Record<string, unknown> = {}): OpenClawEvent {
  return {
    type: "agent",
    action: "tool_call",
    sessionKey: "agent:main:main",
    timestamp: new Date(),
    messages: [],
    context: {
      toolName,
      toolArguments: args,
    },
  };
}

function createNonToolEvent(): OpenClawEvent {
  return {
    type: "command",
    action: "new",
    sessionKey: "agent:main:main",
    timestamp: new Date(),
    messages: [],
    context: {},
  };
}

beforeEach(() => {
  resetState();

  findOrRegisterAgentMock.mockReset();
  fetchGrantedScopesMock.mockReset();
  logActionMock.mockReset().mockResolvedValue(undefined);
  loadCachedScopesMock.mockReset().mockResolvedValue(null);
  saveCachedScopesMock.mockReset().mockResolvedValue(undefined);
  waitForConsentMock.mockReset();
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  vi.stubEnv("MULTICORN_API_KEY", "mcs_test_key_12345678");
  vi.stubEnv("MULTICORN_BASE_URL", "http://localhost:8080");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("handler", () => {
  it("ignores non-tool-call events", async () => {
    const event = createNonToolEvent();

    await handler(event);

    expect(findOrRegisterAgentMock).not.toHaveBeenCalled();
    expect(event.messages).toHaveLength(0);
  });

  it("skips permission checks when API key is not set", async () => {
    vi.stubEnv("MULTICORN_API_KEY", "");
    const event = createToolCallEvent("exec");

    await handler(event);

    expect(findOrRegisterAgentMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("MULTICORN_API_KEY is not set"));
  });

  it("allows a tool call when the scope is granted", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);

    const event = createToolCallEvent("exec", { command: "ls" });
    await handler(event);

    expect(event.messages).toHaveLength(0);
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "main",
        service: "terminal",
        actionType: "exec",
        status: "approved",
      }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("blocks a tool call when the scope is not granted", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "filesystem", permissionLevel: "read" }]);

    const event = createToolCallEvent("exec", { command: "rm -rf /" });
    await handler(event);

    expect(event.messages).toHaveLength(1);
    expect(event.messages[0]).toContain("Permission denied");
    expect(event.messages[0]).toContain("Terminal");
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        service: "terminal",
      }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("triggers consent flow when no scopes are granted", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([]);
    waitForConsentMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);

    const event = createToolCallEvent("exec");
    await handler(event);

    expect(waitForConsentMock).toHaveBeenCalledWith(
      "agent-1",
      "main",
      expect.any(String),
      expect.any(String),
    );
    expect(event.messages).toHaveLength(0);
  });

  it("uses cached scopes on subsequent calls without re-fetching", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);

    const event1 = createToolCallEvent("exec");
    await handler(event1);

    const event2 = createToolCallEvent("exec");
    await handler(event2);

    // findOrRegisterAgent is only called once
    expect(findOrRegisterAgentMock).toHaveBeenCalledTimes(1);
    // fetchGrantedScopes is only called once (within refresh interval)
    expect(fetchGrantedScopesMock).toHaveBeenCalledTimes(1);
  });

  it("blocks in fail-closed mode when the API is unreachable", async () => {
    vi.stubEnv("MULTICORN_FAIL_MODE", "closed");
    resetState();

    findOrRegisterAgentMock.mockResolvedValue(null);
    loadCachedScopesMock.mockResolvedValue(null);

    const event = createToolCallEvent("exec");
    await handler(event);

    expect(event.messages).toHaveLength(1);
    expect(event.messages[0]).toContain("Permission denied");
    expect(event.messages[0]).toContain("fail-closed");
  });

  it("proceeds in fail-open mode when the API is unreachable", async () => {
    vi.stubEnv("MULTICORN_FAIL_MODE", "open");
    resetState();

    findOrRegisterAgentMock.mockResolvedValue(null);
    loadCachedScopesMock.mockResolvedValue(null);

    const event = createToolCallEvent("exec");
    await handler(event);

    expect(event.messages).toHaveLength(0);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Could not reach Shield API"));
  });

  it("loads from scope cache when API is unreachable", async () => {
    loadCachedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    findOrRegisterAgentMock.mockResolvedValue(null);

    const event = createToolCallEvent("exec");
    await handler(event);

    expect(event.messages).toHaveLength(0);
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved" }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("maps filesystem tool names correctly", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "filesystem", permissionLevel: "write" }]);

    const event = createToolCallEvent("edit", { file: "test.txt" });
    await handler(event);

    expect(event.messages).toHaveLength(0);
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: "filesystem", actionType: "edit" }),
      expect.any(String),
      expect.any(String),
    );
  });
});

describe("resolveAgentName", () => {
  it("extracts the agent name from the session key", () => {
    expect(resolveAgentName("agent:my-bot:main", null)).toBe("my-bot");
  });

  it("uses the env override when provided", () => {
    expect(resolveAgentName("agent:main:main", "custom-name")).toBe("custom-name");
  });

  it("falls back to 'openclaw' for unparseable session keys", () => {
    expect(resolveAgentName("no-colons", null)).toBe("openclaw");
  });

  it("falls back to 'openclaw' for empty session key segments", () => {
    expect(resolveAgentName("agent::main", null)).toBe("openclaw");
  });

  it("trims whitespace from the env override", () => {
    expect(resolveAgentName("agent:main:main", "  my-bot  ")).toBe("my-bot");
  });

  it("ignores empty env override and uses session key", () => {
    expect(resolveAgentName("agent:my-bot:main", "")).toBe("my-bot");
  });
});
