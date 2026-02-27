/**
 * Blocking and permission integration tests for the MCP proxy.
 *
 * Verifies:
 * 1. Blocked tool calls return a structured JSON-RPC error without reaching the MCP server
 * 2. Blocked calls are logged to the Multicorn service with status "blocked"
 * 3. Spending limit enforcement blocks tool calls that exceed limits
 * 4. Scope revocation mid-session causes subsequent calls for that scope to be blocked
 * 5. Block error messages include the dashboard URL for user remediation
 *
 * @vitest-environment node
 * @module proxy/__tests__/proxy.blocking.test
 */

import { PassThrough } from "node:stream";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createProxyServer, type ProxyServer } from "../index.js";
import { createLogger } from "../logger.js";
import { deriveDashboardUrl } from "../consent.js";
import { startMockMcpServer } from "../__fixtures__/mockMcpServer.js";
import {
  startMockMulticornService,
  type MockMulticornService,
  type MockServiceConfig,
} from "../__fixtures__/mockMulticornService.js";
import type { SpendingLimits } from "../../spending/spending-checker.js";

const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mkdirMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("node:fs/promises", () => {
  const exports = {
    readFile: readFileMock,
    writeFile: writeFileMock,
    mkdir: mkdirMock,
  };
  return { default: exports, ...exports };
});

function waitFor(predicate: () => boolean, timeout = 5000, interval = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check(): void {
      if (predicate()) {
        resolve();
      } else if (Date.now() - start > timeout) {
        reject(new Error("waitFor timed out"));
      } else {
        setTimeout(check, interval);
      }
    }
    check();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("proxy blocking", () => {
  let mockService: MockMulticornService;
  let fakeStdin: PassThrough;
  let stdoutBuffer: string;
  let proxy: ProxyServer;
  let startPromise: Promise<void>;
  let expectedDashboardUrl: string;
  const originalStdin = process.stdin;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  interface ProxySetupOptions {
    serviceConfig?: MockServiceConfig;
    spendingLimits?: SpendingLimits;
    scopeRefreshIntervalMs?: number;
  }

  async function setupProxy(options: ProxySetupOptions = {}): Promise<void> {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);

    mockService = await startMockMulticornService(options.serviceConfig);
    const baseUrl = mockService.baseUrl.replace("127.0.0.1", "localhost");
    expectedDashboardUrl = deriveDashboardUrl(baseUrl);

    const mockServer = startMockMcpServer();
    const mcpCommand = mockServer.command;
    const mcpArgs = [...mockServer.args];
    await mockServer.stop();

    fakeStdin = new PassThrough();
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
      writable: true,
    });

    stdoutBuffer = "";
    process.stdout.write = ((
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
      cb?: (error?: Error | null) => void,
    ): boolean => {
      stdoutBuffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (callback !== undefined) callback(null);
      return true;
    }) as typeof process.stdout.write;

    proxy = createProxyServer({
      command: mcpCommand,
      commandArgs: mcpArgs,
      apiKey: "test-key",
      agentName: "test-agent",
      baseUrl,
      dashboardUrl: deriveDashboardUrl(baseUrl),
      logger: createLogger("error"),
      ...(options.spendingLimits !== undefined && { spendingLimits: options.spendingLimits }),
      ...(options.scopeRefreshIntervalMs !== undefined && {
        scopeRefreshIntervalMs: options.scopeRefreshIntervalMs,
      }),
    });

    startPromise = proxy.start();

    const hasNoAgents = options.serviceConfig?.agents?.length === 0;
    const readyThreshold = hasNoAgents ? 3 : 2;
    await waitFor(() => mockService.requests.length >= readyThreshold);
  }

  function getStdoutLines(): string[] {
    return stdoutBuffer.split("\n").filter((l) => l.trim().length > 0);
  }

  function sendJsonRpc(msg: Record<string, unknown>): void {
    fakeStdin.write(JSON.stringify(msg) + "\n");
  }

  afterEach(async () => {
    if (!fakeStdin.destroyed) {
      fakeStdin.end();
    }
    await proxy.stop();
    await startPromise.catch(() => undefined);
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
    process.stdout.write = originalStdoutWrite;
    vi.restoreAllMocks();
    await mockService.stop();
  });

  it("blocks tool call and returns JSON-RPC error when agent lacks permission", async () => {
    await setupProxy({
      serviceConfig: { scopes: [{ service: "calendar", permissionLevel: "execute" }] },
    });

    sendJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "gmail_send_email",
        arguments: { to: "user@example.com", subject: "Hi", body: "Hello" },
      },
    });

    await waitFor(() => getStdoutLines().length >= 1);

    const line = getStdoutLines()[0] ?? "";
    const response = JSON.parse(line) as Record<string, unknown>;

    expect(response["jsonrpc"]).toBe("2.0");
    expect(response["id"]).toBe(1);
    expect(response["error"]).toBeDefined();
    expect(response["result"]).toBeUndefined();

    const error = response["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(-32000);
    expect(typeof error["message"]).toBe("string");
  });

  it("logs blocked tool call to the service with status blocked", async () => {
    await setupProxy({
      serviceConfig: { scopes: [{ service: "calendar", permissionLevel: "execute" }] },
    });

    sendJsonRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "gmail_send_email",
        arguments: { to: "user@example.com", subject: "Hi", body: "Hello" },
      },
    });

    await waitFor(() => getStdoutLines().length >= 1);
    await proxy.stop();

    const actionRequests = mockService.requests.filter(
      (r) => r.method === "POST" && r.path === "/api/v1/actions",
    );
    expect(actionRequests.length).toBeGreaterThanOrEqual(1);

    const body = actionRequests[0]?.body as Record<string, unknown> | undefined;
    expect(body).toBeDefined();

    const actions = body?.["actions"] as Record<string, unknown>[] | undefined;
    const payload = actions?.[0] ?? body;

    expect(payload).toBeDefined();
    expect(payload?.["status"]).toBe("blocked");
    expect(payload?.["agent"]).toBe("test-agent");
    expect(payload?.["service"]).toBe("gmail");
  });

  it("blocks tool call when cost exceeds per-transaction spending limit", async () => {
    await setupProxy({
      serviceConfig: {
        scopes: [{ service: "payments", permissionLevel: "execute" }],
      },
      spendingLimits: {
        perTransaction: 10000,
        perDay: 50000,
        perMonth: 100000,
      },
    });

    sendJsonRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "payments_charge",
        arguments: { amount: 500, currency: "USD" },
      },
    });

    await waitFor(() => getStdoutLines().length >= 1);

    const line = getStdoutLines()[0] ?? "";
    const response = JSON.parse(line) as Record<string, unknown>;

    expect(response["jsonrpc"]).toBe("2.0");
    expect(response["id"]).toBe(3);
    expect(response["error"]).toBeDefined();
    expect(response["result"]).toBeUndefined();

    const error = response["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(-32001);
    expect(typeof error["message"]).toBe("string");
    expect(String(error["message"])).toContain(expectedDashboardUrl);
  });

  it("blocks tool call after scope is revoked mid-session", async () => {
    await setupProxy({
      serviceConfig: {
        scopes: [{ service: "gmail", permissionLevel: "execute" }],
      },
      scopeRefreshIntervalMs: 200,
    });

    sendJsonRpc({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "gmail_send_email",
        arguments: { to: "a@b.com", subject: "A", body: "B" },
      },
    });

    await waitFor(() => getStdoutLines().length >= 1);

    const firstLine = getStdoutLines()[0] ?? "";
    const firstResponse = JSON.parse(firstLine) as Record<string, unknown>;
    expect(firstResponse["result"]).toBeDefined();
    expect(firstResponse["error"]).toBeUndefined();

    mockService.setScopes([{ service: "calendar", permissionLevel: "execute" }]);

    // Wait for at least one scope refresh cycle to pick up the revocation.
    await sleep(400);

    stdoutBuffer = "";

    sendJsonRpc({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "gmail_send_email",
        arguments: { to: "c@d.com", subject: "C", body: "D" },
      },
    });

    await waitFor(() => getStdoutLines().length >= 1);

    const secondLine = getStdoutLines()[0] ?? "";
    const secondResponse = JSON.parse(secondLine) as Record<string, unknown>;

    expect(secondResponse["jsonrpc"]).toBe("2.0");
    expect(secondResponse["id"]).toBe(11);
    expect(secondResponse["error"]).toBeDefined();
    expect(secondResponse["result"]).toBeUndefined();
  });

  it("includes dashboard URL in block error message", async () => {
    await setupProxy({
      serviceConfig: { scopes: [{ service: "payments", permissionLevel: "execute" }] },
    });

    sendJsonRpc({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "calendar_create_event",
        arguments: { title: "Meeting", date: "2026-03-01" },
      },
    });

    await waitFor(() => getStdoutLines().length >= 1);

    const line = getStdoutLines()[0] ?? "";
    const response = JSON.parse(line) as Record<string, unknown>;
    const error = response["error"] as Record<string, unknown>;

    expect(String(error["message"])).toContain(expectedDashboardUrl);
  });
});
