import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadCachedScopes, saveCachedScopes } from "../scope-cache.js";

const TEST_API_KEY = "test-api-key";

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

beforeEach(() => {
  readFileMock.mockReset();
  writeFileMock.mockReset().mockResolvedValue(undefined);
  mkdirMock.mockReset().mockResolvedValue(undefined);
  unlinkMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadCachedScopes", () => {
  it("returns scopes for a cached agent", async () => {
    const key = cacheKey("openclaw", TEST_API_KEY);
    const cacheData: Record<string, unknown> = {
      [key]: {
        agentId: "agent-1",
        scopes: [
          { service: "filesystem", permissionLevel: "read" },
          { service: "terminal", permissionLevel: "execute" },
        ],
        fetchedAt: "2026-03-01T00:00:00.000Z",
      },
    };
    readFileMock.mockImplementation((path: string) => {
      if (path.includes("cache-meta")) {
        return Promise.resolve(
          JSON.stringify({ apiKeyHash: createHash("sha256").update(TEST_API_KEY).digest("hex") }),
        );
      }
      return Promise.resolve(JSON.stringify(cacheData));
    });

    const result = await loadCachedScopes("openclaw", TEST_API_KEY);

    expect(result).toEqual([
      { service: "filesystem", permissionLevel: "read" },
      { service: "terminal", permissionLevel: "execute" },
    ]);
  });

  it("returns null when apiKey is empty", async () => {
    const result = await loadCachedScopes("openclaw", "");
    expect(result).toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("returns null when the agent is not in the cache", async () => {
    const currentHash = createHash("sha256").update(TEST_API_KEY).digest("hex");
    readFileMock.mockImplementation((path: string) => {
      if (path.includes("cache-meta")) {
        return Promise.resolve(JSON.stringify({ apiKeyHash: currentHash }));
      }
      return Promise.resolve(
        JSON.stringify({ other: { agentId: "x", scopes: [], fetchedAt: "" } }),
      );
    });

    const result = await loadCachedScopes("openclaw", TEST_API_KEY);
    expect(result).toBeNull();
  });

  it("returns null when the scopes file does not exist", async () => {
    const currentHash = createHash("sha256").update(TEST_API_KEY).digest("hex");
    readFileMock.mockImplementation((path: string) => {
      if (path.includes("cache-meta")) {
        return Promise.resolve(JSON.stringify({ apiKeyHash: currentHash }));
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await loadCachedScopes("openclaw", TEST_API_KEY);
    expect(result).toBeNull();
  });

  it("clears cache when API key has changed", async () => {
    const oldHash = "old-hash-value";
    readFileMock.mockImplementation((path: string) => {
      if (path.includes("cache-meta")) {
        return Promise.resolve(JSON.stringify({ apiKeyHash: oldHash }));
      }
      if (path.includes("scopes.json")) {
        return Promise.reject(new Error("ENOENT"));
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await loadCachedScopes("openclaw", TEST_API_KEY);

    expect(unlinkMock).toHaveBeenCalledWith(expect.stringContaining("scopes.json"));
    expect(result).toBeNull();
  });
});

describe("saveCachedScopes", () => {
  it("creates the directory and writes scopes with correct permissions", async () => {
    readFileMock.mockImplementation((path: string) => {
      if (path.includes("cache-meta")) {
        return Promise.reject(new Error("ENOENT"));
      }
      return Promise.reject(new Error("ENOENT"));
    });

    await saveCachedScopes(
      "openclaw",
      "agent-1",
      [{ service: "filesystem", permissionLevel: "read" }],
      TEST_API_KEY,
    );

    expect(mkdirMock).toHaveBeenCalledWith(expect.stringContaining(".multicorn"), {
      recursive: true,
      mode: 0o700,
    });

    const scopesCall = writeFileMock.mock.calls.find((c) => String(c[0]).includes("scopes.json"));
    expect(scopesCall).toBeDefined();
    expect(scopesCall?.[1]).toContain('"filesystem"');
    expect(scopesCall?.[2]).toEqual({ encoding: "utf8", mode: 0o600 });
  });

  it("returns early when apiKey is empty", async () => {
    await saveCachedScopes(
      "openclaw",
      "agent-1",
      [{ service: "filesystem", permissionLevel: "read" }],
      "",
    );

    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("uses account-aware cache key", async () => {
    readFileMock.mockImplementation((path: string) => {
      if (path.includes("cache-meta")) {
        return Promise.reject(new Error("ENOENT"));
      }
      return Promise.reject(new Error("ENOENT"));
    });

    await saveCachedScopes(
      "openclaw",
      "agent-1",
      [{ service: "terminal", permissionLevel: "execute" }],
      TEST_API_KEY,
    );

    const scopesCall = writeFileMock.mock.calls.find((c) => String(c[0]).includes("scopes.json"));
    expect(scopesCall).toBeDefined();
    const writtenData = JSON.parse(String(scopesCall?.[1] ?? "{}")) as Record<string, unknown>;
    const key = cacheKey("openclaw", TEST_API_KEY);
    expect(writtenData[key]).toBeDefined();
  });
});
