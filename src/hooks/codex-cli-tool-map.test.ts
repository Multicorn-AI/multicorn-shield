import { describe, expect, it } from "vitest";
import {
  codexIsDestructiveExecCommand,
  extractExecCommand,
  mapCodexCliToolToShield,
} from "./codex-cli-tool-map.js";

describe("codex-cli-tool-map", () => {
  it("maps Bash with safe command to terminal execute", () => {
    expect(mapCodexCliToolToShield("Bash", { command: "ls -la" })).toEqual({
      service: "terminal",
      actionType: "execute",
    });
  });

  it("maps Bash with destructive command to terminal write", () => {
    expect(mapCodexCliToolToShield("Bash", { command: "rm -rf /tmp/x" })).toEqual({
      service: "terminal",
      actionType: "write",
    });
  });

  it("is case-insensitive for tool names", () => {
    expect(mapCodexCliToolToShield("bash", { command: "echo hi" })).toEqual({
      service: "terminal",
      actionType: "execute",
    });
  });

  it("maps apply_patch to filesystem write", () => {
    expect(mapCodexCliToolToShield("apply_patch")).toEqual({
      service: "filesystem",
      actionType: "write",
    });
  });

  it("maps Edit and Write to filesystem write", () => {
    expect(mapCodexCliToolToShield("Edit")).toEqual({
      service: "filesystem",
      actionType: "write",
    });
    expect(mapCodexCliToolToShield("Write")).toEqual({
      service: "filesystem",
      actionType: "write",
    });
  });

  it("maps empty string toolName to unknown:execute", () => {
    expect(mapCodexCliToolToShield("")).toEqual({
      service: "unknown",
      actionType: "execute",
    });
    expect(mapCodexCliToolToShield("  ")).toEqual({
      service: "unknown",
      actionType: "execute",
    });
  });

  it("handles null and undefined toolInput without throwing", () => {
    expect(mapCodexCliToolToShield("Bash", null)).toEqual({
      service: "terminal",
      actionType: "execute",
    });
    expect(mapCodexCliToolToShield("Bash", undefined)).toEqual({
      service: "terminal",
      actionType: "execute",
    });
    expect(mapCodexCliToolToShield("Bash")).toEqual({
      service: "terminal",
      actionType: "execute",
    });
  });

  it("maps MCP-style tool names to write when they would otherwise be execute-only unknowns", () => {
    expect(mapCodexCliToolToShield("mcp__myserver__do_thing")).toEqual({
      service: "mcp__myserver__do_thing",
      actionType: "write",
    });
  });

  it("unknown non-integration tool names map to write instead of execute", () => {
    expect(mapCodexCliToolToShield("my_custom_mcp_tool")).toEqual({
      service: "my_custom_mcp_tool",
      actionType: "write",
    });
  });

  it("keeps known OpenClaw tools at their mapped permission level", () => {
    expect(mapCodexCliToolToShield("slack")).toEqual({
      service: "slack",
      actionType: "execute",
    });
    expect(mapCodexCliToolToShield("read")).toEqual({
      service: "filesystem",
      actionType: "read",
    });
  });

  it("extractExecCommand extracts command from object", () => {
    expect(extractExecCommand({ command: "sudo apt update" })).toBe("sudo apt update");
  });

  it("extractExecCommand handles JSON string input", () => {
    expect(extractExecCommand(JSON.stringify({ command: "sudo apt update" }))).toBe(
      "sudo apt update",
    );
  });

  it("extractExecCommand returns undefined for null and undefined", () => {
    expect(extractExecCommand(null)).toBeUndefined();
    expect(extractExecCommand(undefined)).toBeUndefined();
  });

  it("extractExecCommand returns raw string for malformed JSON", () => {
    expect(extractExecCommand("{not valid json")).toBe("{not valid json");
  });

  describe("codexIsDestructiveExecCommand", () => {
    it("flags rm -rf /", () => {
      expect(codexIsDestructiveExecCommand("rm -rf /")).toBe(true);
    });

    it("does not flag grep with removeme in single quotes", () => {
      expect(codexIsDestructiveExecCommand("grep -r 'removeme' .")).toBe(false);
    });

    it("does not flag echo rm without shell operators", () => {
      expect(codexIsDestructiveExecCommand("echo rm")).toBe(false);
    });

    it("does not treat substring sudo in hyphenated token as sudo", () => {
      expect(codexIsDestructiveExecCommand("curl https://example.com/sudo-payload")).toBe(false);
    });

    it("still flags real sudo", () => {
      expect(codexIsDestructiveExecCommand("sudo ls")).toBe(true);
    });

    it("does not treat chmod inside double-quoted literal as chmod keyword after quote strip", () => {
      expect(codexIsDestructiveExecCommand('echo "chmod 755 setup.sh"')).toBe(false);
    });

    it("flags chmod when it is a real shell token", () => {
      expect(codexIsDestructiveExecCommand("chmod 755 setup.sh")).toBe(true);
    });

    it("flags destructive tokens after quoted segments", () => {
      expect(codexIsDestructiveExecCommand("grep -r 'x' . && rm -rf ./dist")).toBe(true);
    });
  });
});
