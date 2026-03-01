import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadCachedScopes, saveCachedScopes } from "../scope-cache.js";

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

beforeEach(() => {
  readFileMock.mockReset();
  writeFileMock.mockReset().mockResolvedValue(undefined);
  mkdirMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadCachedScopes", () => {
  it("returns scopes for a cached agent", async () => {
    const cacheData = {
      openclaw: {
        agentId: "agent-1",
        scopes: [
          { service: "filesystem", permissionLevel: "read" },
          { service: "terminal", permissionLevel: "execute" },
        ],
        fetchedAt: "2026-03-01T00:00:00.000Z",
      },
    };
    readFileMock.mockResolvedValue(JSON.stringify(cacheData));

    const result = await loadCachedScopes("openclaw");

    expect(result).toEqual([
      { service: "filesystem", permissionLevel: "read" },
      { service: "terminal", permissionLevel: "execute" },
    ]);
  });

  it("returns null when the agent is not in the cache", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({ other: { agentId: "x", scopes: [], fetchedAt: "" } }),
    );

    const result = await loadCachedScopes("openclaw");
    expect(result).toBeNull();
  });

  it("returns null when the file does not exist", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));

    const result = await loadCachedScopes("openclaw");
    expect(result).toBeNull();
  });

  it("returns null when the file contains invalid JSON", async () => {
    readFileMock.mockResolvedValue("{broken json");

    const result = await loadCachedScopes("openclaw");
    expect(result).toBeNull();
  });

  it("returns null when the file contains a non-object value", async () => {
    readFileMock.mockResolvedValue('"just a string"');

    const result = await loadCachedScopes("openclaw");
    expect(result).toBeNull();
  });
});

describe("saveCachedScopes", () => {
  it("creates the directory and writes scopes with correct permissions", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));

    await saveCachedScopes("openclaw", "agent-1", [
      { service: "filesystem", permissionLevel: "read" },
    ]);

    expect(mkdirMock).toHaveBeenCalledWith(expect.stringContaining(".multicorn"), {
      recursive: true,
      mode: 0o700,
    });

    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringContaining("scopes.json"),
      expect.stringContaining('"filesystem"'),
      { encoding: "utf8", mode: 0o600 },
    );
  });

  it("merges with existing cache entries for other agents", async () => {
    const existing = {
      "other-agent": {
        agentId: "agent-2",
        scopes: [{ service: "browser", permissionLevel: "execute" }],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    readFileMock.mockResolvedValue(JSON.stringify(existing));

    await saveCachedScopes("openclaw", "agent-1", [
      { service: "terminal", permissionLevel: "execute" },
    ]);

    const writtenData = JSON.parse((writeFileMock.mock.calls[0]?.[1] as string).trim()) as Record<
      string,
      unknown
    >;

    expect(writtenData["other-agent"]).toBeDefined();
    expect(writtenData["openclaw"]).toBeDefined();
  });

  it("overwrites an existing entry for the same agent", async () => {
    const existing = {
      openclaw: {
        agentId: "agent-1",
        scopes: [{ service: "filesystem", permissionLevel: "read" }],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    readFileMock.mockResolvedValue(JSON.stringify(existing));

    await saveCachedScopes("openclaw", "agent-1", [
      { service: "terminal", permissionLevel: "execute" },
    ]);

    const writtenData = JSON.parse((writeFileMock.mock.calls[0]?.[1] as string).trim()) as Record<
      string,
      unknown
    >;
    const entry = writtenData["openclaw"] as Record<string, unknown>;
    const scopes = entry["scopes"] as Record<string, string>[];

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.["service"]).toBe("terminal");
  });

  it("starts fresh when existing file is corrupt", async () => {
    readFileMock.mockResolvedValue("{corrupt");

    await saveCachedScopes("openclaw", "agent-1", [
      { service: "filesystem", permissionLevel: "read" },
    ]);

    expect(writeFileMock).toHaveBeenCalled();
    const writtenData = JSON.parse((writeFileMock.mock.calls[0]?.[1] as string).trim()) as Record<
      string,
      unknown
    >;
    expect(writtenData["openclaw"]).toBeDefined();
  });
});
