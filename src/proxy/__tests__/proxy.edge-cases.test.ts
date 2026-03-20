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
import { loadConfig, validateApiKey, runInit, updateOpenClawConfigIfPresent } from "../config.js";
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
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw") ? Promise.reject(enoent) : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "4",
      "call this agent": "test-agent",
      "configure another": "n",
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
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw") ? Promise.reject(enoent) : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": ["", "mcs_second_try"],
      Select: "4",
      "call this agent": "test-agent",
      "configure another": "n",
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
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw") ? Promise.reject(enoent) : Promise.reject(new Error("ENOENT")),
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
      Select: "4",
      "call this agent": "test-agent",
      "configure another": "n",
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
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw") ? Promise.reject(enoent) : Promise.reject(new Error("ENOENT")),
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
      Select: "4",
      "call this agent": "test-agent",
      "configure another": "n",
    });

    const config = await runInit();

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.baseUrl).toBe("https://api.multicorn.ai");
    expect(config.apiKey).toBe("mcs_second");
  });

  it("runInit updates OpenClaw config when file exists", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const openClawConfig = {
      meta: { lastTouchedVersion: "2026.2.26" },
      hooks: { internal: { enabled: true, entries: {} } },
    };
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(JSON.stringify(openClawConfig))
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "test-agent",
      "configure another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.apiKey).toBe("mcs_valid_key");
    expect(stderrBuffer).toContain("OpenClaw config updated");
    const openclawWrite = writeFileMock.mock.calls.find((c) => String(c[0]).includes(".openclaw"));
    expect(openclawWrite).toBeDefined();
    if (!openclawWrite) throw new Error("expected openclaw write call");
    const written = JSON.parse(String(openclawWrite[1])) as Record<string, unknown>;
    const hooks = written["hooks"] as Record<string, unknown>;
    const internal = hooks["internal"] as Record<string, unknown>;
    const entries = internal["entries"] as Record<string, unknown>;
    const shield = entries["multicorn-shield"] as Record<string, unknown>;
    expect(shield["env"]).toEqual({
      MULTICORN_API_KEY: "mcs_valid_key",
      MULTICORN_BASE_URL: "https://api.multicorn.ai",
      MULTICORN_AGENT_NAME: "test-agent",
    });
  });

  it("runInit logs warning when OpenClaw config exists but is malformed JSON", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve("{ invalid }")
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "test-agent",
      "configure another": "n",
    });

    await runInit("https://api.multicorn.ai");

    expect(stderrBuffer).toContain("Could not update OpenClaw config");
  });

  it("runInit reuses existing API key when user accepts", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const existingConfig = JSON.stringify({
      apiKey: "mcs_existing_key1",
      baseUrl: "https://api.multicorn.ai",
    });
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockImplementation((path: string) => {
      if (path.includes(".openclaw")) return Promise.reject(enoent);
      if (path.includes("config.json")) return Promise.resolve(existingConfig);
      return Promise.reject(new Error("ENOENT"));
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "Use this key": "y",
      Select: "4",
      "call this agent": "test-agent",
      "configure another": "n",
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
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockImplementation((path: string) => {
      if (path.includes(".openclaw")) return Promise.reject(enoent);
      if (path.includes("config.json")) return Promise.resolve(existingConfig);
      return Promise.reject(new Error("ENOENT"));
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "Use this key": "n",
      "API key": "mcs_new_key",
      Select: "4",
      "call this agent": "my-agent",
      "configure another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.apiKey).toBe("mcs_new_key");
  });

  it("runInit normalizes agent name with spaces and uppercase", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw") ? Promise.reject(enoent) : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "4",
      "call this agent": "My Cool Agent!",
      "configure another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.agentName).toBe("my-cool-agent");
    expect(stderrBuffer).toContain("Agent name set to:");
  });

  it("runInit re-prompts when agent name normalizes to empty", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw") ? Promise.reject(enoent) : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "4",
      "call this agent": ["---", "valid-name"],
      "configure another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    if (!config) throw new Error("expected config");
    expect(config.agentName).toBe("valid-name");
    expect(stderrBuffer).toContain("must contain letters or numbers");
  });

  it("runInit shows Claude Code instructions for platform 2", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw") ? Promise.reject(enoent) : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "2",
      "call this agent": "my-agent",
      "configure another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    expect(stderrBuffer).toContain("claude plugin marketplace add");
    expect(stderrBuffer).toContain("claude plugin install multicorn-shield@multicorn-shield");
    expect(stderrBuffer).toContain("Claude Code setup");
  });

  it("runInit shows Claude Desktop config snippet for platform 3", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw") ? Promise.reject(enoent) : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "3",
      "call this agent": "my-agent",
      "configure another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    expect(stderrBuffer).toContain("claude_desktop_config.json");
    expect(stderrBuffer).toContain("mcpServers");
    expect(stderrBuffer).toContain("my-agent");
    expect(stderrBuffer).toContain("Claude Desktop setup");
  });

  it("runInit returns null when OpenClaw is not installed", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockImplementation(() => Promise.reject(enoent));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "test-agent",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).toBeNull();
    expect(stderrBuffer).toContain("OpenClaw is not installed");
  });

  it("runInit warns on old OpenClaw version and allows continuing", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const openClawConfig = {
      meta: { lastTouchedVersion: "2025.1.1" },
      hooks: { internal: { enabled: true, entries: {} } },
    };
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(JSON.stringify(openClawConfig))
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "test-agent",
      "Continue anyway": "y",
      "configure another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    expect(stderrBuffer).toContain("may work but is untested");
    expect(stderrBuffer).toContain("OpenClaw config updated");
  });

  it("runInit returns null when user declines old OpenClaw version", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const openClawConfig = {
      meta: { lastTouchedVersion: "2025.1.1" },
      hooks: { internal: { enabled: true, entries: {} } },
    };
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(JSON.stringify(openClawConfig))
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "test-agent",
      "Continue anyway": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).toBeNull();
  });

  it("runInit handles OpenClaw with no version in meta", async () => {
    captureStderr();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    const openClawConfig = {
      hooks: { internal: { enabled: true, entries: {} } },
    };
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw")
        ? Promise.resolve(JSON.stringify(openClawConfig))
        : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "1",
      "call this agent": "test-agent",
      "configure another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    expect(stderrBuffer).toContain("Could not detect OpenClaw version");
    expect(stderrBuffer).toContain("OpenClaw config updated");
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

  it("runInit handles save config failure gracefully", async () => {
    captureStderr();
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockRejectedValue(new Error("disk full"));
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    readFileMock.mockImplementation((path: string) =>
      path.includes(".openclaw") ? Promise.reject(enoent) : Promise.reject(new Error("ENOENT")),
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    mockPrompts({
      "API key": "mcs_valid_key",
      Select: "4",
      "call this agent": "test-agent",
      "configure another": "n",
    });

    const config = await runInit("https://api.multicorn.ai");

    expect(config).not.toBeNull();
    expect(stderrBuffer).toContain("Failed to save config");
  });
});

describe("consent edge cases", () => {
  const originalFetch = global.fetch;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    vi.resetAllMocks();
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

  it("resolveAgentRecord returns cached scopes without contacting the service", async () => {
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

    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    const logger = createLogger("error");
    const record = await resolveAgentRecord(agentName, apiKey, "https://api.multicorn.ai", logger);

    expect(record.name).toBe("test-agent");
    expect(record.scopes).toHaveLength(2);
    expect(record.scopes).toContainEqual({ service: "gmail", permissionLevel: "execute" });
    expect(fetchSpy).not.toHaveBeenCalled();
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
