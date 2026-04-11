/**
 * Fail-closed behaviour: every failure path blocks the tool call with a distinct error.
 *
 * @vitest-environment node
 * @module proxy/__tests__/proxy.fail-closed.test
 */

import { PassThrough } from "node:stream";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createProxyServer, type ProxyServer } from "../index.js";
import { createLogger } from "../logger.js";
import { deriveDashboardUrl } from "../consent.js";
import { startMockMcpServer } from "../__fixtures__/mockMcpServer.js";

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

describe("fail-closed: service errors", () => {
  let fakeStdin: PassThrough;
  let stdoutBuffer: string;
  let proxy: ProxyServer;
  let startPromise: Promise<void> | undefined = undefined;
  const originalStdin = process.stdin;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalFetch = global.fetch;

  async function setupStdio(): Promise<{ mcpCommand: string; mcpArgs: string[] }> {
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

    return { mcpCommand, mcpArgs };
  }

  function createProxy(baseUrl: string, mcpCommand: string, mcpArgs: string[]): void {
    proxy = createProxyServer({
      command: mcpCommand,
      commandArgs: mcpArgs,
      apiKey: "test-key",
      agentName: "test-agent",
      baseUrl,
      dashboardUrl: deriveDashboardUrl(baseUrl),
      logger: createLogger("warn"),
    });
  }

  function getStdoutLines(): string[] {
    return stdoutBuffer.split("\n").filter((l) => l.trim().length > 0);
  }

  function sendJsonRpc(msg: Record<string, unknown>): void {
    fakeStdin.write(JSON.stringify(msg) + "\n");
  }

  beforeEach(() => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (typeof fakeStdin !== "undefined" && !fakeStdin.destroyed) {
      fakeStdin.end();
    }
    if (typeof proxy !== "undefined") {
      await proxy.stop();
    }
    if (startPromise !== undefined) await startPromise.catch(() => undefined);
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
    process.stdout.write = originalStdoutWrite;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("blocks with service-unreachable when service is down at startup", async () => {
    const { mcpCommand, mcpArgs } = await setupStdio();
    createProxy("http://localhost:1", mcpCommand, mcpArgs);

    startPromise = proxy.start();
    await sleep(500);

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
    const error = response["error"] as Record<string, unknown>;

    expect(error["code"]).toBe(-32003);
    expect(String(error["message"])).toContain("service unreachable");
  });

  it("blocks with service-unreachable when service times out", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    global.fetch = vi.fn().mockImplementation(() => Promise.reject(abortError));

    const { mcpCommand, mcpArgs } = await setupStdio();
    createProxy("https://api.multicorn.ai", mcpCommand, mcpArgs);

    startPromise = proxy.start();
    await sleep(500);

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
    const error = response["error"] as Record<string, unknown>;

    expect(error["code"]).toBe(-32003);
  });

  it("blocks when service returns 500", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const { mcpCommand, mcpArgs } = await setupStdio();
    createProxy("https://api.multicorn.ai", mcpCommand, mcpArgs);

    startPromise = proxy.start();
    await sleep(500);

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
    const error = response["error"] as Record<string, unknown>;

    expect(error["code"]).toBe(-32003);
  });

  it("blocks when service returns malformed JSON", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.reject(new SyntaxError("Unexpected token")),
        } as Response);
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    const { mcpCommand, mcpArgs } = await setupStdio();
    createProxy("https://api.multicorn.ai", mcpCommand, mcpArgs);

    startPromise = proxy.start();
    await sleep(500);

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
    expect(response["error"]).toBeDefined();
    const error = response["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(-32003);
  });
});

describe("fail-closed: auth errors", () => {
  let fakeStdin: PassThrough;
  let stdoutBuffer: string;
  let proxy: ProxyServer;
  const originalStdin = process.stdin;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalFetch = global.fetch;

  async function setupStdio(): Promise<{ mcpCommand: string; mcpArgs: string[] }> {
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

    return { mcpCommand, mcpArgs };
  }

  function createProxy(baseUrl: string, mcpCommand: string, mcpArgs: string[]): void {
    proxy = createProxyServer({
      command: mcpCommand,
      commandArgs: mcpArgs,
      apiKey: "test-key",
      agentName: "test-agent",
      baseUrl,
      dashboardUrl: deriveDashboardUrl(baseUrl),
      logger: createLogger("warn"),
    });
  }

  function getStdoutLines(): string[] {
    return stdoutBuffer.split("\n").filter((l) => l.trim().length > 0);
  }

  beforeEach(() => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (typeof fakeStdin !== "undefined" && !fakeStdin.destroyed) {
      fakeStdin.end();
    }
    if (typeof proxy !== "undefined") {
      await proxy.stop();
    }
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
    process.stdout.write = originalStdoutWrite;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("start() rejects immediately when API key is invalid (401)", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const { mcpCommand, mcpArgs } = await setupStdio();
    createProxy("https://api.multicorn.ai", mcpCommand, mcpArgs);

    await expect(proxy.start()).rejects.toThrow("API key was rejected");
    expect(getStdoutLines().length).toBe(0);
  });

  it("start() rejects immediately when API key is revoked (403)", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });

    const { mcpCommand, mcpArgs } = await setupStdio();
    createProxy("https://api.multicorn.ai", mcpCommand, mcpArgs);

    await expect(proxy.start()).rejects.toThrow("API key was rejected");
    expect(getStdoutLines().length).toBe(0);
  });

  it("start() prints user-facing error to stderr when authInvalid", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const { mcpCommand, mcpArgs } = await setupStdio();

    let stderrCapture = "";
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
      cb?: (error?: Error | null) => void,
    ): boolean => {
      stderrCapture += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (callback !== undefined) callback(null);
      return true;
    }) as typeof process.stderr.write;

    createProxy("https://api.multicorn.ai", mcpCommand, mcpArgs);

    try {
      await proxy.start();
    } catch {
      // expected
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    expect(stderrCapture).toContain("API key was rejected by the Multicorn service");
    expect(stderrCapture).toContain("https://app.multicorn.ai/settings#api-keys");
  });

  it("start() does not log Proxy ready or spawn child when authInvalid", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const { mcpCommand, mcpArgs } = await setupStdio();

    let stderrCapture = "";
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
      cb?: (error?: Error | null) => void,
    ): boolean => {
      stderrCapture += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (callback !== undefined) callback(null);
      return true;
    }) as typeof process.stderr.write;

    createProxy("https://api.multicorn.ai", mcpCommand, mcpArgs);

    try {
      await proxy.start();
    } catch {
      // expected
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    expect(stderrCapture).not.toContain("Proxy ready");
    expect(getStdoutLines().length).toBe(0);
  });
});

describe("fail-closed: internal errors", () => {
  let fakeStdin: PassThrough;
  let stdoutBuffer: string;
  let proxy: ProxyServer;
  let startPromise: Promise<void> | undefined = undefined;
  const originalStdin = process.stdin;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalFetch = global.fetch;

  const validateScopeAccessMock = vi.hoisted(() => vi.fn());

  vi.mock("../../scopes/scope-validator.js", () => ({
    validateScopeAccess: (...args: unknown[]) =>
      validateScopeAccessMock(...args) as { allowed: boolean; reason?: string },
    hasScope: vi.fn().mockReturnValue(false),
  }));

  async function setupStdio(): Promise<{ mcpCommand: string; mcpArgs: string[] }> {
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

    return { mcpCommand, mcpArgs };
  }

  function createProxy(baseUrl: string, mcpCommand: string, mcpArgs: string[]): void {
    proxy = createProxyServer({
      command: mcpCommand,
      commandArgs: mcpArgs,
      apiKey: "test-key",
      agentName: "test-agent",
      baseUrl,
      dashboardUrl: deriveDashboardUrl(baseUrl),
      logger: createLogger("warn"),
    });
  }

  function getStdoutLines(): string[] {
    return stdoutBuffer.split("\n").filter((l) => l.trim().length > 0);
  }

  function sendJsonRpc(msg: Record<string, unknown>): void {
    fakeStdin.write(JSON.stringify(msg) + "\n");
  }

  beforeEach(() => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    validateScopeAccessMock.mockReset();
  });

  afterEach(async () => {
    if (typeof fakeStdin !== "undefined" && !fakeStdin.destroyed) {
      fakeStdin.end();
    }
    if (typeof proxy !== "undefined") {
      await proxy.stop();
    }
    if (startPromise !== undefined) await startPromise.catch(() => undefined);
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
    process.stdout.write = originalStdoutWrite;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("blocks with internal error when handleToolCall throws and proxy continues processing", async () => {
    const { startMockMulticornService } = await import("../__fixtures__/mockMulticornService.js");
    const mockService = await startMockMulticornService();
    const baseUrl = mockService.baseUrl.replace("127.0.0.1", "localhost");

    validateScopeAccessMock
      .mockImplementationOnce(() => {
        throw new Error("validator boom");
      })
      .mockReturnValueOnce({ allowed: true });

    const { mcpCommand, mcpArgs } = await setupStdio();
    createProxy(baseUrl, mcpCommand, mcpArgs);

    startPromise = proxy.start();
    await waitFor(() => mockService.requests.length >= 2);

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

    const firstLine = getStdoutLines()[0] ?? "";
    const firstResponse = JSON.parse(firstLine) as Record<string, unknown>;
    const firstError = firstResponse["error"] as Record<string, unknown>;

    expect(firstError["code"]).toBe(-32002);
    expect(String(firstError["message"])).toContain("internal error");

    stdoutBuffer = "";
    sendJsonRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "gmail_send_email",
        arguments: { to: "other@example.com", subject: "Hi", body: "Hello" },
      },
    });

    await waitFor(() => getStdoutLines().length >= 1);

    const secondLine = getStdoutLines()[0] ?? "";
    const secondResponse = JSON.parse(secondLine) as Record<string, unknown>;
    expect(secondResponse["result"]).toBeDefined();
    expect(secondResponse["error"]).toBeUndefined();

    await mockService.stop();
  });
});

describe("fail-closed: offline mode config", () => {
  it.todo(
    "offlineMode block-all: blocks even with cached scopes when service is unreachable (depends on checklist item 4: offlineMode config)",
  );
  it.todo(
    "offlineMode use-cached: allows with warning when cached scopes exist and service is unreachable (depends on checklist item 4)",
  );
});

describe("fail-closed: process cleanup", () => {
  it.todo(
    "sends SIGKILL after 5s if child does not exit on SIGTERM (depends on checklist item 7: SIGKILL escalation)",
  );
});
