/**
 * @vitest-environment node
 */

import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { ShieldExtensionRuntime } from "../runtime.js";
import { createLogger } from "../../proxy/logger.js";
import { deriveDashboardUrl } from "../../proxy/consent.js";

const resolveAgentRecordMock = vi.hoisted(() => vi.fn());
const openBrowserMock = vi.hoisted(() => vi.fn());

vi.mock("../../proxy/consent.js", async (importOriginal) => {
  const mod: Record<string, unknown> = await importOriginal();
  return {
    ...mod,
    resolveAgentRecord: resolveAgentRecordMock,
    openBrowser: openBrowserMock,
  };
});

describe("Shield extension runtime (hosted-proxy mode)", () => {
  let runtime: ShieldExtensionRuntime | undefined;

  beforeEach(() => {
    resolveAgentRecordMock.mockReset();
    openBrowserMock.mockReset();
  });

  afterEach(async () => {
    const rt = runtime;
    runtime = undefined;
    if (rt !== undefined) {
      await rt.stop();
    }
  });

  it("resolves and stores agent id on start", async () => {
    resolveAgentRecordMock.mockResolvedValue({
      id: "agent-42",
      name: "test-agent",
      scopes: [],
    });

    runtime = new ShieldExtensionRuntime({
      apiKey: "test-key",
      agentName: "test-agent",
      baseUrl: "https://api.example.com",
      dashboardUrl: "https://app.example.com",
      logger: createLogger("error"),
    });

    await runtime.start();

    expect(runtime.getAgentId()).toBe("agent-42");
    expect(runtime.isAuthInvalid()).toBe(false);
  });

  it("does not open consent when API key is invalid", async () => {
    resolveAgentRecordMock.mockResolvedValue({
      id: "",
      name: "test-agent",
      scopes: [],
      authInvalid: true,
    });

    runtime = new ShieldExtensionRuntime({
      apiKey: "bad",
      agentName: "test-agent",
      baseUrl: "https://api.example.com",
      dashboardUrl: deriveDashboardUrl("https://api.example.com"),
      logger: createLogger("error"),
    });

    await runtime.start();
    runtime.openConsentBrowserOnce();
    runtime.openConsentBrowserOnce();

    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  it("throws when base URL is not HTTPS or localhost", async () => {
    resolveAgentRecordMock.mockResolvedValue({ id: "x", name: "a", scopes: [] });

    runtime = new ShieldExtensionRuntime({
      apiKey: "k",
      agentName: "a",
      baseUrl: "http://evil.example/api",
      dashboardUrl: "https://app.example.com",
      logger: createLogger("error"),
    });

    await expect(runtime.start()).rejects.toThrow(/Base URL must use HTTPS/);
  });

  it("does not open consent when agent name is empty", async () => {
    resolveAgentRecordMock.mockResolvedValue({ id: "id", name: "", scopes: [] });

    runtime = new ShieldExtensionRuntime({
      apiKey: "k",
      agentName: "   ",
      baseUrl: "https://api.example.com",
      dashboardUrl: "https://app.example.com",
      logger: createLogger("error"),
    });

    await runtime.start();
    runtime.openConsentBrowserOnce();

    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  it("opens consent URL at most once per runtime instance", async () => {
    resolveAgentRecordMock.mockResolvedValue({
      id: "agent-99",
      name: "claude-desktop-shield",
      scopes: [],
    });

    runtime = new ShieldExtensionRuntime({
      apiKey: "test-key",
      agentName: "claude-desktop-shield",
      baseUrl: "https://api.example.com",
      dashboardUrl: "https://app.example.com",
      logger: createLogger("error"),
    });

    await runtime.start();
    runtime.openConsentBrowserOnce();
    runtime.openConsentBrowserOnce();

    expect(openBrowserMock).toHaveBeenCalledTimes(1);
    const argv0: unknown = openBrowserMock.mock.calls[0]?.[0];
    expect(typeof argv0).toBe("string");
    if (typeof argv0 !== "string") {
      throw new Error("expected consent URL string");
    }
    expect(argv0).toContain("/consent");
    expect(argv0).toContain("claude-desktop-shield");
  });
});
