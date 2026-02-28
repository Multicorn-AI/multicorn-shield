/**
 * Happy-path integration tests for the MCP proxy.
 *
 * Verifies:
 * 1. Allowed tool calls pass through to the underlying MCP server
 * 2. Allowed tool calls are logged to the Multicorn service
 * 3. tools/list passthrough returns all tools unmodified
 * 4. Agent auto-registration on first connection
 * 5. Scope caching: scopes fetched once on startup, not per tool call
 *
 * @vitest-environment node
 * @module proxy/__tests__/proxy.happy-path.test
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

// Mock node:fs/promises to prevent disk I/O to ~/.multicorn/

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

// Helpers

/**
 * Poll a predicate until it returns true or the timeout elapses.
 */
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

// Test suite

describe("proxy happy path", () => {
  let mockService: MockMulticornService;
  let fakeStdin: PassThrough;
  let stdoutBuffer: string;
  let proxy: ProxyServer;
  let startPromise: Promise<void>;
  const originalStdin = process.stdin;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  /**
   * Boot the proxy against a mock Multicorn service with the supplied config.
   * Returns once the proxy has finished its startup HTTP calls.
   */
  async function setupProxy(serviceConfig?: MockServiceConfig): Promise<void> {
    // Prevent filesystem access (loadCachedScopes / saveCachedScopes).
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);

    mockService = await startMockMulticornService(serviceConfig);
    // The action logger requires https:// or http://localhost. Translate.
    const baseUrl = mockService.baseUrl.replace("127.0.0.1", "localhost");

    // Obtain the command/args for the mock MCP server, then stop the instance.
    // The proxy will spawn its own child with the same command.
    const mockServer = startMockMcpServer();
    const mcpCommand = mockServer.command;
    const mcpArgs = [...mockServer.args];
    await mockServer.stop();

    // Replace process.stdin with a PassThrough we control.
    fakeStdin = new PassThrough();
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
      writable: true,
    });

    // Capture process.stdout.write output.
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
    });

    startPromise = proxy.start();

    // The auto-registration path (empty agents list) triggers 3 HTTP calls;
    // the normal path (agent found by name) triggers 2.
    const hasNoAgents = serviceConfig?.agents?.length === 0;
    const readyThreshold = hasNoAgents ? 3 : 2;
    await waitFor(() => mockService.requests.length >= readyThreshold);
  }

  /** Return the non-empty lines captured from process.stdout. */
  function getStdoutLines(): string[] {
    return stdoutBuffer.split("\n").filter((l) => l.trim().length > 0);
  }

  /** Write a JSON-RPC message to the proxy's faked stdin. */
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

  it("passes allowed tool calls through and returns the correct result", async () => {
    await setupProxy();

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

    const result = response["result"] as Record<string, unknown>;
    const content = result["content"] as Record<string, unknown>[];
    const firstEntry = content[0];
    expect(firstEntry?.["text"]).toBe("Email sent to user@example.com");
  });

  it("logs allowed tool calls to the mock service via POST /api/v1/actions", async () => {
    await setupProxy();

    sendJsonRpc({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "gmail_send_email",
        arguments: { to: "user@example.com", subject: "Hi", body: "Hello" },
      },
    });

    // Wait for the proxy to forward the response (proves the call was processed).
    await waitFor(() => getStdoutLines().length >= 1);

    // Flush the batched action logger by stopping the proxy.
    await proxy.stop();

    const actionRequests = mockService.requests.filter(
      (r) => r.method === "POST" && r.path === "/api/v1/actions",
    );
    expect(actionRequests.length).toBeGreaterThanOrEqual(1);

    // The logger sends batched payloads: { actions: [...] }
    // Find the request that contains our action
    let payload: Record<string, unknown> | undefined;
    for (const request of actionRequests) {
      const body = request.body as Record<string, unknown> | undefined;
      if (!body) continue;

      // Check if it's a batched payload
      const actions = body["actions"] as Record<string, unknown>[] | undefined;
      if (actions && Array.isArray(actions) && actions.length > 0) {
        const action = actions.find((a) => a["agent"] === "test-agent" && a["service"] === "gmail");
        if (action) {
          payload = action;
          break;
        }
      } else if (body["agent"] === "test-agent" && body["service"] === "gmail") {
        // Single action (non-batched)
        payload = body;
        break;
      }
    }

    expect(payload).toBeDefined();
    expect(payload?.["agent"]).toBe("test-agent");
    expect(payload?.["service"]).toBe("gmail");
    expect(payload?.["actionType"]).toBe("send_email");
    expect(payload?.["status"]).toBe("approved");
  });

  it("passes tools/list through and returns all tools unmodified", async () => {
    await setupProxy();

    sendJsonRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    await waitFor(() => getStdoutLines().length >= 1);

    const line = getStdoutLines()[0] ?? "";
    const response = JSON.parse(line) as Record<string, unknown>;

    expect(response["jsonrpc"]).toBe("2.0");
    expect(response["id"]).toBe(2);

    const result = response["result"] as Record<string, unknown>;
    const tools = result["tools"] as Record<string, unknown>[];

    expect(tools).toHaveLength(3);

    const names = tools.map((t) => t["name"]);
    expect(names).toContain("gmail_send_email");
    expect(names).toContain("calendar_create_event");
    expect(names).toContain("payments_charge");
  });

  it("auto-registers the agent on first connection when it does not exist", async () => {
    await setupProxy({
      agents: [],
      scopes: [{ service: "gmail", permissionLevel: "execute" }],
    });

    const registerRequests = mockService.requests.filter(
      (r) => r.method === "POST" && r.path === "/api/v1/agents",
    );

    expect(registerRequests).toHaveLength(1);

    const body = registerRequests[0]?.body as Record<string, unknown> | undefined;
    expect(body).toBeDefined();
    expect(body?.["name"]).toBe("test-agent");
  });

  it("fetches scopes only once on startup, not on every tool call", async () => {
    await setupProxy();

    // Pattern matches GET /api/v1/agents/:id (single-agent detail, not the list).
    const scopePattern = /^\/api\/v1\/agents\/[^/]+$/;

    const initialScopeFetches = mockService.requests.filter(
      (r) => r.method === "GET" && scopePattern.test(r.path),
    );
    expect(initialScopeFetches).toHaveLength(1);

    // Fire two consecutive allowed tool calls.
    sendJsonRpc({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: {
        name: "gmail_send_email",
        arguments: { to: "a@b.com", subject: "A", body: "B" },
      },
    });
    sendJsonRpc({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: {
        name: "gmail_send_email",
        arguments: { to: "c@d.com", subject: "C", body: "D" },
      },
    });

    await waitFor(() => getStdoutLines().length >= 2);

    // Scope endpoint should still only have been called once (at startup).
    const allScopeFetches = mockService.requests.filter(
      (r) => r.method === "GET" && scopePattern.test(r.path),
    );
    expect(allScopeFetches).toHaveLength(1);
  });
});
