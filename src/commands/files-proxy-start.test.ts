import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testMulticornHome = join(tmpdir(), `shield-files-proxy-test-${String(process.pid)}`);
process.env["MULTICORN_HOME"] = testMulticornHome;

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
  return {
    ...actual,
    LOCAL_PROXY_READY_MAX_POLLS: 2,
    LOCAL_PROXY_READY_POLL_MS: 1,
    buildLocalProxySpawnCommand: vi.fn(actual.buildLocalProxySpawnCommand),
    resolveLocalProxyServerEntry: vi.fn(() =>
      join(import.meta.dirname, "__fixtures__", "fake-server.js"),
    ),
  };
});

import { spawn } from "node:child_process";
import { ensureProxyForTests } from "./files.js";

describe("ensureProxy start failure", () => {
  let mcpJsonPath: string;
  const originalMulticornHome = process.env["MULTICORN_HOME"];

  beforeEach(() => {
    mkdirSync(testMulticornHome, { recursive: true });

    const cursorDir = join(testMulticornHome, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    mcpJsonPath = join(cursorDir, "mcp.json");
    writeFileSync(
      mcpJsonPath,
      JSON.stringify(
        { mcpServers: { "existing-agent": { url: "http://127.0.0.1:3001/r/x/y" } } },
        null,
        2,
      ),
      "utf8",
    );

    writeFileSync(
      join(testMulticornHome, "proxy.log"),
      "Warning: multicorn-proxy is deprecated. Use multicorn-shield instead.\n",
      "utf8",
    );

    const fakeChild = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void };
    fakeChild.pid = 4242;
    fakeChild.unref = vi.fn();

    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    queueMicrotask(() => {
      fakeChild.emit("exit", 1);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env["MULTICORN_HOME"] = originalMulticornHome ?? testMulticornHome;
    if (existsSync(testMulticornHome)) {
      rmSync(testMulticornHome, { recursive: true, force: true });
    }
  });

  it("surfaces captured child output and leaves an existing mcp.json untouched", async () => {
    const before = readFileSync(mcpJsonPath, "utf8");

    await expect(ensureProxyForTests(59998, "https://api.multicorn.ai")).rejects.toThrow(
      /multicorn-proxy is deprecated/,
    );

    expect(readFileSync(mcpJsonPath, "utf8")).toBe(before);
    expect(existsSync(join(testMulticornHome, "proxy.json"))).toBe(false);
  });
});
