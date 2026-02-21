import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig, saveConfig, validateApiKey } from "./config.js";

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
    });
  });
});
