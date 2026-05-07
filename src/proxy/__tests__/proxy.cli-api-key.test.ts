/**
 * Tests for --api-key flag and MULTICORN_API_KEY env var support on --wrap.
 *
 * Verifies:
 * 1. parseArgs extracts --api-key from CLI flags (before and after --wrap)
 * 2. resolveWrapConfig respects priority: CLI flag > env var > config file
 * 3. Error message mentions all three key sources when none is found
 * 4. Integration: --wrap starts up with env var API key and no config file
 *
 * @vitest-environment node
 * @module proxy/__tests__/proxy.cli-api-key.test
 */

import { PassThrough } from "node:stream";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { parseArgs, resolveWrapConfig, type CliArgs } from "../../../bin/multicorn-shield.js";
import { DEFAULT_SHIELD_API_BASE_URL } from "../config.js";
import { createProxyServer, type ProxyServer } from "../index.js";
import { createLogger } from "../logger.js";
import { deriveDashboardUrl } from "../consent.js";
import { startMockMcpServer } from "../__fixtures__/mockMcpServer.js";
import {
  startMockMulticornService,
  type MockMulticornService,
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

// ---------------------------------------------------------------------------
// parseArgs: --api-key extraction
// ---------------------------------------------------------------------------

describe("parseArgs --api-key", () => {
  it("extracts --api-key before --wrap", () => {
    const result = parseArgs([
      "node",
      "multicorn-shield",
      "--api-key",
      "mcs_test123",
      "--wrap",
      "my-server",
    ]);
    expect(result.apiKey).toBe("mcs_test123");
    expect(result.subcommand).toBe("wrap");
    expect(result.wrapCommand).toBe("my-server");
  });

  it("extracts --api-key placed between --wrap and the command", () => {
    const result = parseArgs([
      "node",
      "multicorn-shield",
      "--wrap",
      "--api-key",
      "mcs_fromwrap",
      "npx",
      "@mcp/server-filesystem",
      "/tmp",
    ]);
    expect(result.apiKey).toBe("mcs_fromwrap");
    expect(result.wrapCommand).toBe("npx");
    expect(result.wrapArgs).toEqual(["@mcp/server-filesystem", "/tmp"]);
  });

  it("returns undefined apiKey when --api-key is not provided", () => {
    const result = parseArgs(["node", "multicorn-shield", "--wrap", "my-server"]);
    expect(result.apiKey).toBeUndefined();
  });

  it("does not strip flags that appear after the wrap command token", () => {
    const result = parseArgs([
      "node",
      "multicorn-shield",
      "--wrap",
      "server",
      "--api-key",
      "mcs_key123",
      "--",
      "extra",
    ]);
    expect(result.apiKey).toBeUndefined();
    expect(result.wrapCommand).toBe("server");
    expect(result.wrapArgs).toEqual(["--api-key", "mcs_key123", "--", "extra"]);
  });
});

describe("parseArgs --verbose", () => {
  it("sets verbose when --verbose appears with init", () => {
    const result = parseArgs(["node", "multicorn-shield", "init", "--verbose"]);
    expect(result.subcommand).toBe("init");
    expect(result.verbose).toBe(true);
  });

  it("defaults verbose to false for init", () => {
    const result = parseArgs(["node", "multicorn-shield", "init"]);
    expect(result.verbose).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseArgs: --wrap flag/command ordering
// ---------------------------------------------------------------------------

describe("parseArgs --wrap flag ordering", () => {
  it("flags before --wrap (regression guard)", () => {
    const result = parseArgs([
      "node",
      "multicorn-shield",
      "--api-key",
      "mcs_x",
      "--base-url",
      "http://localhost:8080",
      "--wrap",
      "npx",
      "@modelcontextprotocol/server-filesystem",
      "/tmp",
    ]);
    expect(result.subcommand).toBe("wrap");
    expect(result.wrapCommand).toBe("npx");
    expect(result.wrapArgs).toEqual(["@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(result.apiKey).toBe("mcs_x");
    expect(result.baseUrl).toBe("http://localhost:8080");
  });

  it("flags after --wrap, before command (the bug fix)", () => {
    const result = parseArgs([
      "node",
      "multicorn-shield",
      "--wrap",
      "--api-key",
      "mcs_x",
      "--base-url",
      "http://localhost:8080",
      "npx",
      "@modelcontextprotocol/server-filesystem",
      "/tmp",
    ]);
    expect(result.subcommand).toBe("wrap");
    expect(result.wrapCommand).toBe("npx");
    expect(result.wrapArgs).toEqual(["@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(result.apiKey).toBe("mcs_x");
    expect(result.baseUrl).toBe("http://localhost:8080");
  });

  it("single flag after --wrap (--api-key only)", () => {
    const result = parseArgs([
      "node",
      "multicorn-shield",
      "--wrap",
      "--api-key",
      "mcs_x",
      "npx",
      "@modelcontextprotocol/server-filesystem",
      "/tmp",
    ]);
    expect(result.subcommand).toBe("wrap");
    expect(result.wrapCommand).toBe("npx");
    expect(result.wrapArgs).toEqual(["@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(result.apiKey).toBe("mcs_x");
  });

  it("single flag after --wrap (--base-url only)", () => {
    const result = parseArgs([
      "node",
      "multicorn-shield",
      "--wrap",
      "--base-url",
      "http://localhost:8080",
      "npx",
      "@modelcontextprotocol/server-filesystem",
      "/tmp",
    ]);
    expect(result.subcommand).toBe("wrap");
    expect(result.wrapCommand).toBe("npx");
    expect(result.wrapArgs).toEqual(["@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(result.baseUrl).toBe("http://localhost:8080");
  });

  it("child command's own flags are forwarded, not consumed", () => {
    const result = parseArgs([
      "node",
      "multicorn-shield",
      "--wrap",
      "npx",
      "some-server",
      "--port",
      "3000",
    ]);
    expect(result.subcommand).toBe("wrap");
    expect(result.wrapCommand).toBe("npx");
    expect(result.wrapArgs).toEqual(["some-server", "--port", "3000"]);
    expect(result.apiKey).toBeUndefined();
  });

  it("proxy flag stripped, child flag forwarded in same argv", () => {
    const result = parseArgs([
      "node",
      "multicorn-shield",
      "--wrap",
      "--api-key",
      "mcs_x",
      "npx",
      "some-server",
      "--port",
      "3000",
    ]);
    expect(result.subcommand).toBe("wrap");
    expect(result.wrapCommand).toBe("npx");
    expect(result.wrapArgs).toEqual(["some-server", "--port", "3000"]);
    expect(result.apiKey).toBe("mcs_x");
  });

  it("flags split across both sides of --wrap", () => {
    const result = parseArgs([
      "node",
      "multicorn-shield",
      "--api-key",
      "mcs_x",
      "--wrap",
      "--base-url",
      "http://localhost:8080",
      "npx",
      "some-server",
    ]);
    expect(result.subcommand).toBe("wrap");
    expect(result.wrapCommand).toBe("npx");
    expect(result.wrapArgs).toEqual(["some-server"]);
    expect(result.apiKey).toBe("mcs_x");
    expect(result.baseUrl).toBe("http://localhost:8080");
  });
});

// ---------------------------------------------------------------------------
// resolveWrapConfig: priority and fallback
// ---------------------------------------------------------------------------

describe("resolveWrapConfig", () => {
  const silentLogger = createLogger("error");
  const originalEnv = process.env["MULTICORN_API_KEY"];
  const originalExit = (...args: Parameters<typeof process.exit>): never => process.exit(...args);
  let stderrBuffer: string;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  function captureStderr(): void {
    stderrBuffer = "";
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

  function makeCli(overrides: Partial<CliArgs> = {}): CliArgs {
    return {
      subcommand: "wrap",
      wrapCommand: "my-server",
      wrapArgs: [],
      logLevel: "info",
      baseUrl: undefined,
      dashboardUrl: "",
      agentName: "",
      deleteAgentName: "",
      apiKey: undefined,
      verbose: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env["MULTICORN_API_KEY"];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["MULTICORN_API_KEY"] = originalEnv;
    } else {
      delete process.env["MULTICORN_API_KEY"];
    }
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  });

  it("uses --api-key flag when provided (no config file needed)", async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const config = await resolveWrapConfig(makeCli({ apiKey: "mcs_flag_key_12" }), silentLogger);

    expect(config.apiKey).toBe("mcs_flag_key_12");
    expect(config.baseUrl).toBe(DEFAULT_SHIELD_API_BASE_URL);
  });

  it("uses MULTICORN_API_KEY env var when no --api-key flag and no config file", async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    process.env["MULTICORN_API_KEY"] = "mcs_env_key_123";

    const config = await resolveWrapConfig(makeCli(), silentLogger);

    expect(config.apiKey).toBe("mcs_env_key_123");
    expect(config.baseUrl).toBe(DEFAULT_SHIELD_API_BASE_URL);
  });

  it("falls back to config file when neither flag nor env var is set", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({ apiKey: "mcs_from_config_", baseUrl: "https://api.multicorn.ai" }),
    );

    const config = await resolveWrapConfig(makeCli(), silentLogger);

    expect(config.apiKey).toBe("mcs_from_config_");
  });

  it("CLI flag takes precedence over env var", async () => {
    process.env["MULTICORN_API_KEY"] = "mcs_env_key_123";
    readFileMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const config = await resolveWrapConfig(makeCli({ apiKey: "mcs_flag_key_12" }), silentLogger);

    expect(config.apiKey).toBe("mcs_flag_key_12");
  });

  it("env var takes precedence over config file", async () => {
    process.env["MULTICORN_API_KEY"] = "mcs_env_key_123";
    readFileMock.mockResolvedValue(
      JSON.stringify({ apiKey: "mcs_from_config_", baseUrl: "https://api.multicorn.ai" }),
    );

    const config = await resolveWrapConfig(makeCli(), silentLogger);

    expect(config.apiKey).toBe("mcs_env_key_123");
  });

  it("uses --base-url from CLI when key comes from flag", async () => {
    const config = await resolveWrapConfig(
      makeCli({ apiKey: "mcs_flag_key_12", baseUrl: "https://custom.example.com" }),
      silentLogger,
    );

    expect(config.baseUrl).toBe("https://custom.example.com");
  });

  it("exits with descriptive error mentioning all three sources when none found", async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    captureStderr();

    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${String(code)})`);
    }) as never;

    await expect(resolveWrapConfig(makeCli(), silentLogger)).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    expect(stderrBuffer).toContain("--api-key");
    expect(stderrBuffer).toContain("MULTICORN_API_KEY");
    expect(stderrBuffer).toContain("npx multicorn-shield init");
  });
});

// ---------------------------------------------------------------------------
// Integration: --wrap with env var API key and mock MCP server
// ---------------------------------------------------------------------------

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

describe("--wrap integration with env-var API key", () => {
  let mockService: MockMulticornService | null = null;
  let fakeStdin: PassThrough | null = null;
  let stdoutBuffer: string;
  let proxy: ProxyServer | null = null;
  let startPromise: Promise<void> | null = null;
  const originalStdin = process.stdin;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  afterEach(async () => {
    if (fakeStdin !== null && !fakeStdin.destroyed) {
      fakeStdin.end();
    }
    if (proxy !== null) {
      await proxy.stop();
      await startPromise?.catch(() => undefined);
    }
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
    process.stdout.write = originalStdoutWrite;
    vi.restoreAllMocks();
    if (mockService !== null) {
      await mockService.stop();
    }
  });

  it("starts up and intercepts tool calls with only an env-var API key", async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);

    const service = await startMockMulticornService();
    mockService = service;
    const baseUrl = service.baseUrl.replace("127.0.0.1", "localhost");

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
      apiKey: "mcs_env_test_key",
      agentName: "env-test-agent",
      baseUrl,
      dashboardUrl: deriveDashboardUrl(baseUrl),
      logger: createLogger("error"),
    });

    startPromise = proxy.start();
    await waitFor(() => service.requests.length >= 2);

    fakeStdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "gmail_send_email",
          arguments: { to: "user@example.com", subject: "Hi", body: "Hello" },
        },
      }) + "\n",
    );

    await waitFor(() => stdoutBuffer.split("\n").filter((l) => l.trim().length > 0).length >= 1);

    const lines = stdoutBuffer.split("\n").filter((l) => l.trim().length > 0);
    const response = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(response["jsonrpc"]).toBe("2.0");
    expect(response["id"]).toBe(1);
  });
});
