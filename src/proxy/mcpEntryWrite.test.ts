import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeLocalMcpEntry } from "./config.js";

// Real-filesystem tests (no fs mock) for the on-disk MCP config rewrite that
// `files start`/`files restart` runs on every start. We use the `copilot` client
// because its config is workspace-relative (`.vscode/mcp.json`), so the test never
// touches a home-level path, and it goes through the same atomic JSON merge as the
// other JSON clients. The proxy accepts the key in either the `?key=` query param or
// the `Authorization: Bearer` header, and the entry carries both.

const PROXY_URL = "http://127.0.0.1:8788/r/abcdef/demo";
const API_KEY = "mcs_test_key_1234";

let workspace: string;
let configPath: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "mcp-entry-"));
  configPath = join(workspace, ".vscode", "mcp.json");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("writeLocalMcpEntry on-disk rewrite", () => {
  it("writes a complete keyed entry (key in url + Bearer header) named for the agent", async () => {
    const written = await writeLocalMcpEntry("copilot", "demo", PROXY_URL, API_KEY, workspace);
    expect(written).toBe(configPath);

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      servers: Record<string, { url: string; headers: { Authorization: string } }>;
    };
    // The entry is keyed by the agent name itself - no "-files" suffix.
    const entry = parsed.servers["demo"];
    expect(entry).toBeDefined();
    expect(parsed.servers["demo-files"]).toBeUndefined();
    expect(entry?.url).toContain(`key=${API_KEY}`);
    expect(entry?.headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("rewrites a missing block back while preserving other entries", async () => {
    await mkdir(join(workspace, ".vscode"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ servers: { "other-server": { url: "http://localhost:9/x" } } }, null, 2),
      "utf8",
    );

    const written = await writeLocalMcpEntry("copilot", "demo", PROXY_URL, API_KEY, workspace);
    expect(written).toBe(configPath);

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      servers: Record<string, { url?: string; headers?: { Authorization: string } }>;
    };
    // The untouched sibling entry survives, and only the agent's own block is (re)written.
    expect(parsed.servers["other-server"]?.url).toBe("http://localhost:9/x");
    expect(parsed.servers["demo"]?.headers?.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("drops a legacy <agent>-files entry so the user is left with one agent-named entry", async () => {
    await mkdir(join(workspace, ".vscode"), { recursive: true });
    // What an older build left behind: the entry keyed `demo-files`.
    await writeFile(
      configPath,
      JSON.stringify(
        {
          servers: {
            "demo-files": {
              type: "http",
              url: "http://127.0.0.1:8788/r/abcdef/demo?key=mcs_stale_old",
              headers: { Authorization: "Bearer mcs_stale_old" },
            },
            "other-server": { url: "http://localhost:9/x" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const written = await writeLocalMcpEntry("copilot", "demo", PROXY_URL, API_KEY, workspace);
    expect(written).toBe(configPath);

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      servers: Record<string, { url?: string; headers?: { Authorization: string } }>;
    };
    expect(parsed.servers["demo-files"]).toBeUndefined();
    expect(parsed.servers["demo"]?.headers?.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(parsed.servers["other-server"]?.url).toBe("http://localhost:9/x");
  });

  it("repairs a stale entry written with an old key to the current key (the restart fix)", async () => {
    await mkdir(join(workspace, ".vscode"), { recursive: true });
    // Simulate an out-of-date on-disk entry: same agent block, but a stale key in both
    // the url and the header (what an older `files start` wrote before a key rotation).
    await writeFile(
      configPath,
      JSON.stringify(
        {
          servers: {
            demo: {
              type: "http",
              url: "http://127.0.0.1:8788/r/abcdef/demo?key=mcs_stale_old",
              headers: { Authorization: "Bearer mcs_stale_old" },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const written = await writeLocalMcpEntry("copilot", "demo", PROXY_URL, API_KEY, workspace);
    expect(written).toBe(configPath);

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      servers: Record<string, { url: string; headers: { Authorization: string } }>;
    };
    const entry = parsed.servers["demo"];
    expect(entry?.url).toContain(`key=${API_KEY}`);
    expect(entry?.url).not.toContain("mcs_stale_old");
    expect(entry?.headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("leaves the file untouched when the existing config is not valid JSON (fail closed)", async () => {
    await mkdir(join(workspace, ".vscode"), { recursive: true });
    const corrupt = '{ "servers": { not valid json';
    await writeFile(configPath, corrupt, "utf8");

    const written = await writeLocalMcpEntry("copilot", "demo", PROXY_URL, API_KEY, workspace);
    expect(written).toBeNull();
    // Byte-for-byte unchanged: we never delete or truncate before a clean replacement.
    expect(await readFile(configPath, "utf8")).toBe(corrupt);
  });

  it("refuses to write (and leaves the file untouched) when the API key is empty", async () => {
    await mkdir(join(workspace, ".vscode"), { recursive: true });
    const original = JSON.stringify(
      { servers: { "other-server": { url: "http://localhost:9/x" } } },
      null,
      2,
    );
    await writeFile(configPath, original, "utf8");

    const written = await writeLocalMcpEntry("copilot", "demo", PROXY_URL, "", workspace);
    expect(written).toBeNull();
    expect(await readFile(configPath, "utf8")).toBe(original);
  });
});
