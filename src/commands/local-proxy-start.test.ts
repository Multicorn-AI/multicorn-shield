import { describe, it, expect } from "vitest";
import { join } from "node:path";

import {
  buildLocalProxySpawnCommand,
  buildLocalProxySpawnEnv,
  formatLocalProxyStartError,
  readProxyLogTail,
} from "./local-proxy-start.js";

describe("buildLocalProxySpawnCommand", () => {
  const fakeServerEntry = join("/opt/multicorn-shield", "dist", "server.js");
  const fakeExecPath = "/usr/local/bin/node";
  const prodBaseUrl = "https://api.multicorn.ai";

  it("targets dist/server.js via process.execPath, not the CLI bin or multicorn-proxy", () => {
    const cmd = buildLocalProxySpawnCommand(3001, prodBaseUrl, fakeExecPath, fakeServerEntry);

    expect(cmd.executable).toBe(fakeExecPath);
    expect(cmd.args).toEqual([fakeServerEntry]);
    expect(cmd.serverEntryPath).toBe(fakeServerEntry);
    expect(cmd.serverEntryPath.endsWith("dist/server.js")).toBe(true);
    expect(cmd.args).not.toContain("multicorn-proxy");
    expect(cmd.args).not.toContain("multicorn-shield");
    expect(cmd.args).not.toContain("npx");
  });

  it("includes PORT, SHIELD_API_BASE_URL, and ALLOW_PRIVATE_TARGETS in spawn env", () => {
    const env = buildLocalProxySpawnEnv(3001, prodBaseUrl);
    expect(env.PORT).toBe("3001");
    expect(env.SHIELD_API_BASE_URL).toBe(prodBaseUrl);
    expect(env.ALLOW_PRIVATE_TARGETS).toBe("true");
    expect(env.HOST).toBe("127.0.0.1");

    const cmd = buildLocalProxySpawnCommand(
      4001,
      "https://staging.example.com",
      fakeExecPath,
      fakeServerEntry,
    );
    expect(cmd.env.PORT).toBe("4001");
    expect(cmd.env.SHIELD_API_BASE_URL).toBe("https://staging.example.com");
    expect(cmd.env.SHIELD_API_BASE_URL).not.toContain("localhost");
  });
});

describe("formatLocalProxyStartError", () => {
  it("includes captured proxy log output in the thrown error message", () => {
    const logPath = join(import.meta.dirname, "__fixtures__", "proxy-start-failure.txt");
    const message = formatLocalProxyStartError(3001, logPath, true, 1);

    expect(message).toContain("Could not start the local proxy on port 3001");
    expect(message).toContain("Proxy process exited early (code 1)");
    expect(message).toContain("Warning: multicorn-proxy is deprecated");
    expect(message).toContain(logPath);
  });

  it("readProxyLogTail returns the tail of a log file", () => {
    const logPath = join(import.meta.dirname, "__fixtures__", "proxy-start-failure.txt");
    const tail = readProxyLogTail(logPath, 200);
    expect(tail).toContain("deprecated");
  });
});
