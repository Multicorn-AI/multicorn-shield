import { describe, expect, it } from "vitest";
import { extractExecCommand, mapCodexCliToolToShield } from "./codex-cli-tool-map.js";

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

  it("maps apply_patch to filesystem write (future)", () => {
    expect(mapCodexCliToolToShield("apply_patch")).toEqual({
      service: "filesystem",
      actionType: "write",
    });
  });

  it("maps Edit and Write to filesystem write (future)", () => {
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

  it("unknown tool names fall through to mapToolToScope", () => {
    expect(mapCodexCliToolToShield("my_custom_mcp_tool")).toEqual({
      service: "my_custom_mcp_tool",
      actionType: "execute",
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
});
