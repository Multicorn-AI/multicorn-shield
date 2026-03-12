import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadCachedScopes,
  saveCachedScopes,
  findAgentByName,
  registerAgent,
  fetchGrantedScopes,
  resolveAgentRecord,
} from "./consent.js";
import type { ProxyLogger } from "./logger.js";

const TEST_API_KEY = "mcs_key";

function cacheKey(agentName: string, apiKey: string): string {
  return createHash("sha256").update(`${agentName}:${apiKey}`).digest("hex").slice(0, 16);
}

const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mkdirMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const unlinkMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("node:fs/promises", () => {
  const exports = {
    readFile: readFileMock,
    writeFile: writeFileMock,
    mkdir: mkdirMock,
    unlink: unlinkMock,
  };
  return { default: exports, ...exports };
});

const agentListResponse = {
  success: true,
  data: [
    { id: "agent-uuid-1", name: "my-mcp-server", status: "active" },
    { id: "agent-uuid-2", name: "other-agent", status: "active" },
  ],
};

const agentDetailResponse = {
  success: true,
  data: {
    id: "agent-uuid-1",
    name: "my-mcp-server",
    permissions: [
      { service: "gmail", read: true, write: false, execute: true, revoked_at: null },
      { service: "calendar", read: true, write: true, execute: false, revoked_at: null },
      { service: "slack", read: false, write: false, execute: false, revoked_at: "2024-01-01" },
    ],
  },
};

describe("loadCachedScopes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
  });

  it("returns scopes for the matching agent name and apiKey", async () => {
    const key = cacheKey("my-mcp-server", TEST_API_KEY);
    const currentHash = createHash("sha256").update(TEST_API_KEY).digest("hex");
    const cache = {
      [key]: {
        agentId: "agent-uuid-1",
        scopes: [{ service: "gmail", permissionLevel: "read" }],
        fetchedAt: "2024-01-01T00:00:00.000Z",
      },
    };
    readFileMock.mockImplementation((path: string) => {
      if (path.includes("cache-meta")) {
        return Promise.resolve(JSON.stringify({ apiKeyHash: currentHash }));
      }
      return Promise.resolve(JSON.stringify(cache));
    });

    const result = await loadCachedScopes("my-mcp-server", TEST_API_KEY);

    expect(result).toHaveLength(1);
    expect(result?.[0]?.service).toBe("gmail");
  });

  it("returns null when the agent has no cache entry", async () => {
    const currentHash = createHash("sha256").update(TEST_API_KEY).digest("hex");
    readFileMock.mockImplementation((path: string) => {
      if (path.includes("cache-meta")) {
        return Promise.resolve(JSON.stringify({ apiKeyHash: currentHash }));
      }
      return Promise.resolve(JSON.stringify({}));
    });
    expect(await loadCachedScopes("unknown-agent", TEST_API_KEY)).toBeNull();
  });

  it("returns null when apiKey is empty", async () => {
    expect(await loadCachedScopes("my-mcp-server", "")).toBeNull();
  });
});

describe("saveCachedScopes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
  });

  it("writes scopes to the cache file with account-aware key", async () => {
    const scopes = [{ service: "gmail", permissionLevel: "read" as const }];

    await saveCachedScopes("my-mcp-server", "agent-uuid-1", scopes, TEST_API_KEY);

    const scopesCall = writeFileMock.mock.calls.find((c) => String(c[0]).includes("scopes.json"));
    expect(scopesCall).toBeDefined();
    const written = JSON.parse(String(scopesCall?.[1] ?? "{}")) as Record<string, unknown>;
    const key = cacheKey("my-mcp-server", TEST_API_KEY);
    expect(written[key]).toBeDefined();
  });

  it("returns early when apiKey is empty", async () => {
    await saveCachedScopes("my-mcp-server", "agent-uuid-1", [], "");

    expect(writeFileMock).not.toHaveBeenCalled();
  });
});

describe("findAgentByName", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the agent record when found by name", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(agentListResponse),
    });

    const result = await findAgentByName("my-mcp-server", "mcs_key", "https://api.multicorn.ai");

    expect(result?.id).toBe("agent-uuid-1");
    expect(result?.name).toBe("my-mcp-server");
  });

  it("returns null when no agent matches the name", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(agentListResponse),
    });

    const result = await findAgentByName("nonexistent", "mcs_key", "https://api.multicorn.ai");

    expect(result).toBeNull();
  });

  it("returns null when the service returns an error", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const result = await findAgentByName("my-mcp-server", "bad-key", "https://api.multicorn.ai");

    expect(result).toBeNull();
  });
});

describe("registerAgent", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the new agent ID on success", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { id: "new-agent-uuid", name: "fresh-agent" },
        }),
    });

    const id = await registerAgent("fresh-agent", "mcs_key", "https://api.multicorn.ai");

    expect(id).toBe("new-agent-uuid");
  });

  it("throws when the service returns an error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    });

    await expect(registerAgent("bad-agent", "mcs_key", "https://api.multicorn.ai")).rejects.toThrow(
      "Failed to register agent",
    );
  });
});

describe("fetchGrantedScopes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("converts permission flags to Scope objects", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(agentDetailResponse),
    });

    const scopes = await fetchGrantedScopes("agent-uuid-1", "mcs_key", "https://api.multicorn.ai");

    expect(scopes).toContainEqual({ service: "gmail", permissionLevel: "read" });
    expect(scopes).toContainEqual({ service: "gmail", permissionLevel: "execute" });
    expect(scopes).toContainEqual({ service: "calendar", permissionLevel: "read" });
    expect(scopes).toContainEqual({ service: "calendar", permissionLevel: "write" });
  });

  it("excludes revoked permissions", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(agentDetailResponse),
    });

    const scopes = await fetchGrantedScopes("agent-uuid-1", "mcs_key", "https://api.multicorn.ai");

    const slackScopes = scopes.filter((s) => s.service === "slack");
    expect(slackScopes).toHaveLength(0);
  });

  it("returns empty array when the service returns an error", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const scopes = await fetchGrantedScopes("bad-id", "mcs_key", "https://api.multicorn.ai");

    expect(scopes).toHaveLength(0);
  });

  it("does not include false permission flags as scopes", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            id: "id",
            permissions: [
              {
                service: "gmail",
                read: false,
                write: false,
                execute: false,
                revoked_at: null,
              },
            ],
          },
        }),
    });

    const scopes = await fetchGrantedScopes("id", "mcs_key", "https://api.multicorn.ai");
    expect(scopes).toHaveLength(0);
  });

  it("returns empty array when fetch throws a network error", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const scopes = await fetchGrantedScopes("id", "mcs_key", "https://api.multicorn.ai");
    expect(scopes).toHaveLength(0);
  });

  it("returns empty array when response is not ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const scopes = await fetchGrantedScopes("id", "mcs_key", "https://api.multicorn.ai");
    expect(scopes).toHaveLength(0);
  });

  it("returns empty array when response body is not valid API response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: false }),
    });

    const scopes = await fetchGrantedScopes("id", "mcs_key", "https://api.multicorn.ai");
    expect(scopes).toHaveLength(0);
  });

  it("returns empty array when agent detail shape is invalid", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { id: "id", name: "test" }, // Missing permissions array
        }),
    });

    const scopes = await fetchGrantedScopes("id", "mcs_key", "https://api.multicorn.ai");
    expect(scopes).toHaveLength(0);
  });
});

describe("deriveDashboardUrl", () => {
  it("converts localhost to port 5173", async () => {
    const { deriveDashboardUrl } = await import("./consent.js");
    expect(deriveDashboardUrl("http://localhost:8080")).toBe("http://localhost:5173/");
  });

  it("converts 127.0.0.1 to port 5173", async () => {
    const { deriveDashboardUrl } = await import("./consent.js");
    expect(deriveDashboardUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:5173/");
  });

  it("converts api.multicorn.ai to app.multicorn.ai", async () => {
    const { deriveDashboardUrl } = await import("./consent.js");
    expect(deriveDashboardUrl("https://api.multicorn.ai")).toBe("https://app.multicorn.ai/");
  });

  it("replaces 'api' with 'app' in hostname", async () => {
    const { deriveDashboardUrl } = await import("./consent.js");
    expect(deriveDashboardUrl("https://api.staging.multicorn.ai")).toBe(
      "https://app.staging.multicorn.ai/",
    );
  });

  it("falls back to production for https non-localhost URLs", async () => {
    const { deriveDashboardUrl } = await import("./consent.js");
    expect(deriveDashboardUrl("https://custom.example.com")).toBe("https://app.multicorn.ai");
  });

  it("falls back to production for invalid URLs", async () => {
    const { deriveDashboardUrl } = await import("./consent.js");
    expect(deriveDashboardUrl("not-a-url")).toBe("https://app.multicorn.ai");
  });
});

describe("findAgentByName", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns null when fetch throws a network error", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await findAgentByName("my-mcp-server", "mcs_key", "https://api.multicorn.ai");
    expect(result).toBeNull();
  });

  it("returns null when response body is not valid API response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: false }),
    });

    const result = await findAgentByName("my-mcp-server", "mcs_key", "https://api.multicorn.ai");
    expect(result).toBeNull();
  });

  it("returns null when data is not an array", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: {} }),
    });

    const result = await findAgentByName("my-mcp-server", "mcs_key", "https://api.multicorn.ai");
    expect(result).toBeNull();
  });

  it("returns null when agent shape is invalid", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: [{ name: "my-mcp-server" }], // Missing id
        }),
    });

    const result = await findAgentByName("my-mcp-server", "mcs_key", "https://api.multicorn.ai");
    expect(result).toBeNull();
  });
});

describe("resolveAgentRecord", () => {
  const mockDebug = vi.fn();
  const mockInfo = vi.fn();
  const mockWarn = vi.fn();
  const mockError = vi.fn();
  const mockLogger: ProxyLogger = {
    debug: mockDebug,
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
  });

  it("returns cached scopes when available", async () => {
    const cachedScopes = [{ service: "gmail", permissionLevel: "read" as const }];
    const key = cacheKey("my-agent", "mcs_key");
    const currentHash = createHash("sha256").update("mcs_key").digest("hex");
    readFileMock.mockImplementation((path: string) => {
      if (path.includes("cache-meta")) {
        return Promise.resolve(JSON.stringify({ apiKeyHash: currentHash }));
      }
      return Promise.resolve(
        JSON.stringify({
          [key]: {
            agentId: "agent-id",
            scopes: cachedScopes,
            fetchedAt: new Date().toISOString(),
          },
        }),
      );
    });

    const result = await resolveAgentRecord(
      "my-agent",
      "mcs_key",
      "https://api.multicorn.ai",
      mockLogger,
    );

    expect(result.scopes).toEqual(cachedScopes);
    expect(result.id).toBe("");
    expect(mockDebug).toHaveBeenCalled();
  });

  it("returns empty scopes when cache has empty array", async () => {
    const key = cacheKey("my-agent", "mcs_key");
    const currentHash = createHash("sha256").update("mcs_key").digest("hex");
    readFileMock.mockImplementation((path: string) => {
      if (path.includes("cache-meta")) {
        return Promise.resolve(JSON.stringify({ apiKeyHash: currentHash }));
      }
      return Promise.resolve(
        JSON.stringify({
          [key]: {
            agentId: "agent-id",
            scopes: [],
            fetchedAt: new Date().toISOString(),
          },
        }),
      );
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(agentListResponse),
    });

    const result = await resolveAgentRecord(
      "my-agent",
      "mcs_key",
      "https://api.multicorn.ai",
      mockLogger,
    );

    expect(result.scopes).toEqual([]);
  });

  it("registers agent when not found and service is reachable", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { id: "new-agent-id", name: "my-agent" },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { permissions: [] } }),
      });

    const result = await resolveAgentRecord(
      "my-agent",
      "mcs_key",
      "https://api.multicorn.ai",
      mockLogger,
    );

    expect(result.id).toBe("new-agent-id");
    expect(mockInfo).toHaveBeenCalledWith("Agent not found. Registering.", { agent: "my-agent" });
  });

  it("returns offline mode when registration fails", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      })
      .mockRejectedValueOnce(new Error("Network error"));

    const result = await resolveAgentRecord(
      "my-agent",
      "mcs_key",
      "https://api.multicorn.ai",
      mockLogger,
    );

    expect(result.id).toBe("");
    expect(result.scopes).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      "Could not reach Multicorn service. Running with empty permissions.",
      expect.objectContaining({ error: expect.any(String) as unknown as string }),
    );
  });

  it("saves scopes to cache when fetched from service", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(agentListResponse),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(agentDetailResponse),
      });

    const result = await resolveAgentRecord(
      "my-mcp-server",
      "mcs_key",
      "https://api.multicorn.ai",
      mockLogger,
    );

    expect(result.scopes.length).toBeGreaterThan(0);
    expect(writeFileMock).toHaveBeenCalled();
  });

  it("does not save to cache when scopes are empty", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(agentListResponse),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { id: "agent-uuid-1", name: "my-mcp-server", permissions: [] },
          }),
      });

    await resolveAgentRecord("my-mcp-server", "mcs_key", "https://api.multicorn.ai", mockLogger);

    expect(writeFileMock).not.toHaveBeenCalledWith(
      expect.stringContaining("scopes.json"),
      expect.anything(),
      expect.anything(),
    );
  });
});
