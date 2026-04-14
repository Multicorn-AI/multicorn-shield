// @vitest-environment node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scriptPath = path.resolve(process.cwd(), "plugins/windsurf/hooks/scripts/post-action.cjs");

if (!existsSync(scriptPath)) {
  throw new Error(
    `Windsurf post-action hook not found at ${scriptPath} (cwd=${process.cwd()}). Run tests from the multicorn-shield package root.`,
  );
}

function runPostAction(
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code ?? -1, stderr });
    });
    child.stdin.write(stdin, "utf8");
    child.stdin.end();
  });
}

function writeConfig(home: string, baseUrl: string): void {
  const dir = path.join(home, ".multicorn");
  mkdirSync(dir, { recursive: true });
  const obj = {
    apiKey: "k",
    baseUrl,
    agents: [{ name: "a1", platform: "windsurf" }],
    defaultAgent: "a1",
  };
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(obj), "utf8");
}

describe("windsurf post-action hook script", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "mshield-ws-post-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("always exits 0 even when POST fails", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 500;
      res.end("err");
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
      server.on("error", reject);
    });
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
    writeConfig(home, baseUrl);
    const stdin = JSON.stringify({
      agent_action_name: "post_write_code",
      trajectory_id: "t1",
      execution_id: "e1",
      tool_info: { file_path: "/x" },
    });
    const { status, stderr } = await runPostAction(stdin, { HOME: home });
    expect(status).toBe(0);
    expect(stderr).toContain("Warning: failed to log");
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it("exits 0 without calling API for unknown post event", async () => {
    const handler = vi.fn();
    const server = createServer((req, res) => {
      handler();
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
      server.on("error", reject);
    });
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
    writeConfig(home, baseUrl);
    const { status } = await runPostAction(
      JSON.stringify({ agent_action_name: "post_cascade_response" }),
      { HOME: home },
    );
    expect(status).toBe(0);
    expect(handler).not.toHaveBeenCalled();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
});
