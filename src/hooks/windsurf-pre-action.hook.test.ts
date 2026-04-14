// @vitest-environment node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "plugins/windsurf/hooks/scripts/pre-action.cjs");

if (!existsSync(scriptPath)) {
  throw new Error(
    `Windsurf pre-action hook not found at ${scriptPath} (cwd=${process.cwd()}). Run tests from the multicorn-shield package root.`,
  );
}

function runPreAction(
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        MULTICORN_SHIELD_WINDSURF_PRE_HOOK_TEST_FAST_POLL: "1",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code ?? -1, stderr, stdout });
    });
    child.stdin.write(stdin, "utf8");
    child.stdin.end();
  });
}

function writeConfig(
  home: string,
  opts: { apiKey?: string; agentName?: string; baseUrl?: string; windsurfAgent?: string } = {},
): void {
  const dir = path.join(home, ".multicorn");
  mkdirSync(dir, { recursive: true });
  const agentName = opts.windsurfAgent ?? opts.agentName ?? "test-agent";
  const obj = {
    apiKey: opts.apiKey ?? "test-api-key",
    baseUrl: opts.baseUrl ?? "http://127.0.0.1:9",
    agents: [{ name: agentName, platform: "windsurf" }],
    defaultAgent: agentName,
  };
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(obj), "utf8");
}

async function withActionServer(
  onPost: (res: ServerResponse) => void,
  fn: (baseUrl: string) => void | Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/api/v1/actions")) {
      req.resume();
      onPost(res);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
    server.on("error", reject);
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  try {
    await Promise.resolve(fn(baseUrl));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

function stdinFor(event: string, toolInfo: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agent_action_name: event,
    trajectory_id: "tr-1",
    execution_id: "ex-1",
    tool_info: toolInfo,
  });
}

describe("windsurf pre-action hook script", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "mshield-ws-pre-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("exits 0 when no config file exists", async () => {
    const { status, stderr } = await runPreAction(stdinFor("pre_read_code"), { HOME: home });
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("exits 0 when API key is empty", async () => {
    writeConfig(home, { apiKey: "", windsurfAgent: "agent" });
    const { status, stderr } = await runPreAction(stdinFor("pre_read_code"), { HOME: home });
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("exits 0 for unknown agent_action_name (not a governed pre event)", async () => {
    writeConfig(home);
    const { status } = await runPreAction(stdinFor("pre_user_prompt", { user_prompt: "hi" }), {
      HOME: home,
    });
    expect(status).toBe(0);
  });

  it("exits 0 on 201 approved for pre_read_code", async () => {
    await withActionServer(
      (res) => {
        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, data: { status: "approved" } }));
      },
      async (baseUrl) => {
        writeConfig(home, { baseUrl });
        const { status, stderr } = await runPreAction(
          stdinFor("pre_read_code", { file_path: "/tmp/x" }),
          { HOME: home },
        );
        expect(status).toBe(0);
        expect(stderr).toBe("");
      },
    );
  });

  it("exits 2 on 201 blocked for pre_mcp_tool_use", async () => {
    await withActionServer(
      (res) => {
        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, data: { status: "blocked" } }));
      },
      async (baseUrl) => {
        writeConfig(home, { baseUrl });
        const { status, stderr } = await runPreAction(
          stdinFor("pre_mcp_tool_use", {
            mcp_server_name: "github",
            mcp_tool_name: "list_commits",
          }),
          { HOME: home },
        );
        expect(status).toBe(2);
        expect(stderr).toContain("Windsurf pre-hook:");
        expect(stderr).toContain("Action blocked:");
      },
    );
  });

  it("exits 2 when Shield API is unreachable (ECONNREFUSED)", async () => {
    writeConfig(home, { baseUrl: "http://127.0.0.1:61237" });
    const { status, stderr } = await runPreAction(stdinFor("pre_run_command"), { HOME: home });
    expect(status).toBe(2);
    expect(stderr).toContain("Shield API unreachable");
  });

  it("exits 0 when tool_info cannot be serialized (fail-open)", async () => {
    writeConfig(home);
    const { status, stderr } = await runPreAction(stdinFor("pre_read_code"), {
      HOME: home,
      MULTICORN_SHIELD_WINDSURF_PRE_HOOK_TEST_SERIALIZE_FAIL: "1",
    });
    expect(status).toBe(0);
    expect(stderr).toContain("could not serialize tool_info");
  });

  it("exits 2 when main throws after config is loaded (test hook)", async () => {
    writeConfig(home);
    const { status, stderr } = await runPreAction(stdinFor("pre_read_code"), {
      HOME: home,
      MULTICORN_SHIELD_WINDSURF_PRE_HOOK_TEST_THROW: "1",
    });
    expect(status).toBe(2);
    expect(stderr).toContain("unexpected error");
  });
});
