import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(
  __dirname,
  "../../plugins/multicorn-shield/hooks/scripts/pre-tool-use.js",
);

function runPreToolUse(
  stdin: string,
  env: NodeJS.ProcessEnv,
): { status: number; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [scriptPath], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const status = result.status ?? -1;
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  return { status, stderr, stdout };
}

function writeConfig(
  home: string,
  opts: { apiKey?: string; agentName?: string; baseUrl?: string } = {},
): void {
  const dir = path.join(home, ".multicorn");
  mkdirSync(dir, { recursive: true });
  const obj = {
    apiKey: opts.apiKey ?? "test-api-key",
    agentName: opts.agentName ?? "test-agent",
    baseUrl: opts.baseUrl ?? "http://127.0.0.1:9",
  };
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(obj), "utf8");
}

async function withActionServer(
  onPost: (res: ServerResponse) => void,
  fn: (baseUrl: string) => void | Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/api/v1/actions")) {
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
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

const validStdin = JSON.stringify({ tool_name: "read", tool_input: { path: "/tmp/x" } });

describe("claude-code pre-tool-use hook script", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "mshield-pre-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("exits 0 when no config file exists", () => {
    const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("exits 0 when API key is empty", () => {
    writeConfig(home, { apiKey: "", agentName: "agent" });
    const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("exits 0 when agent name is empty", () => {
    writeConfig(home, { apiKey: "key", agentName: "" });
    const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("exits 0 on invalid JSON stdin and writes stderr", () => {
    writeConfig(home);
    const { status, stderr } = runPreToolUse("not-json{", { HOME: home });
    expect(status).toBe(0);
    expect(stderr).toContain("[multicorn-shield] PreToolUse: invalid JSON");
    expect(stderr).toContain("Allowing tool.");
  });

  it("exits 0 when tool_input cannot be serialized", () => {
    writeConfig(home);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const stdin = JSON.stringify({ tool_name: "read", tool_input: circular });
    const { status, stderr } = runPreToolUse(stdin, { HOME: home });
    expect(status).toBe(0);
    expect(stderr).toContain("[multicorn-shield] PreToolUse: could not serialize tool_input");
    expect(stderr).toContain("Allowing tool.");
  });

  it("exits 0 on 201 approved", async () => {
    await withActionServer(
      (res) => {
        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, data: { status: "approved" } }));
      },
      (baseUrl) => {
        writeConfig(home, { baseUrl });
        const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
        expect(status).toBe(0);
        expect(stderr).toBe("");
      },
    );
  });

  it("exits 2 on 201 blocked (permission denied)", async () => {
    await withActionServer(
      (res) => {
        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, data: { status: "blocked" } }));
      },
      (baseUrl) => {
        writeConfig(home, { baseUrl });
        const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
        expect(status).toBe(2);
        expect(stderr).toContain("[multicorn-shield] PreToolUse: Action blocked:");
        expect(stderr).toContain("Grant access in the Shield dashboard and retry.");
        expect(stderr).toContain("Detail:");
      },
    );
  });

  it("exits 2 when Shield API is unreachable (ECONNREFUSED)", () => {
    writeConfig(home, { baseUrl: "http://127.0.0.1:61237" });
    const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
    expect(status).toBe(2);
    expect(stderr).toContain(
      "[multicorn-shield] PreToolUse: Action blocked: Shield API unreachable, cannot verify permissions.",
    );
    expect(stderr).toContain("Check that the Shield service is running and retry.");
    expect(stderr).toContain("Detail:");
    expect(stderr.toLowerCase()).toMatch(/econnrefused|refused/);
  });

  it.each([401, 403, 429] as const)("exits 2 when Shield API returns HTTP %s", async (code) => {
    await withActionServer(
      (res) => {
        res.statusCode = code;
        res.end("nope");
      },
      (baseUrl) => {
        writeConfig(home, { baseUrl });
        const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
        expect(status).toBe(2);
        expect(stderr).toContain(
          `[multicorn-shield] PreToolUse: Action blocked: Shield returned HTTP ${String(code)}, cannot verify permissions.`,
        );
        expect(stderr).toContain(
          "Check your API key, Shield service status, and rate limits, then retry.",
        );
        expect(stderr).toContain(`Detail: HTTP ${String(code)}`);
      },
    );
  });

  it.each([500, 502, 503] as const)("exits 2 when Shield API returns HTTP %s", async (code) => {
    await withActionServer(
      (res) => {
        res.statusCode = code;
        res.end("error");
      },
      (baseUrl) => {
        writeConfig(home, { baseUrl });
        const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
        expect(status).toBe(2);
        expect(stderr).toContain(
          `[multicorn-shield] PreToolUse: Action blocked: Shield returned HTTP ${String(code)}, cannot verify permissions.`,
        );
        expect(stderr).toContain("Detail:");
      },
    );
  });

  it("exits 2 on 201 with unparseable body", async () => {
    await withActionServer(
      (res) => {
        res.statusCode = 201;
        res.end("<<<not-json>>>");
      },
      (baseUrl) => {
        writeConfig(home, { baseUrl });
        const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
        expect(status).toBe(2);
        expect(stderr).toContain(
          "[multicorn-shield] PreToolUse: Action blocked: unexpected Shield response, cannot verify permissions.",
        );
        expect(stderr).toContain("Check that the Shield service is healthy and retry.");
        expect(stderr).toContain("Detail:");
        expect(stderr).toContain("<<<not-json>>>");
      },
    );
  });

  it("exits 2 on 201 with JSON that unwraps to no data object", async () => {
    await withActionServer(
      (res) => {
        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: false }));
      },
      (baseUrl) => {
        writeConfig(home, { baseUrl });
        const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
        expect(status).toBe(2);
        expect(stderr).toContain("unexpected Shield response");
        expect(stderr).toContain("Detail:");
      },
    );
  });

  it("exits 2 on 201 with ambiguous status field", async () => {
    await withActionServer(
      (res) => {
        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, data: { status: "maybe" } }));
      },
      (baseUrl) => {
        writeConfig(home, { baseUrl });
        const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
        expect(status).toBe(2);
        expect(stderr).toContain(
          "[multicorn-shield] PreToolUse: Action blocked: ambiguous Shield status, cannot verify permissions.",
        );
        expect(stderr).toContain(
          "Check that your Shield API and plugin versions match, then retry.",
        );
        expect(stderr).toContain('Detail: status="maybe"');
      },
    );
  });

  it("exits 2 when main() throws after config is loaded (test hook)", () => {
    writeConfig(home);
    const { status, stderr } = runPreToolUse(validStdin, {
      HOME: home,
      MULTICORN_SHIELD_PRE_HOOK_TEST_THROW: "1",
    });
    expect(status).toBe(2);
    expect(stderr).toContain(
      "[multicorn-shield] PreToolUse: Action blocked: unexpected error, cannot verify permissions.",
    );
    expect(stderr).toContain("Retry the tool call. If it keeps failing, check Shield logs.");
    expect(stderr).toContain("Detail: MULTICORN_SHIELD_PRE_HOOK_TEST_THROW");
  });

  it("exits 2 on 202 when response data is missing", async () => {
    await withActionServer(
      (res) => {
        res.statusCode = 202;
        res.end("x");
      },
      (baseUrl) => {
        writeConfig(home, { baseUrl });
        const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
        expect(status).toBe(2);
        expect(stderr).toContain("needs approval in the Shield dashboard");
        expect(stderr).toContain("Detail: missing approval data in Shield response");
      },
    );
  });

  it("exits 2 on 202 when approval_id is empty", async () => {
    await withActionServer(
      (res) => {
        res.statusCode = 202;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, data: { approval_id: "" } }));
      },
      (baseUrl) => {
        writeConfig(home, { baseUrl });
        const { status, stderr } = runPreToolUse(validStdin, { HOME: home });
        expect(status).toBe(2);
        expect(stderr).toContain("needs approval in the Shield dashboard");
        expect(stderr).toContain("Detail: approval_id missing in Shield response");
      },
    );
  });
});
