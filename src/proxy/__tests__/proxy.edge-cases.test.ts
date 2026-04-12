/**
 * Edge case integration tests for the MCP proxy.
 *
 * Verifies:
 * 1. Graceful shutdown: SIGTERM kills child, pending action logs flushed
 * 2. Config file parsing: valid loads, missing prompts init, invalid key clear error
 * 3. Service unavailable: proxy handles network errors gracefully
 *
 * @vitest-environment node
 * @module proxy/__tests__/proxy.edge-cases.test
 */

import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createProxyServer, type ProxyServer } from "../index.js";
import { createLogger } from "../logger.js";
import {
  loadConfig,
  validateApiKey,
  runInit,
  updateOpenClawConfigIfPresent,
  updateClaudeDesktopConfig,
  getClaudeDesktopConfigPath,
} from "../config.js";
import { resolveAgentRecord, waitForConsent, deriveDashboardUrl } from "../consent.js";
import { startMockMcpServer } from "../__fixtures__/mockMcpServer.js";
import {
  startMockMulticornService,
  type MockMulticornService,
  type MockServiceConfig,
} from "../__fixtures__/mockMulticornService.js";

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

/**
 * Readline mock passes through to the real implementation by default.
 * When `rlQuestionMock` has an implementation set, createInterface returns
 * a controlled stub instead, used exclusively by the runInit tests.
 */
const rlQuestionMock = vi.hoisted(() => vi.fn());
const rlCloseMock = vi.hoisted(() => vi.fn());

/**
 * Child process spawn mock passes through to the real spawn by default.
 * When `spawnMock` has an implementation set, the mock is used instead.
 * This lets integration tests use real child processes while unit tests
 * for openBrowser/waitForConsent can stub spawn.
 */
const spawnMock = vi.hoisted(() => vi.fn());

/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion */
vi.mock("node:readline", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    createInterface: (...args: unknown[]) => {
      if (rlQuestionMock.getMockImplementation() !== undefined) {
        return { question: rlQuestionMock, close: rlCloseMock };
      }
      return (real["createInterface"] as (...a: unknown[]) => unknown)(...args);
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    spawn: (...args: unknown[]) => {
      if (spawnMock.getMockImplementation() !== undefined) {
        return spawnMock(...args);
      }
      return (real["spawn"] as (...a: unknown[]) => unknown)(...args);
    },
  };
});
/* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion */

/** Minimal ~/.openclaw/openclaw.json so `detectOpenClaw()` succeeds (version >= OPENCLAW_MIN_VERSION). */
const MINIMAL_OPENCLAW_JSON = JSON.stringify({
  meta: { lastTouchedVersion: "2026.3.1" },
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

const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g");
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

describe("graceful shutdown", () => {
  let mockService: MockMulticornService;
  let fakeStdin: PassThrough;
  let stdoutBuffer: string;
  let proxy: ProxyServer;
  let startPromise: Promise<void>;
  const originalStdin = process.stdin;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  interface ProxySetupOptions {
    serviceConfig?: MockServiceConfig;
    scopeRefreshIntervalMs?: number;
  }

  async function setupProxy(options: ProxySetupOptions = {}): Promise<void> {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);

    mockService = await startMockMulticornService(options.serviceConfig);
    const baseUrl = mockService.baseUrl.replace("127.0.0.1", "localhost");

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

  it("flushes pending action logs before the child process exits", async () => {
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
    await proxy.stop();

    const actionRequests = mockService.requests.filter(
      (r) => r.method === "POST" && r.path === "/api/v1/actions",
    );
    expect(actionRequests.length).toBeGreaterThanOrEqual(1);

    const body = actionRequests[0]?.body as Record<string, unknown> | undefined;
    expect(body).toBeDefined();

    const actions = body?.["actions"] as Record<string, unknown>[] | undefined;
    const payload = actions?.[0] ?? body;

    expect(payload?.["status"]).toBe("approved");
    expect(payload?.["agent"]).toBe("test-agent");
    expect(payload?.["service"]).toBe("gmail");
  });

  it("kills the child MCP server process on stop", async () => {
    await setupProxy();

    await proxy.stop();
    await expect(startPromise).resolves.toBeUndefined();
  });

  it("clears the scope refresh timer so no further refresh attempts occur", async () => {
    await setupProxy({ scopeRefreshIntervalMs: 100 });

    await proxy.stop();

    const scopePattern = /^\/api\/v1\/agents\/[^/]+$/;
    const countAfterStop = mockService.requests.filter(
      (r) => r.method === "GET" && scopePattern.test(r.path),
    ).length;

    await sleep(300);

    const countAfterWait = mockService.requests.filter(
      (r) => r.method === "GET" && scopePattern.test(r.path),
    ).length;

    expect(countAfterWait).toBe(countAfterStop);
  });
});

describe("config file parsing", () => {
  const originalFetch = global.fetch;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalIsTTY = process.stdin.isTTY;
  let stderrBuffer: string;

  beforeEach(() => {
    vi.resetAllMocks();
    stderrBuffer = "";
    process.stdin.isTTY = true;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
    process.stdin.isTTY = originalIsTTY;
    rlQuestionMock.mockReset();
    rlCloseMock.mockReset();
  });

  function captureStderr(): void {
    process.stderr.write = ((
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
      cb?: (error?: Error | null) => void,
    ): boolean => {
      stderrBuffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (callback !== undefined) callback(null);
      return true;
    }) as typeof process.stderr.write;
  }

  /**
   * Build a prompt-aware mock for rlQuestionMock.
   * Maps prompt substrings to responses. Supports per-prompt call counters
   * via arrays (first call gets index 0, second gets index 1, etc.).
   */
  function mockPrompts(mapping: Record<string, string | string[]>): void {
    const counters = new Map<string, number>();
    rlQuestionMock.mockImplementation((prompt: string, cb: (answer: string) => void) => {
      for (const [substring, response] of Object.entries(mapping)) {
        if (prompt.includes(substring)) {
          if (Array.isArray(response)) {
            const idx = counters.get(substring) ?? 0;
            counters.set(substring, idx + 1);
            cb(response[idx] ?? response[response.length - 1] ?? "");
          } else {
            cb(response);
          }
          return;
        }
      }
      cb("");
    });
  }

  it("loadConfig returns null when the file contains a JSON array", async () => {
    readFileMock.mockResolvedValue("[1, 2, 3]");

    const result = await loadConfig();

    expect(result).toBeNull();
  });

  it("loadConfig returns null when apiKey is a number instead of a string", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({ apiKey: 12345, baseUrl: "https://api.multicorn.ai" }),
    );

    const result = await loadConfig();

    expect(result).toBeNull();
  });

  it("loadConfig returns null when the file contains a JSON string literal", async () => {
    readFileMock.mockResolvedValue('"just-a-string"');

    const result = await loadConfig();

    expect(result).toBeNull();
  });

  it("loadConfig returns null when the file contains JSON null", async () => {
    readFileMock.mockResolvedValue("null");

    const result = await loadConfig();

    expect(result).toBeNull();
  });

  it("loadConfig returns null when baseUrl is missing", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ apiKey: "mcs_valid" }));

    const result = await loadConfig();

    expect(result).toBeNull();
  });

  it("validateApiKey returns a descriptive error without a stack trace for a rejected key", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const result = await validateApiKey("mcs_invalid", "https://api.multicorn.ai");

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("not recognised");
    expect(result.error).not.toContain("at ");
    expect(result.error).not.toContain("Error:");
  });

  it("validateApiKey returns a clear network error when the service is unreachable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await validateApiKey("mcs_key", "https://api.multicorn.ai");

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.error).toContain("api.multicorn.ai");
  });

  it("validateApiKey handles a non-Error thrown value gracefully", async () => {
    global.fetch = vi.fn().mockRejectedValue("network down");

    const result = await validateApiKey("mcs_key", "https://api.multicorn.ai");

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("network down");
  });

  it("runInit saves config after a valid API key is entered", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "test-agent",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.apiKey).toBe("mcs_valid_key");
    expect(config.baseUrl).toBe("https://api.multicorn.ai");
    expect(rlCloseMock).toHaveBeenCalledOnce();
  });

  it("runInit retries when an empty API key is entered", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": ["", "mcs_second_try"],
      Select: "1",
      "call this agent": "test-agent",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.apiKey).toBe("mcs_second_try");
    expect(stderrBuffer).toContain("API key is required");
  });

  it("runInit retries when the service rejects the API key", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );

    let fetchCallCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        return Promise.resolve({ ok: false, status: 401 });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    mockPrompts({
      "API key": ["mcs_bad", "mcs_good"],
      Select: "1",
      "call this agent": "test-agent",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.apiKey).toBe("mcs_good");
    expect(stderrBuffer).toContain("not recognised");
  });

  it("runInit uses default base URL and shows fallback message when error field is absent", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );

    let fetchCallCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    mockPrompts({
      "API key": ["mcs_first", "mcs_second"],
      Select: "1",
      "call this agent": "test-agent",
      "Connect another": "n",
    });

    const config = await runInit();

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.baseUrl).toBe("https://api.multicorn.ai");
    expect(config.apiKey).toBe("mcs_second");
  });

  it("runInit reuses existing API key when user accepts", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const existingConfig = JSON.stringify({
      apiKey: "mcs_existing_key1",
      baseUrl: "https://api.multicorn.ai",
    });
    readFileMock.mockImplementation((path: string) => {
      if (path.includes(".openclaw")) return Promise.resolve(MINIMAL_OPENCLAW_JSON);
      if (path.includes("config.json")) return Promise.resolve(existingConfig);
      return Promise.reject(new Error("ENOENT"));
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "Use this key": "y",
      Select: "1",
      "call this agent": "test-agent",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.apiKey).toBe("mcs_existing_key1");
    expect(stderrBuffer).toContain("mcs_...key1");
  });

  it("runInit falls through to prompt when user declines existing key", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const existingConfig = JSON.stringify({
      apiKey: "mcs_old_key1234",
      baseUrl: "https://api.multicorn.ai",
    });
    readFileMock.mockImplementation((path: string) => {
      if (path.includes(".openclaw")) return Promise.resolve(MINIMAL_OPENCLAW_JSON);
      if (path.includes("config.json")) return Promise.resolve(existingConfig);
      return Promise.reject(new Error("ENOENT"));
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "Use this key": "n",
      "API key": "mcs_new_key",
      Select: "1",
      "call this agent": "my-agent",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.apiKey).toBe("mcs_new_key");
  });

  it("runInit reads base URL from config.json when user enters a new key", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const existingConfig = JSON.stringify({
      apiKey: "mcs_old_key1234",
      baseUrl: "https://enterprise.example.com",
    });
    readFileMock.mockImplementation((path: string) => {
      if (path.includes(".openclaw")) return Promise.resolve(MINIMAL_OPENCLAW_JSON);
      if (path.includes("config.json")) return Promise.resolve(existingConfig);
      return Promise.reject(new Error("ENOENT"));
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;

    mockPrompts({
      "Use this key": "n",
      "API key": "mcs_new_key",
      Select: "1",
      "call this agent": "my-agent",
      "Connect another": "n",
    });

    const config = await runInit();

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.baseUrl).toBe("https://enterprise.example.com");
    expect(config.apiKey).toBe("mcs_new_key");
    const agentsFetchCall = fetchMock.mock.calls.find(
      (c): c is [string, ...unknown[]] =>
        typeof c[0] === "string" && c[0].includes("/api/v1/agents"),
    );
    expect(agentsFetchCall).toBeDefined();
    if (agentsFetchCall === undefined) throw new Error("expected /api/v1/agents fetch");
    expect(agentsFetchCall[0]).toContain("enterprise.example.com");
  });

  it("runInit reads base URL from config.json when apiKey is missing (partial config)", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const partialOnlyBase = JSON.stringify({
      baseUrl: "https://only-base.example.com",
    });
    readFileMock.mockImplementation((path: string) => {
      if (path.includes(".openclaw")) return Promise.resolve(MINIMAL_OPENCLAW_JSON);
      if (path.includes("config.json")) return Promise.resolve(partialOnlyBase);
      return Promise.reject(new Error("ENOENT"));
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;

    mockPrompts({
      "API key": "mcs_new_key",
      Select: "1",
      "call this agent": "solo-agent",
      "Connect another": "n",
    });

    const config = await runInit();

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.baseUrl).toBe("https://only-base.example.com");
    const agentsFetchCall = fetchMock.mock.calls.find(
      (c): c is [string, ...unknown[]] =>
        typeof c[0] === "string" && c[0].includes("/api/v1/agents"),
    );
    expect(agentsFetchCall).toBeDefined();
    if (agentsFetchCall === undefined) throw new Error("expected /api/v1/agents fetch");
    expect(agentsFetchCall[0]).toContain("only-base.example.com");
  });

  it("runInit rejects non-HTTPS base URL from config.json", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const insecureBase = JSON.stringify({
      baseUrl: "http://evil.example.com",
    });
    readFileMock.mockImplementation((path: string) => {
      if (path.includes(".openclaw")) return Promise.resolve(MINIMAL_OPENCLAW_JSON);
      if (path.includes("config.json")) return Promise.resolve(insecureBase);
      return Promise.reject(new Error("ENOENT"));
    });
    global.fetch = vi.fn();

    const config = await runInit();

    expect(config).toBeNull();
    expect(stderrBuffer).toContain("HTTPS");
    expect(stderrBuffer).toContain("base-url");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("runInit keeps explicit --base-url over config.json base URL", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const existingConfig = JSON.stringify({
      apiKey: "mcs_existing",
      baseUrl: "https://from-file.example.com",
    });
    readFileMock.mockImplementation((path: string) => {
      if (path.includes(".openclaw")) return Promise.resolve(MINIMAL_OPENCLAW_JSON);
      if (path.includes("config.json")) return Promise.resolve(existingConfig);
      return Promise.reject(new Error("ENOENT"));
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;

    mockPrompts({
      "Use this key": "n",
      "API key": "mcs_new_after_override",
      Select: "1",
      "call this agent": "my-agent",
      "Connect another": "n",
    });

    const config = await runInit("https://explicit-override.example.com");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.baseUrl).toBe("https://explicit-override.example.com");
    expect(config.apiKey).toBe("mcs_new_after_override");
    const agentsFetchCall = fetchMock.mock.calls.find(
      (c): c is [string, ...unknown[]] =>
        typeof c[0] === "string" && c[0].includes("/api/v1/agents"),
    );
    expect(agentsFetchCall).toBeDefined();
    if (agentsFetchCall === undefined) throw new Error("expected /api/v1/agents fetch");
    expect(agentsFetchCall[0]).toContain("explicit-override.example.com");
    expect(agentsFetchCall[0]).not.toContain("from-file.example.com");
  });

  it("runInit normalizes agent name with spaces and uppercase", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "My Cool Agent!",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.agents?.[0]?.name).toBe("my-cool-agent");
    expect(config.agents?.[0]?.platform).toBe("openclaw");
    expect(config.defaultAgent).toBe("my-cool-agent");
    expect(stderrBuffer).toContain("Agent name set to:");
  });

  it("runInit re-prompts when agent name normalizes to empty", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": ["---", "valid-name"],
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.agents?.[0]?.name).toBe("valid-name");
    expect(config.defaultAgent).toBe("valid-name");
    expect(stderrBuffer).toContain("must contain letters or numbers");
  });

  it("runInit shows Claude Code instructions for platform 2", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "2",
      "call this agent": "my-agent",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    expect(stderrBuffer).toContain("claude plugin install multicorn-shield@multicorn-shield");
    expect(stderrBuffer).toContain("Step 1");
    expect(stderrBuffer).toContain("claude plugin marketplace add Multicorn-AI/multicorn-shield");
  });

  it("runInit completes Cursor platform with proxy URL and Cursor next steps", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockImplementation((input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/v1/proxy/config")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: { proxy_url: "https://hosted.proxy.example/mcp" },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "3",
      "call this agent": "cursor-agent",
      "URL:": "https://upstream.example/mcp",
      "Short name": "myproxy",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.agents?.[0]?.platform).toBe("cursor");
    expect(config.defaultAgent).toBe("cursor-agent");
    expect(stderrBuffer).toContain("To complete your Cursor setup");
    expect(stderrBuffer).toContain("Restart Cursor");
    expect(stderrBuffer).toContain("hosted.proxy.example");
    expect(stderrBuffer).toContain("Bearer mcs_valid_key");
    expect(stderrBuffer).toContain("cursor.com/downloads");
    expect(stderrBuffer).toContain("paste the config snippet shown above");
  });

  it("runInit completes Windsurf platform with proxy URL and Windsurf next steps", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockImplementation((input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/v1/proxy/config")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: { proxy_url: "https://hosted.proxy.example/mcp" },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "4",
      "call this agent": "windsurf-agent",
      "URL:": "https://upstream.example/mcp",
      "Short name": "myproxy",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.agents?.[0]?.platform).toBe("windsurf");
    expect(config.defaultAgent).toBe("windsurf-agent");
    expect(stderrBuffer).toContain("serverUrl");
    expect(stderrBuffer).toContain("mcpServers");
    expect(stderrBuffer).toContain("hosted.proxy.example");
    expect(stderrBuffer).toContain("Bearer mcs_valid_key");
    expect(stderrBuffer).toContain("To complete your Windsurf setup");
    expect(stderrBuffer).toContain("~/.codeium/windsurf/mcp_config.json");
    expect(stderrBuffer).toContain("Restart Windsurf");
    expect(stderrBuffer).toContain("windsurf.com/download");
    expect(stderrBuffer).toContain("paste the config snippet shown above");
  });

  it("runInit Windsurf Next steps includes download hint and first-time launch copy", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockImplementation((input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/v1/proxy/config")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: { proxy_url: "https://hosted.proxy.example/mcp" },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "4",
      "call this agent": "windsurf-agent",
      "URL:": "https://upstream.example/mcp",
      "Short name": "myproxy",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    expect(stripAnsi(stderrBuffer)).toContain("windsurf.com/download");
    expect(stripAnsi(stderrBuffer)).toContain("or launch it for the first time");
  });

  it("runInit completes Windsurf platform with proxy URL and Windsurf next steps", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockImplementation((input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/v1/proxy/config")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: { proxy_url: "https://hosted.proxy.example/mcp" },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "4",
      "call this agent": "windsurf-agent",
      "URL:": "https://upstream.example/mcp",
      "Short name": "myproxy",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.agents?.[0]?.platform).toBe("windsurf");
    expect(config.defaultAgent).toBe("windsurf-agent");
    expect(stderrBuffer).toContain("serverUrl");
    expect(stderrBuffer).toContain("mcpServers");
    expect(stderrBuffer).toContain("hosted.proxy.example");
    expect(stderrBuffer).toContain("Bearer mcs_valid_key");
    expect(stderrBuffer).toContain("To complete your Windsurf setup");
    expect(stderrBuffer).toContain("~/.codeium/windsurf/mcp_config.json");
    expect(stderrBuffer).toContain("Restart Windsurf");
  });

  // --- Platform detection labels ---

  it("runInit shows 'detected locally' with dot icon when a platform is detected", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    // Return OpenClaw config with Shield API key set so isOpenClawConnected() returns true.
    const openclawWithShield = JSON.stringify({
      meta: { lastTouchedVersion: "2026.3.1" },
      hooks: {
        internal: {
          entries: {
            "multicorn-shield": {
              env: { MULTICORN_API_KEY: "mcs_existing_key" },
            },
          },
        },
      },
    });
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(openclawWithShield)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "test-agent",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    const plain = stripAnsi(stderrBuffer);
    expect(plain).toContain("detected locally");
    expect(plain).toContain("\u25CF");
  });

  it("runInit does not show 'connected' or checkmark in platform list", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const openclawWithShield = JSON.stringify({
      meta: { lastTouchedVersion: "2026.3.1" },
      hooks: {
        internal: {
          entries: {
            "multicorn-shield": {
              env: { MULTICORN_API_KEY: "mcs_existing_key" },
            },
          },
        },
      },
    });
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(openclawWithShield)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "test-agent",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    const plain = stripAnsi(stderrBuffer);
    // The platform list section (before "API key") should not contain "connected" or checkmark.
    expect(plain).not.toMatch(/\u2713\s*connected/);
  });

  it("runInit does not show OpenClaw as detected when Shield key is absent", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    // OpenClaw config exists but has no Shield API key entry.
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(JSON.stringify({ meta: { lastTouchedVersion: "2026.3.1" } }))
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "5",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    const plain = stripAnsi(stderrBuffer);
    // OpenClaw line should not have the detected marker.
    const lines = plain.split("\n");
    const openclawLine = lines.find((l) => l.includes("1.") && l.includes("OpenClaw"));
    expect(openclawLine).toBeDefined();
    expect(openclawLine).not.toContain("detected locally");
  });

  // --- Option 5: Local MCP / Other ---

  it("runInit option 5 writes config with apiKey and baseUrl only (no agents, no defaultAgent)", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "5",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.apiKey).toBe("mcs_valid_key");
    expect(config.baseUrl).toBe("https://api.multicorn.ai");
    expect(config.agents).toBeUndefined();
    expect(config.defaultAgent).toBeUndefined();

    const writeCalls = writeFileMock.mock.calls.filter(
      (c: unknown[]) => typeof c[1] === "string" && c[1].includes("mcs_valid_key"),
    );
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
    const written = JSON.parse(String(writeCalls[0]?.[1])) as Record<string, unknown>;
    expect(written["apiKey"]).toBe("mcs_valid_key");
    expect(written["baseUrl"]).toBe("https://api.multicorn.ai");
    expect(written["agents"]).toBeUndefined();
    expect(written["defaultAgent"]).toBeUndefined();
    expect(written["agentName"]).toBeUndefined();
    expect(written["platform"]).toBeUndefined();
  });

  it("runInit option 5 does not prompt for target URL", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "5",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    const promptTexts = rlQuestionMock.mock.calls.map((c: unknown[]) => String(c[0]));
    const hasUrlPrompt = promptTexts.some(
      (p: string) => p.includes("URL") && !p.includes("Select"),
    );
    expect(hasUrlPrompt).toBe(false);
  });

  it("runInit option 5 does not prompt for agent name", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "5",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    const promptTexts = rlQuestionMock.mock.calls.map((c: unknown[]) => String(c[0]));
    const hasAgentNamePrompt = promptTexts.some((p: string) => p.includes("call this agent"));
    expect(hasAgentNamePrompt).toBe(false);
  });

  it("runInit option 5 does not call createProxyConfig (no /api/v1/proxy/config POST)", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "5",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    const proxyConfigCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("/api/v1/proxy/config"),
    );
    expect(proxyConfigCalls).toHaveLength(0);
  });

  it("runInit option 5 prints the --wrap example command in success message", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "5",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    expect(stderrBuffer).toContain("npx multicorn-proxy --wrap");
    expect(stderrBuffer).toContain("@modelcontextprotocol/server-filesystem");
  });

  it("runInit option 5 config is loadable by loadConfig", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "5",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    // Extract what was written and feed it back to loadConfig via readFileMock.
    const writeCalls = writeFileMock.mock.calls.filter(
      (c: unknown[]) => typeof c[1] === "string" && c[1].includes("mcs_valid_key"),
    );
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
    const writtenJson = String(writeCalls[0]?.[1]);

    readFileMock.mockResolvedValue(writtenJson);
    const loaded = await loadConfig();

    expect(loaded).not.toBeNull();
    if (!loaded) throw new Error("expected loaded config");
    expect(loaded.apiKey).toBe("mcs_valid_key");
    expect(loaded.baseUrl).toBe("https://api.multicorn.ai");
  });

  it("runInit option 5 summary does not render a trailing dash", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "5",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    const plain = stripAnsi(stderrBuffer);
    expect(plain).toContain("Local MCP / Other");
    expect(plain).not.toContain("Local MCP / Other -");
    expect(plain).not.toMatch(/Local MCP \/ Other\s*-\s*$/m);
  });

  it("runInit option 1 summary renders platform dash agent name correctly", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "my-oc-agent",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    const plain = stripAnsi(stderrBuffer);
    expect(plain).toContain("OpenClaw - my-oc-agent");
  });

  it("runInit option 5 does not print a Next steps block", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "5",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    const plain = stripAnsi(stderrBuffer);
    expect(plain).not.toContain("Next steps");
    expect(plain).not.toContain("Other MCP Agent");
    expect(plain).not.toContain("--agent-name");
  });

  it("runInit option 1 Next steps block still renders correctly", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "my-oc-agent",
      "Connect another": "n",
    });

    await runInit("https://api.multicorn.ai");

    const plain = stripAnsi(stderrBuffer);
    expect(plain).toContain("Next steps");
    expect(plain).toContain("To complete your OpenClaw setup");
    expect(plain).toContain("openclaw gateway restart");
  });

  it("runInit appends a second agent when user connects another platform", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: ["1", "2"],
      "call this agent": ["first-openclaw", "second-claude-code"],
      "Connect another": ["y", "n"],
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.agents?.length).toBe(2);
    expect(config.agents?.map((a) => a.platform)).toEqual(["openclaw", "claude-code"]);
    expect(config.defaultAgent).toBe("second-claude-code");
  });

  it("runInit prompts to replace when platform already exists and updates entry", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) => {
      if (path.includes(".openclaw")) return Promise.resolve(MINIMAL_OPENCLAW_JSON);
      if (path.includes("config.json")) {
        return Promise.resolve(
          JSON.stringify({
            apiKey: "mcs_existing_key1",
            baseUrl: "https://api.multicorn.ai",
            agents: [{ name: "old-openclaw", platform: "openclaw" }],
            defaultAgent: "old-openclaw",
          }),
        );
      }
      return Promise.reject(new Error("ENOENT"));
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "Use this key": "y",
      Select: "1",
      "Replace it?": "y",
      "call this agent": "new-openclaw",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.agents?.length).toBe(1);
    expect(config.agents?.[0]?.name).toBe("new-openclaw");
    expect(config.agents?.[0]?.platform).toBe("openclaw");
    expect(config.defaultAgent).toBe("new-openclaw");
  });

  it("updateOpenClawConfigIfPresent creates agents.list when missing", async () => {
    const openClawConfig = { hooks: { internal: { enabled: true, entries: {} } } };
    readFileMock.mockResolvedValue(JSON.stringify(openClawConfig));
    writeFileMock.mockResolvedValue(undefined);

    const result = await updateOpenClawConfigIfPresent(
      "mcs_key",
      "https://api.multicorn.ai",
      "my-agent",
    );

    expect(result).toBe("updated");
    const written = JSON.parse(String(writeFileMock.mock.calls[0]?.[1])) as Record<string, unknown>;
    const agents = written["agents"] as Record<string, unknown>;
    expect(agents["list"]).toEqual([{ id: "my-agent", name: "my-agent" }]);
  });

  it("updateOpenClawConfigIfPresent overwrites first agent entry", async () => {
    const openClawConfig = {
      hooks: { internal: { enabled: true, entries: {} } },
      agents: { list: [{ id: "old-name", name: "old-name", workspace: "/tmp" }] },
    };
    readFileMock.mockResolvedValue(JSON.stringify(openClawConfig));
    writeFileMock.mockResolvedValue(undefined);

    const result = await updateOpenClawConfigIfPresent(
      "mcs_key",
      "https://api.multicorn.ai",
      "new-name",
    );

    expect(result).toBe("updated");
    const written = JSON.parse(String(writeFileMock.mock.calls[0]?.[1])) as Record<string, unknown>;
    const agents = written["agents"] as Record<string, unknown>;
    const list = agents["list"] as Record<string, unknown>[];
    expect(list[0]?.["id"]).toBe("new-name");
    expect(list[0]?.["name"]).toBe("new-name");
    expect(list[0]?.["workspace"]).toBe("/tmp");
  });

  it("updateOpenClawConfigIfPresent skips agent update when id already matches", async () => {
    const openClawConfig = {
      hooks: { internal: { enabled: true, entries: {} } },
      agents: { list: [{ id: "same-name", name: "same-name" }] },
    };
    readFileMock.mockResolvedValue(JSON.stringify(openClawConfig));
    writeFileMock.mockResolvedValue(undefined);

    await updateOpenClawConfigIfPresent("mcs_key", "https://api.multicorn.ai", "same-name");

    const written = JSON.parse(String(writeFileMock.mock.calls[0]?.[1])) as Record<string, unknown>;
    const agents = written["agents"] as Record<string, unknown>;
    const list = agents["list"] as Record<string, unknown>[];
    expect(list[0]?.["id"]).toBe("same-name");
  });

  it("updateOpenClawConfigIfPresent adds list to existing agents object", async () => {
    const openClawConfig = {
      hooks: { internal: { enabled: true, entries: {} } },
      agents: { some: "field" },
    };
    readFileMock.mockResolvedValue(JSON.stringify(openClawConfig));
    writeFileMock.mockResolvedValue(undefined);

    await updateOpenClawConfigIfPresent("mcs_key", "https://api.multicorn.ai", "my-agent");

    const written = JSON.parse(String(writeFileMock.mock.calls[0]?.[1])) as Record<string, unknown>;
    const agents = written["agents"] as Record<string, unknown>;
    expect(agents["list"]).toEqual([{ id: "my-agent", name: "my-agent" }]);
    expect(agents["some"]).toBe("field");
  });

  it("getClaudeDesktopConfigPath returns platform-appropriate path", () => {
    const path = getClaudeDesktopConfigPath();
    expect(path).toContain("claude_desktop_config.json");
  });

  it("updateClaudeDesktopConfig creates new file when config does not exist", async () => {
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockRejectedValue(enoent);
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);

    const result = await updateClaudeDesktopConfig("my-agent", "npx my-mcp-server");

    expect(result).toBe("created");
    expect(mkdirMock).toHaveBeenCalled();
    const written = JSON.parse(String(writeFileMock.mock.calls[0]?.[1])) as Record<string, unknown>;
    const servers = written["mcpServers"] as Record<string, unknown>;
    const entry = servers["my-agent"] as Record<string, unknown>;
    expect(entry["command"]).toBe("npx");
    const args = entry["args"] as string[];
    expect(args).toContain("multicorn-proxy");
    expect(args).toContain("--wrap");
    expect(args).toContain("my-mcp-server");
  });

  it("updateClaudeDesktopConfig merges into existing config without clobbering other entries", async () => {
    const existing = JSON.stringify({
      mcpServers: { "other-server": { command: "node", args: ["server.js"] } },
      someOtherKey: true,
    });
    readFileMock.mockResolvedValue(existing);
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);

    const result = await updateClaudeDesktopConfig("my-agent", "npx my-mcp-server");

    expect(result).toBe("updated");
    const written = JSON.parse(String(writeFileMock.mock.calls[0]?.[1])) as Record<string, unknown>;
    const servers = written["mcpServers"] as Record<string, unknown>;
    expect(servers["other-server"]).toBeDefined();
    expect(servers["my-agent"]).toBeDefined();
    expect(written["someOtherKey"]).toBe(true);
  });

  it("updateClaudeDesktopConfig returns parse-error for invalid JSON", async () => {
    readFileMock.mockResolvedValue("{ broken json }");
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);

    const result = await updateClaudeDesktopConfig("my-agent", "npx my-server");

    expect(result).toBe("parse-error");
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("updateClaudeDesktopConfig returns skipped when agent already exists and overwrite is false", async () => {
    const existing = JSON.stringify({
      mcpServers: { "my-agent": { command: "npx", args: ["old-server"] } },
    });
    readFileMock.mockResolvedValue(existing);
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);

    const result = await updateClaudeDesktopConfig("my-agent", "npx new-server");

    expect(result).toBe("skipped");
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("updateClaudeDesktopConfig overwrites existing agent when overwrite is true", async () => {
    const existing = JSON.stringify({
      mcpServers: { "my-agent": { command: "npx", args: ["old-server"] } },
    });
    readFileMock.mockResolvedValue(existing);
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);

    const result = await updateClaudeDesktopConfig("my-agent", "npx new-server", true);

    expect(result).toBe("updated");
    const written = JSON.parse(String(writeFileMock.mock.calls[0]?.[1])) as Record<string, unknown>;
    const servers = written["mcpServers"] as Record<string, unknown>;
    const entry = servers["my-agent"] as Record<string, unknown>;
    const args = entry["args"] as string[];
    expect(args).toContain("new-server");
  });

  it("updateClaudeDesktopConfig splits multi-word command into separate args", async () => {
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockRejectedValue(enoent);
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);

    await updateClaudeDesktopConfig("my-agent", "node dist/server.js --port 3000");

    const written = JSON.parse(String(writeFileMock.mock.calls[0]?.[1])) as Record<string, unknown>;
    const servers = written["mcpServers"] as Record<string, unknown>;
    const entry = servers["my-agent"] as Record<string, unknown>;
    const args = entry["args"] as string[];
    expect(args).toEqual([
      "multicorn-proxy",
      "--wrap",
      "node",
      "dist/server.js",
      "--port",
      "3000",
      "--agent-name",
      "my-agent",
    ]);
  });

  it("updateClaudeDesktopConfig creates mcpServers key when file exists without it", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ someConfig: true }));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);

    const result = await updateClaudeDesktopConfig("my-agent", "npx my-server");

    expect(result).toBe("updated");
    const written = JSON.parse(String(writeFileMock.mock.calls[0]?.[1])) as Record<string, unknown>;
    expect(written["someConfig"]).toBe(true);
    const servers = written["mcpServers"] as Record<string, unknown>;
    expect(servers["my-agent"]).toBeDefined();
  });

  it("updateClaudeDesktopConfig throws on invalid agent name", async () => {
    await expect(updateClaudeDesktopConfig("bad name!", "npx my-server")).rejects.toThrow(
      "Agent name must contain only letters, numbers, hyphens, and underscores",
    );
  });

  it("updateClaudeDesktopConfig rethrows non-ENOENT read errors", async () => {
    readFileMock.mockRejectedValue(new Error("EACCES: permission denied"));

    await expect(updateClaudeDesktopConfig("my-agent", "npx my-server")).rejects.toThrow("EACCES");
  });

  it("runInit handles save config failure gracefully", async () => {
    captureStderr();
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockRejectedValue(new Error("disk full"));
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(MINIMAL_OPENCLAW_JSON)
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "test-agent",
      "Connect another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    expect(stderrBuffer).toContain("Failed to save config");
  });
});

describe("consent edge cases", () => {
  const originalFetch = globalThis.fetch;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    vi.resetAllMocks();
    global.fetch = originalFetch;
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    spawnMock.mockImplementation(() => ({ unref: vi.fn() }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
    spawnMock.mockReset();
  });

  it("resolveAgentRecord returns cached scopes when registration fails after empty agent list", async () => {
    const apiKey = "mcs_key";
    const agentName = "test-agent";
    const cacheKey = createHash("sha256")
      .update(`${agentName}:${apiKey}`)
      .digest("hex")
      .slice(0, 16);
    const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
    const cache = {
      [cacheKey]: {
        agentId: "cached-id",
        scopes: [
          { service: "gmail", permissionLevel: "execute" },
          { service: "calendar", permissionLevel: "read" },
        ],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    readFileMock.mockImplementation((path: string) => {
      if (path.includes("cache-meta")) {
        return Promise.resolve(JSON.stringify({ apiKeyHash }));
      }
      if (path.includes("scopes.json")) {
        return Promise.resolve(JSON.stringify(cache));
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      })
      .mockRejectedValueOnce(new Error("network error"));
    global.fetch = fetchMock;

    const logger = createLogger("error");
    const record = await resolveAgentRecord(agentName, apiKey, "https://api.multicorn.ai", logger);

    expect(record.name).toBe("test-agent");
    expect(record.scopes).toHaveLength(2);
    expect(record.scopes).toContainEqual({ service: "gmail", permissionLevel: "execute" });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("resolveAgentRecord falls back to offline mode when registerAgent gets an unexpected response format", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ unexpectedShape: true }),
      });

    const logger = createLogger("error");
    const record = await resolveAgentRecord(
      "test-agent",
      "mcs_key",
      "https://api.multicorn.ai",
      logger,
    );

    expect(record.id).toBe("");
    expect(record.scopes).toHaveLength(0);
  });

  it("resolveAgentRecord falls back to offline mode when registerAgent response is missing agent ID", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { name: "test-agent" } }),
      });

    const logger = createLogger("error");
    const record = await resolveAgentRecord(
      "test-agent",
      "mcs_key",
      "https://api.multicorn.ai",
      logger,
    );

    expect(record.id).toBe("");
    expect(record.scopes).toHaveLength(0);
  });

  it(
    "waitForConsent opens the consent page and returns scopes after polling",
    { timeout: 15000 },
    async () => {
      const stderrWriteSpy = vi.fn().mockReturnValue(true);
      process.stderr.write = stderrWriteSpy as typeof process.stderr.write;

      let pollCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        pollCount += 1;
        if (pollCount <= 1) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                data: { permissions: [] },
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: {
                permissions: [
                  { service: "gmail", read: true, write: false, execute: true, revoked_at: null },
                ],
              },
            }),
        });
      });

      const logger = createLogger("error");
      const scopes = await waitForConsent(
        "agent-1",
        "test-agent",
        "mcs_key",
        "https://api.multicorn.ai",
        "https://app.multicorn.ai",
        logger,
      );

      expect(scopes.length).toBeGreaterThan(0);
      expect(scopes).toContainEqual({ service: "gmail", permissionLevel: "execute" });
      const stderrOutput = stderrWriteSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(stderrOutput).toContain("https://app.multicorn.ai/consent?");
      expect(stderrOutput).toContain("agent=test-agent");
    },
  );
});

describe("service unavailable", () => {
  let mockService: MockMulticornService | null = null;
  let fakeStdin: PassThrough;
  let stdoutBuffer: string;
  let proxy: ProxyServer;
  let startPromise: Promise<void>;
  const originalStdin = process.stdin;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  interface OfflineSetupOptions {
    baseUrl: string;
    scopeRefreshIntervalMs?: number;
  }

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

  function createProxy(options: OfflineSetupOptions, mcpCommand: string, mcpArgs: string[]): void {
    proxy = createProxyServer({
      command: mcpCommand,
      commandArgs: mcpArgs,
      apiKey: "test-key",
      agentName: "test-agent",
      baseUrl: options.baseUrl,
      dashboardUrl: deriveDashboardUrl(options.baseUrl),
      logger: createLogger("warn"),
      ...(options.scopeRefreshIntervalMs !== undefined && {
        scopeRefreshIntervalMs: options.scopeRefreshIntervalMs,
      }),
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
    if (mockService !== null) {
      await mockService.stop();
      mockService = null;
    }
  });

  it("falls back to offline mode and blocks all tool calls when the service is unreachable at startup", async () => {
    const { mcpCommand, mcpArgs } = await setupStdio();
    createProxy({ baseUrl: "http://localhost:1" }, mcpCommand, mcpArgs);

    startPromise = proxy.start();

    // The proxy should start even though the service is unreachable.
    // resolveAgentRecord catches errors and falls back to offline mode.
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

    expect(response["jsonrpc"]).toBe("2.0");
    expect(response["id"]).toBe(1);
    expect(response["error"]).toBeDefined();
    expect(response["result"]).toBeUndefined();

    const error = response["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(-32003);
  });

  it(
    "continues running after scope refresh encounters a network error",
    { timeout: 15000 },
    async () => {
      mockService = await startMockMulticornService();
      const baseUrl = mockService.baseUrl.replace("127.0.0.1", "localhost");

      const { mcpCommand, mcpArgs } = await setupStdio();
      createProxy({ baseUrl, scopeRefreshIntervalMs: 100 }, mcpCommand, mcpArgs);

      startPromise = proxy.start();
      await waitFor(() => mockService !== null && mockService.requests.length >= 2);

      // Verify initial tool call succeeds with active scopes.
      sendJsonRpc({
        jsonrpc: "2.0",
        id: 1,
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

      // Stop the mock service to simulate it going down mid-session.
      await mockService.stop();
      mockService = null;

      // Wait for at least one failed scope refresh cycle.
      await sleep(300);

      // The proxy should still be running. Verify with a non-intercepted request
      // (tools/list passes straight through to the child without scope checks).
      stdoutBuffer = "";
      sendJsonRpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });

      await waitFor(() => getStdoutLines().length >= 1);

      const secondLine = getStdoutLines()[0] ?? "";
      const secondResponse = JSON.parse(secondLine) as Record<string, unknown>;
      expect(secondResponse["jsonrpc"]).toBe("2.0");
      expect(secondResponse["id"]).toBe(2);
      const result = secondResponse["result"] as Record<string, unknown>;
      const tools = result["tools"] as Record<string, unknown>[];
      expect(tools.length).toBeGreaterThan(0);
    },
  );

  it(
    "does not crash when the action logging endpoint is unreachable",
    { timeout: 15000 },
    async () => {
      mockService = await startMockMulticornService();
      const baseUrl = mockService.baseUrl.replace("127.0.0.1", "localhost");

      const { mcpCommand, mcpArgs } = await setupStdio();
      createProxy({ baseUrl }, mcpCommand, mcpArgs);

      startPromise = proxy.start();
      await waitFor(() => mockService !== null && mockService.requests.length >= 2);

      // Stop the mock service so the action logging POST will fail.
      await mockService.stop();
      mockService = null;

      sendJsonRpc({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "gmail_send_email",
          arguments: { to: "user@example.com", subject: "Hi", body: "Hello" },
        },
      });

      // The proxy should still forward the tool call to the child and return a response,
      // even though the action logger cannot reach its endpoint.
      await waitFor(() => getStdoutLines().length >= 1);

      const line = getStdoutLines()[0] ?? "";
      const response = JSON.parse(line) as Record<string, unknown>;
      expect(response["jsonrpc"]).toBe("2.0");
      expect(response["id"]).toBe(1);
    },
  );
});
