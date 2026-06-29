import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const testMulticornHome = vi.hoisted(() => {
  const dir = `/tmp/shield-files-defects-${String(process.pid)}`;
  process.env["MULTICORN_HOME"] = dir;
  return dir;
});

const DEAD_PID = 2_000_000;

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

vi.mock("../proxy/config.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vitest importOriginal generic
  const actual = await importOriginal<typeof import("../proxy/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(actual.loadConfig),
    readBaseUrlFromConfig: vi.fn(actual.readBaseUrlFromConfig),
  };
});

vi.mock("node:net", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vitest importOriginal generic
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createConnection: () => {
      const sock = new EventEmitter();
      queueMicrotask(() => {
        sock.emit("error", new Error("ECONNREFUSED"));
      });
      return sock;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vitest importOriginal generic
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("./local-proxy-start.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vitest importOriginal generic
  const actual = await importOriginal<typeof import("./local-proxy-start.js")>();
  const fakeServerEntry = join(import.meta.dirname, "__fixtures__", "fake-server.js");
  return {
    ...actual,
    LOCAL_PROXY_READY_MAX_POLLS: 2,
    LOCAL_PROXY_READY_POLL_MS: 1,
    buildLocalProxySpawnCommand: vi.fn((port: number, apiBaseUrl: string) =>
      actual.buildLocalProxySpawnCommand(port, apiBaseUrl, process.execPath, fakeServerEntry),
    ),
  };
});

import { spawn } from "node:child_process";
import { buildLocalProxySpawnCommand } from "./local-proxy-start.js";
import { loadConfig, readBaseUrlFromConfig } from "../proxy/config.js";
import type * as FilesModule from "./files.js";

describe("resolveBaseUrl (Fix 1: base URL precedence)", () => {
  let resolveBaseUrl: typeof FilesModule.resolveBaseUrl;
  const originalEnvBaseUrl = process.env["MULTICORN_BASE_URL"];

  beforeAll(async () => {
    ({ resolveBaseUrl } = await import("./files.js"));
  });

  beforeEach(() => {
    vi.mocked(loadConfig).mockReset();
    vi.mocked(readBaseUrlFromConfig).mockReset();
    delete process.env["MULTICORN_BASE_URL"];
  });

  afterEach(() => {
    if (originalEnvBaseUrl === undefined) {
      delete process.env["MULTICORN_BASE_URL"];
    } else {
      process.env["MULTICORN_BASE_URL"] = originalEnvBaseUrl;
    }
  });

  it("prefers --base-url over MULTICORN_BASE_URL, config.json, and default", async () => {
    process.env["MULTICORN_BASE_URL"] = "https://env.example.com";
    vi.mocked(loadConfig).mockResolvedValue({
      apiKey: "mcs_test_key_12",
      baseUrl: "https://config.example.com",
    });
    vi.mocked(readBaseUrlFromConfig).mockResolvedValue("https://partial.example.com");

    await expect(resolveBaseUrl("http://localhost:8080")).resolves.toBe("http://localhost:8080");
  });

  it("uses MULTICORN_BASE_URL when --base-url is omitted", async () => {
    process.env["MULTICORN_BASE_URL"] = "http://localhost:9090";
    vi.mocked(loadConfig).mockResolvedValue({
      apiKey: "mcs_test_key_12",
      baseUrl: "https://config.example.com",
    });
    vi.mocked(readBaseUrlFromConfig).mockResolvedValue("https://partial.example.com");

    await expect(resolveBaseUrl(undefined)).resolves.toBe("http://localhost:9090");
  });

  it("falls back to config.json baseUrl when env is unset", async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      apiKey: "mcs_test_key_12",
      baseUrl: "http://localhost:8080",
    });
    vi.mocked(readBaseUrlFromConfig).mockResolvedValue(undefined);

    await expect(resolveBaseUrl(undefined)).resolves.toBe("http://localhost:8080");
  });

  it("uses production default when nothing else is configured", async () => {
    vi.mocked(loadConfig).mockResolvedValue(null);
    vi.mocked(readBaseUrlFromConfig).mockResolvedValue(undefined);

    await expect(resolveBaseUrl(undefined)).resolves.toBe("https://api.multicorn.ai");
  });
});

describe("ensureProxy spawn env (Fix 1: SHIELD_API_BASE_URL on proxy)", () => {
  let ensureProxyForTests: (
    proxyPort: number,
    apiBaseUrl: string,
    options?: { forceRespawn?: boolean },
  ) => Promise<unknown>;

  beforeEach(async () => {
    vi.resetModules();
    ({ ensureProxyForTests } = await import("./files.js"));

    mkdirSync(testMulticornHome, { recursive: true });

    const fakeChild = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void };
    fakeChild.pid = 5151;
    fakeChild.unref = vi.fn();

    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);
    vi.mocked(buildLocalProxySpawnCommand).mockClear();

    let healthChecks = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
      const url = fetchInputUrl(input);
      if (url.includes("/health")) {
        healthChecks += 1;
        if (healthChecks >= 2) {
          return Promise.resolve(
            new Response(JSON.stringify({ version: "test" }), { status: 200 }),
          );
        }
      }
      return Promise.reject(new Error("connection refused"));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(testMulticornHome)) {
      rmSync(testMulticornHome, { recursive: true, force: true });
    }
  });

  it("passes the resolved api base URL into SHIELD_API_BASE_URL when spawning the proxy", async () => {
    await ensureProxyForTests(59997, "http://localhost:8080");

    expect(vi.mocked(buildLocalProxySpawnCommand)).toHaveBeenCalledWith(
      59997,
      "http://localhost:8080",
    );
    const spawnCmd = vi.mocked(buildLocalProxySpawnCommand).mock.results[0]?.value as
      | { env: { SHIELD_API_BASE_URL: string } }
      | undefined;
    expect(spawnCmd?.env.SHIELD_API_BASE_URL).toBe("http://localhost:8080");
  });
});

describe("ensureProxy forceRespawn (Fix 2: restart respawns stale proxy)", () => {
  let ensureProxyForTests: (
    proxyPort: number,
    apiBaseUrl: string,
    options?: { forceRespawn?: boolean },
  ) => Promise<{ reused: boolean }>;

  beforeEach(async () => {
    vi.resetModules();
    ({ ensureProxyForTests } = await import("./files.js"));

    mkdirSync(testMulticornHome, { recursive: true });
    writeFileSync(
      join(testMulticornHome, "proxy.json"),
      JSON.stringify({ pid: DEAD_PID, port: 59996 }),
      "utf8",
    );

    const fakeChild = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void };
    fakeChild.pid = 6161;
    fakeChild.unref = vi.fn();
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);
    vi.mocked(buildLocalProxySpawnCommand).mockClear();

    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
      const url = fetchInputUrl(input);
      if (url.includes("/health")) {
        return Promise.resolve(new Response(JSON.stringify({ version: "test" }), { status: 200 }));
      }
      return Promise.reject(new Error("unexpected fetch"));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(testMulticornHome)) {
      rmSync(testMulticornHome, { recursive: true, force: true });
    }
  });

  it("reuses a healthy proxy by default", async () => {
    const result = await ensureProxyForTests(59996, "http://localhost:8080");
    expect(result.reused).toBe(true);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("respawns the proxy when forceRespawn is set even if /health succeeds", async () => {
    const result = await ensureProxyForTests(59996, "http://localhost:8080", {
      forceRespawn: true,
    });

    expect(result.reused).toBe(false);
    expect(vi.mocked(buildLocalProxySpawnCommand)).toHaveBeenCalledWith(
      59996,
      "http://localhost:8080",
    );
  });
});

describe("isAgentSessionRunning (Fix 3: stale pidfile)", () => {
  let isAgentSessionRunning: typeof FilesModule.isAgentSessionRunning;
  let supervisorPidFromSessionForTests: typeof FilesModule.supervisorPidFromSessionForTests;

  beforeAll(async () => {
    ({ isAgentSessionRunning, supervisorPidFromSessionForTests } = await import("./files.js"));
  });

  it("returns false when the supervisor pid is dead", () => {
    expect(
      isAgentSessionRunning({
        agent: "test-agent",
        dir: "/tmp/repo",
        supervisorPid: DEAD_PID,
        fsPort: 3005,
        proxyPort: 3001,
      }),
    ).toBe(false);
  });

  it("returns true only when the supervisor pid is alive", () => {
    expect(
      isAgentSessionRunning({
        agent: "test-agent",
        dir: "/tmp/repo",
        supervisorPid: process.pid,
        fsPort: 3005,
        proxyPort: 3001,
      }),
    ).toBe(true);
  });

  it("honours legacy pidfiles that stored the supervisor pid under pid", () => {
    expect(
      supervisorPidFromSessionForTests({
        agent: "test-agent",
        dir: "/tmp/repo",
        supervisorPid: undefined as unknown as number,
        pid: DEAD_PID,
        fsPort: 3005,
        proxyPort: 3001,
      }),
    ).toBe(DEAD_PID);
    expect(
      isAgentSessionRunning({
        agent: "test-agent",
        dir: "/tmp/repo",
        supervisorPid: undefined as unknown as number,
        pid: DEAD_PID,
        fsPort: 3005,
        proxyPort: 3001,
      } as Parameters<typeof isAgentSessionRunning>[0]),
    ).toBe(false);
  });

  it("reaps a stale pidfile on disk before a new start would honour it", () => {
    mkdirSync(testMulticornHome, { recursive: true });
    const pidfile = join(testMulticornHome, "files-stale-agent.pid");
    writeFileSync(
      pidfile,
      JSON.stringify({
        agent: "stale-agent",
        dir: "/tmp/repo",
        supervisorPid: DEAD_PID,
        fsPort: 3005,
        proxyPort: 3001,
      }),
      "utf8",
    );

    const data = JSON.parse(readFileSync(pidfile, "utf8")) as Parameters<
      typeof isAgentSessionRunning
    >[0];
    expect(isAgentSessionRunning(data)).toBe(false);

    rmSync(testMulticornHome, { recursive: true, force: true });
  });
});
