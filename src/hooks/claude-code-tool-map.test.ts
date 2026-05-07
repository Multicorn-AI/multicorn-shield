import { describe, expect, it } from "vitest";
import { extractExecCommand, mapClaudeCodeToolToShield } from "./claude-code-tool-map.js";

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

  it("extractExecCommand handles JSON string input", () => {
    expect(extractExecCommand(JSON.stringify({ command: "sudo apt update" }))).toBe(
      "sudo apt update",
    );
  });
});
