/**
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isShieldExtensionEntry,
  readClaudeDesktopMcpConfig,
  readExtensionBackup,
  type McpServerEntry,
} from "../config-reader.js";

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

vi.mock("../../proxy/config.js", () => ({
  getClaudeDesktopConfigPath: () => "/tmp/claude_desktop_config.test.json",
}));

describe("config-reader", () => {
  beforeEach(() => {
    readFileMock.mockReset();
    writeFileMock.mockReset();
    mkdirMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("isShieldExtensionEntry", () => {
    it("returns true for server key multicorn-shield", () => {
      const entry: McpServerEntry = { command: "node", args: ["server.js"] };
      expect(isShieldExtensionEntry("multicorn-shield", entry)).toBe(true);
    });

    it("returns true when args reference shield-extension", () => {
      const entry: McpServerEntry = {
        command: "node",
        args: ["/app/extension-pack/server/shield-extension.js"],
      };
      expect(isShieldExtensionEntry("filesystem", entry)).toBe(true);
    });

    it("returns true when MULTICORN_SHIELD_EXTENSION env is 1", () => {
      const entry: McpServerEntry = {
        command: "node",
        args: ["server.js"],
        env: { MULTICORN_SHIELD_EXTENSION: "1" },
      };
      expect(isShieldExtensionEntry("other", entry)).toBe(true);
    });

    it("returns false for a normal npx MCP server", () => {
      const entry: McpServerEntry = {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      };
      expect(isShieldExtensionEntry("filesystem", entry)).toBe(false);
    });
  });

  describe("readExtensionBackup", () => {
    it("returns null when file is missing", async () => {
      readFileMock.mockRejectedValue(new Error("ENOENT"));
      const result = await readExtensionBackup();
      expect(result).toBeNull();
    });

    it("parses a valid v1 backup", async () => {
      readFileMock.mockResolvedValue(
        JSON.stringify({
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          claudeDesktopConfigPath: "/tmp/c.json",
          mcpServers: { a: { command: "npx", args: ["x"] } },
        }),
      );
      const result = await readExtensionBackup();
      expect(result?.version).toBe(1);
      expect(result?.mcpServers["a"]).toEqual({ command: "npx", args: ["x"] });
    });
  });

  it("readClaudeDesktopMcpConfig skips invalid server entries", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "pkg"] },
          bad: { command: 1 },
        },
      }),
    );
    const result = await readClaudeDesktopMcpConfig();
    expect(result?.mcpServers["fs"]).toEqual({ command: "npx", args: ["-y", "pkg"] });
    expect(result?.mcpServers["bad"]).toBeUndefined();
  });
});
