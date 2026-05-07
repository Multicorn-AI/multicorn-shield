import { describe, expect, it, vi } from "vitest";
import { extractExecCommand, mapClaudeCodeToolToShield } from "./claude-code-tool-map.js";
import { isDestructiveExecCommand } from "../openclaw/tool-mapper.js";

describe("claude-code-tool-map", () => {
  it("maps bash with safe command to terminal execute", () => {
    expect(mapClaudeCodeToolToShield("bash", { command: "ls" })).toEqual({
      service: "terminal",
      actionType: "execute",
    });
  });

  it("maps bash with destructive command to terminal write", () => {
    expect(mapClaudeCodeToolToShield("bash", { command: "rm -rf /tmp/x" })).toEqual({
      service: "terminal",
      actionType: "write",
    });
  });

  it("maps shell like bash", () => {
    expect(mapClaudeCodeToolToShield("shell", { command: "echo hi" })).toEqual({
      service: "terminal",
      actionType: "execute",
    });
  });

  it("maps read/write/edit via OpenClaw mapper", () => {
    expect(mapClaudeCodeToolToShield("read")).toEqual({
      service: "filesystem",
      actionType: "read",
    });
    expect(mapClaudeCodeToolToShield("write")).toEqual({
      service: "filesystem",
      actionType: "write",
    });
  });

  it("maps webfetch and task", () => {
    expect(mapClaudeCodeToolToShield("webfetch")).toEqual({
      service: "web",
      actionType: "read",
    });
    expect(mapClaudeCodeToolToShield("task")).toEqual({
      service: "subagent",
      actionType: "execute",
    });
  });

  it("maps slack_send_message style tools via prefix rules", () => {
    expect(mapClaudeCodeToolToShield("slack_send_message")).toEqual({
      service: "slack",
      actionType: "write",
    });
  });

  it("maps empty string toolName to unknown:execute", () => {
    expect(mapClaudeCodeToolToShield("")).toEqual({
      service: "unknown",
      actionType: "execute",
    });
    expect(mapClaudeCodeToolToShield("  ")).toEqual({
      service: "unknown",
      actionType: "execute",
    });
  });

  it("handles null and undefined toolInput without throwing", () => {
    expect(mapClaudeCodeToolToShield("bash", null)).toEqual({
      service: "terminal",
      actionType: "execute",
    });
    expect(mapClaudeCodeToolToShield("bash", undefined)).toEqual({
      service: "terminal",
      actionType: "execute",
    });
    expect(mapClaudeCodeToolToShield("bash")).toEqual({
      service: "terminal",
      actionType: "execute",
    });
  });

  it("unknown tool names fall through to default execute", () => {
    expect(mapClaudeCodeToolToShield("my_custom_mcp_tool")).toEqual({
      service: "my_custom_mcp_tool",
      actionType: "execute",
    });
    expect(mapClaudeCodeToolToShield("FooBarTool")).toEqual({
      service: "foobartool",
      actionType: "execute",
    });
  });

  it("maps stripe and payment tools to payments:write", () => {
    expect(mapClaudeCodeToolToShield("stripe")).toEqual({
      service: "payments",
      actionType: "write",
    });
    expect(mapClaudeCodeToolToShield("payments")).toEqual({
      service: "payments",
      actionType: "write",
    });
    expect(mapClaudeCodeToolToShield("payment")).toEqual({
      service: "payments",
      actionType: "write",
    });
  });

  it("maps google_calendar_delete via prefix to google_calendar:write", () => {
    expect(mapClaudeCodeToolToShield("google_calendar_delete")).toEqual({
      service: "google_calendar",
      actionType: "write",
    });
  });

  it("maps calendar_delete via prefix to google_calendar:write", () => {
    expect(mapClaudeCodeToolToShield("calendar_delete")).toEqual({
      service: "google_calendar",
      actionType: "write",
    });
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
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = extractExecCommand("{not valid json");
    expect(result).toBe("{not valid json");
    expect(stderrSpy).toHaveBeenCalledWith(
      "Shield: failed to parse tool input as JSON, using raw string\n",
    );
    stderrSpy.mockRestore();
  });

  it("isDestructiveExecCommand detects tab-separated commands", () => {
    expect(isDestructiveExecCommand("rm\t-rf")).toBe(true);
    expect(isDestructiveExecCommand("sudo\tapt\tupdate")).toBe(true);
    expect(isDestructiveExecCommand("echo\thello")).toBe(false);
  });
});
