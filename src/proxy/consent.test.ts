import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadCachedScopes,
  saveCachedScopes,
  findAgentByName,
  registerAgent,
  fetchGrantedScopes,
} from "./consent.js";

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
      { service: "gmail", read: true, write: false, execute: true, revokedAt: null },
      { service: "calendar", read: true, write: true, execute: false, revokedAt: null },
      { service: "slack", read: false, write: false, execute: false, revokedAt: "2024-01-01" },
    ],
  },
};

describe("loadCachedScopes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
  });

  it("returns scopes for the matching agent name", async () => {
    const cache = {
      "my-mcp-server": {
        agentId: "agent-uuid-1",
        scopes: [{ service: "gmail", permissionLevel: "read" }],
        fetchedAt: "2024-01-01T00:00:00.000Z",
      },
    };
    readFileMock.mockResolvedValue(JSON.stringify(cache));

    const result = await loadCachedScopes("my-mcp-server");

    expect(result).toHaveLength(1);
    expect(result?.[0]?.service).toBe("gmail");
  });

  it("returns null when the agent has no cache entry", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({}));
    expect(await loadCachedScopes("unknown-agent")).toBeNull();
  });

  it("returns null when the cache file does not exist", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    expect(await loadCachedScopes("my-mcp-server")).toBeNull();
  });

  it("returns null when the cache file contains invalid JSON", async () => {
    readFileMock.mockResolvedValue("not json");
    expect(await loadCachedScopes("my-mcp-server")).toBeNull();
  });
});

describe("saveCachedScopes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
  });

  it("writes scopes to the cache file under the agent name key", async () => {
    const scopes = [{ service: "gmail", permissionLevel: "read" as const }];

    await saveCachedScopes("my-mcp-server", "agent-uuid-1", scopes);

    expect(writeFileMock).toHaveBeenCalledOnce();
    const written = JSON.parse(String(writeFileMock.mock.calls[0]?.[1] ?? "")) as Record<
      string,
      unknown
    >;
    expect(written["my-mcp-server"]).toBeDefined();
  });

  it("preserves existing cache entries when adding a new agent", async () => {
    const existing = {
      "other-agent": {
        agentId: "other-id",
        scopes: [],
        fetchedAt: "2024-01-01T00:00:00.000Z",
      },
    };
    readFileMock.mockResolvedValue(JSON.stringify(existing));

    await saveCachedScopes("new-agent", "new-id", []);

    const written = JSON.parse(String(writeFileMock.mock.calls[0]?.[1] ?? "")) as Record<
      string,
      unknown
    >;
    expect(written["other-agent"]).toBeDefined();
    expect(written["new-agent"]).toBeDefined();
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
                revokedAt: null,
              },
            ],
          },
        }),
    });

    const scopes = await fetchGrantedScopes("id", "mcs_key", "https://api.multicorn.ai");
    expect(scopes).toHaveLength(0);
  });
});
