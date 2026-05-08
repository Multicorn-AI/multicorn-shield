import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadConfig,
  readBaseUrlFromConfig,
  saveConfig,
  validateApiKey,
  getAgentByPlatform,
  getDefaultAgent,
  collectAgentsFromConfig,
  hostedProxyUrlWithKeyParam,
  mergeAgentsForPlatform,
  cwdUnderWorkspacePath,
  type ProxyConfig,
} from "./config.js";

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

describe("validateApiKey", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns valid when the service accepts the key", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await validateApiKey("mcs_validkey", "https://api.multicorn.ai");

    expect(result.valid).toBe(true);
  });

  it("returns invalid with a clear message when the key is rejected", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const result = await validateApiKey("mcs_bad", "https://api.multicorn.ai");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("not recognised");
  });

  it("returns invalid when the service returns a non-401 error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const result = await validateApiKey("mcs_key", "https://api.multicorn.ai");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("500");
  });

  it("returns invalid when the network request fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await validateApiKey("mcs_key", "http://localhost:9999");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});

describe("loadConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the parsed config when the file exists and is valid", async () => {
    const stored = { apiKey: "mcs_abc123", baseUrl: "https://api.multicorn.ai" };
    readFileMock.mockResolvedValue(JSON.stringify(stored));

    const result = await loadConfig();

    expect(result?.apiKey).toBe("mcs_abc123");
    expect(result?.baseUrl).toBe("https://api.multicorn.ai");
  });

  it("returns null when the file does not exist", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));

    const result = await loadConfig();

    expect(result).toBeNull();
  });

  it("returns null when the file contains invalid JSON", async () => {
    readFileMock.mockResolvedValue("{broken");

    const result = await loadConfig();

    expect(result).toBeNull();
  });

  it("returns null when the file is missing required fields", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ apiKey: "mcs_key" }));

    const result = await loadConfig();

    expect(result).toBeNull();
  });

  it("auto-migrates legacy format with agentName and platform and writes back", async () => {
    const legacy = {
      apiKey: "mcs_legacy",
      baseUrl: "https://api.multicorn.ai",
      agentName: "legacy-agent",
      platform: "openclaw",
    };
    readFileMock.mockResolvedValue(JSON.stringify(legacy));
    writeFileMock.mockResolvedValue(undefined);

    const result = await loadConfig();

    expect(writeFileMock).toHaveBeenCalled();
    expect(result?.agents).toEqual([{ name: "legacy-agent", platform: "openclaw" }]);
    expect(result?.defaultAgent).toBe("legacy-agent");
    expect(result).not.toHaveProperty("agentName");
  });

  it("migration writes back config without legacy agentName or platform fields", async () => {
    const legacy = {
      apiKey: "mcs_legacy",
      baseUrl: "https://api.multicorn.ai",
      agentName: "legacy-agent",
      platform: "openclaw",
    };
    readFileMock.mockResolvedValue(JSON.stringify(legacy));
    writeFileMock.mockResolvedValue(undefined);

    await loadConfig();

    const firstWrite = writeFileMock.mock.calls[0];
    expect(firstWrite).toBeDefined();
    if (firstWrite === undefined) {
      throw new Error("expected writeFile to have been called");
    }
    const payload: unknown = firstWrite[1];
    expect(typeof payload).toBe("string");
    const writtenJson = JSON.parse(payload as string) as Record<string, unknown>;
    expect(writtenJson).not.toHaveProperty("agentName");
    expect(writtenJson).not.toHaveProperty("platform");
    expect(writtenJson["agents"]).toEqual([{ name: "legacy-agent", platform: "openclaw" }]);
    expect(writtenJson["defaultAgent"]).toBe("legacy-agent");
  });

  it("auto-migrates legacy format without platform using unknown", async () => {
    const legacy = {
      apiKey: "mcs_legacy",
      baseUrl: "https://api.multicorn.ai",
      agentName: "solo-agent",
    };
    readFileMock.mockResolvedValue(JSON.stringify(legacy));
    writeFileMock.mockResolvedValue(undefined);

    const result = await loadConfig();

    expect(result?.agents?.[0]?.platform).toBe("unknown");
    expect(result?.defaultAgent).toBe("solo-agent");
  });

  it("does not migrate when agentName is absent", async () => {
    const minimal = { apiKey: "mcs_only", baseUrl: "https://api.multicorn.ai" };
    readFileMock.mockResolvedValue(JSON.stringify(minimal));

    const result = await loadConfig();

    expect(writeFileMock).not.toHaveBeenCalled();
    expect(result?.agents).toBeUndefined();
  });

  it("reads new multi-agent format without migrating", async () => {
    const next = {
      apiKey: "mcs_x",
      baseUrl: "https://api.multicorn.ai",
      agents: [
        { name: "a", platform: "openclaw" },
        { name: "b", platform: "claude-code" },
      ],
      defaultAgent: "b",
    };
    readFileMock.mockResolvedValue(JSON.stringify(next));

    const result = await loadConfig();

    expect(writeFileMock).not.toHaveBeenCalled();
    expect(result?.agents?.length).toBe(2);
    expect(result?.defaultAgent).toBe("b");
  });
});

describe("readBaseUrlFromConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns undefined when the file does not exist (brand new install)", async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    await expect(readBaseUrlFromConfig()).resolves.toBeUndefined();
  });

  it("returns undefined when JSON has no baseUrl", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ apiKey: "mcs_x" }));

    await expect(readBaseUrlFromConfig()).resolves.toBeUndefined();
  });

  it("returns baseUrl when present even if loadConfig would reject the file", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ baseUrl: "https://self-hosted.example.com" }));

    await expect(readBaseUrlFromConfig()).resolves.toBe("https://self-hosted.example.com");
  });
});

describe("getAgentByPlatform", () => {
  const sample: ProxyConfig = {
    apiKey: "k",
    baseUrl: "https://api.multicorn.ai",
    agents: [
      { name: "oc", platform: "openclaw" },
      { name: "cc", platform: "claude-code" },
    ],
  };

  it("returns the entry matching platform", () => {
    expect(getAgentByPlatform(sample, "claude-code")?.name).toBe("cc");
  });

  it("returns undefined when no platform matches", () => {
    expect(getAgentByPlatform(sample, "cursor")).toBeUndefined();
  });

  it("prefers the longest workspace path that contains cwd", () => {
    const cfg: ProxyConfig = {
      apiKey: "k",
      baseUrl: "https://api.multicorn.ai",
      agents: [
        { name: "parent", platform: "cline", workspacePath: "/projects/foo" },
        { name: "child", platform: "cline", workspacePath: "/projects/foo/bar" },
      ],
    };
    expect(getAgentByPlatform(cfg, "cline", "/projects/foo/bar/baz")?.name).toBe("child");
  });

  it("falls back to the first platform match when cwd fits no workspacePath", () => {
    const cfg: ProxyConfig = {
      apiKey: "k",
      baseUrl: "https://api.multicorn.ai",
      agents: [
        { name: "first", platform: "cline" },
        { name: "second", platform: "cline", workspacePath: "/other" },
      ],
    };
    expect(getAgentByPlatform(cfg, "cline", "/unrelated/path")?.name).toBe("first");
  });
});

describe("cwdUnderWorkspacePath", () => {
  it("is true for the same resolved path", () => {
    expect(cwdUnderWorkspacePath(resolve("/a/b"), "/a/b")).toBe(true);
  });

  it("is true when cwd is a subdirectory of workspace", () => {
    expect(cwdUnderWorkspacePath(resolve("/a/b/c"), "/a/b")).toBe(true);
  });

  it("is false when cwd is outside workspace", () => {
    expect(cwdUnderWorkspacePath(resolve("/a/c"), "/a/b")).toBe(false);
  });
});

describe("getDefaultAgent", () => {
  it("returns the agent named by defaultAgent", () => {
    const cfg: ProxyConfig = {
      apiKey: "k",
      baseUrl: "https://api.multicorn.ai",
      agents: [
        { name: "first", platform: "openclaw" },
        { name: "second", platform: "claude-code" },
      ],
      defaultAgent: "second",
    };
    expect(getDefaultAgent(cfg)?.name).toBe("second");
  });

  it("returns first agent when defaultAgent is unset", () => {
    const cfg: ProxyConfig = {
      apiKey: "k",
      baseUrl: "https://api.multicorn.ai",
      agents: [{ name: "only", platform: "cursor" }],
    };
    expect(getDefaultAgent(cfg)?.name).toBe("only");
  });

  it("returns undefined when agents is empty", () => {
    const cfg: ProxyConfig = {
      apiKey: "k",
      baseUrl: "https://api.multicorn.ai",
      agents: [],
    };
    expect(getDefaultAgent(cfg)).toBeUndefined();
  });

  it("returns undefined when agents is missing", () => {
    const cfg: ProxyConfig = { apiKey: "k", baseUrl: "https://api.multicorn.ai" };
    expect(getDefaultAgent(cfg)).toBeUndefined();
  });
});

describe("collectAgentsFromConfig", () => {
  it("collects from agents array", () => {
    const cfg: ProxyConfig = {
      apiKey: "k",
      baseUrl: "https://api.multicorn.ai",
      agents: [{ name: "x", platform: "p" }],
    };
    expect(collectAgentsFromConfig(cfg)).toEqual([{ name: "x", platform: "p" }]);
  });

  it("preserves workspacePath when present", () => {
    const cfg: ProxyConfig = {
      apiKey: "k",
      baseUrl: "https://api.multicorn.ai",
      agents: [{ name: "x", platform: "p", workspacePath: "/tmp/ws" }],
    };
    expect(collectAgentsFromConfig(cfg)).toEqual([
      { name: "x", platform: "p", workspacePath: "/tmp/ws" },
    ]);
  });

  it("falls back to legacy agentName and platform", () => {
    const cfg: ProxyConfig = {
      apiKey: "k",
      baseUrl: "https://api.multicorn.ai",
      agentName: "old",
      platform: "openclaw",
    };
    expect(collectAgentsFromConfig(cfg)).toEqual([{ name: "old", platform: "openclaw" }]);
  });
});

describe("hostedProxyUrlWithKeyParam", () => {
  it("appends key as query parameter", () => {
    const out = hostedProxyUrlWithKeyParam("https://proxy.io/r/tok/agent", "mcs_abc");
    const u = new URL(out);
    expect(u.searchParams.get("key")).toBe("mcs_abc");
  });

  it("preserves existing query and adds key", () => {
    const out = hostedProxyUrlWithKeyParam("https://proxy.io/r/tok/agent?foo=1", "mcs_x");
    const u = new URL(out);
    expect(u.searchParams.get("foo")).toBe("1");
    expect(u.searchParams.get("key")).toBe("mcs_x");
  });
});

describe("mergeAgentsForPlatform (init replace prompt list)", () => {
  it("does not duplicate the same agent when it appears both on disk and in the account API", () => {
    const rows = mergeAgentsForPlatform(
      [{ name: "cursor-proxy", platform: "cursor" }],
      [{ name: "cursor-proxy", platform: "cursor" }],
      "cursor",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("cursor-proxy");
  });

  it("dedupes when API name casing differs from local config", () => {
    const rows = mergeAgentsForPlatform(
      [{ name: "cursor-proxy", platform: "cursor" }],
      [{ name: "Cursor-Proxy", platform: "cursor" }],
      "cursor",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("cursor-proxy");
  });

  it("dedupes when only spacing differs between local and API", () => {
    const rows = mergeAgentsForPlatform(
      [{ name: "cursor-proxy ", platform: "cursor" }],
      [{ name: "cursor-proxy", platform: "cursor" }],
      "cursor",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("cursor-proxy");
  });

  it("keeps workspacePath when merging overlapping rows", () => {
    const rows = mergeAgentsForPlatform(
      [{ name: "cursor-proxy", platform: "cursor", workspacePath: "/tmp/ws" }],
      [{ name: "cursor-proxy", platform: "cursor" }],
      "cursor",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspacePath).toBe("/tmp/ws");
  });

  it("collapses duplicate local rows that only differ by case", () => {
    const rows = mergeAgentsForPlatform(
      [
        { name: "cursor-proxy", platform: "cursor" },
        { name: "Cursor-Proxy", platform: "cursor" },
      ],
      [],
      "cursor",
    );
    expect(rows).toHaveLength(1);
  });
});

describe("saveConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
  });

  it("writes config to disk as formatted JSON", async () => {
    const config = { apiKey: "mcs_key", baseUrl: "https://api.multicorn.ai" };

    await saveConfig(config);

    expect(writeFileMock).toHaveBeenCalledOnce();
    const written = String(writeFileMock.mock.calls[0]?.[1] ?? "");
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed["apiKey"]).toBe("mcs_key");
  });

  it("creates the config directory if it does not exist", async () => {
    await saveConfig({ apiKey: "mcs_key", baseUrl: "https://api.multicorn.ai" });

    expect(mkdirMock).toHaveBeenCalledWith(expect.stringContaining(".multicorn"), {
      recursive: true,
      mode: 0o700,
    });
  });
});
