/**
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { restoreClaudeDesktopMcpFromBackup } from "./restore.js";
import * as proxyConfig from "../proxy/config.js";

const readExtensionBackupMock = vi.hoisted(() => vi.fn());

vi.mock("./config-reader.js", () => ({
  readExtensionBackup: readExtensionBackupMock,
}));

vi.mock("../proxy/config.js", () => ({
  getClaudeDesktopConfigPath: vi.fn(),
}));

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

describe("restoreClaudeDesktopMcpFromBackup", () => {
  beforeEach(() => {
    readFileMock.mockReset();
    writeFileMock.mockReset();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockReset();
    mkdirMock.mockResolvedValue(undefined);
    vi.mocked(proxyConfig.getClaudeDesktopConfigPath).mockReturnValue(
      "/tmp/claude_desktop_config.json",
    );
  });

  it("throws when no backup exists", async () => {
    readExtensionBackupMock.mockResolvedValue(null);

    await expect(restoreClaudeDesktopMcpFromBackup()).rejects.toThrow(
      /No Shield extension backup found/,
    );
  });

  it("writes mcpServers from backup when config file is missing", async () => {
    readExtensionBackupMock.mockResolvedValue({
      mcpServers: { foo: { command: "node" } },
    });
    readFileMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    await restoreClaudeDesktopMcpFromBackup();

    expect(mkdirMock).toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/claude_desktop_config.json",
      expect.stringContaining('"mcpServers"'),
      { encoding: "utf8", mode: 0o600 },
    );
  });

  it("merges mcpServers into existing config", async () => {
    readExtensionBackupMock.mockResolvedValue({
      mcpServers: { bar: { command: "bar" } },
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({ theme: "dark", mcpServers: { old: { command: "old" } } }),
    );

    await restoreClaudeDesktopMcpFromBackup();

    const written = writeFileMock.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed["theme"]).toBe("dark");
    expect(parsed["mcpServers"]).toEqual({ bar: { command: "bar" } });
  });

  it("rethrows non-ENOENT read errors", async () => {
    readExtensionBackupMock.mockResolvedValue({ mcpServers: {} });
    readFileMock.mockRejectedValue(new Error("disk full"));

    await expect(restoreClaudeDesktopMcpFromBackup()).rejects.toThrow("disk full");
  });
});
