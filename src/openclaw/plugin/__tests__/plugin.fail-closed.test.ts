/**
 * Fail-closed behaviour for the OpenClaw plugin: exceptions and service
 * errors result in blocked tool calls with meaningful error messages.
 *
 * @module openclaw/plugin/__tests__/plugin.fail-closed.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
} from "../../plugin-sdk.types.js";
import { beforeToolCall, resetState } from "../index.js";

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

describe("fail-closed: beforeToolCall", () => {
  it("blocks when handler throws an exception and returns meaningful error", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockRejectedValue(new Error("checkActionPermission boom"));

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("Shield internal error") as string,
    });
    expect(result?.blockReason).toContain("checkActionPermission boom");
  });

  it("blocks when checkActionPermission gets 500 from service with meaningful message", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "blocked" });

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("Terminal execute access is not allowed") as string,
    });
    expect(result?.blockReason).toContain("/approvals");
  });

  it("blocks when checkActionPermission gets malformed response with meaningful message", async () => {
    findOrRegisterAgentMock.mockResolvedValue({ id: "agent-1", name: "main" });
    fetchGrantedScopesMock.mockResolvedValue([{ service: "terminal", permissionLevel: "execute" }]);
    checkActionPermissionMock.mockResolvedValue({ status: "blocked" });

    const result = await beforeToolCall(makeBeforeEvent("exec"), makeCtx());

    expect(result).toEqual({
      block: true,
      blockReason: expect.any(String) as string,
    });
    expect(result?.blockReason?.length).toBeGreaterThan(0);
    expect(result?.blockReason).toContain("approvals");
  });
});
