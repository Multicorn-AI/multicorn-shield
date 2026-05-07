import { describe, expect, it } from "vitest";
import { resolveClaudeCodeAgentNameFromConfig } from "./claude-code-resolve-agent.js";

describe("resolveClaudeCodeAgentNameFromConfig", () => {
  it("picks longest workspace path under cwd", () => {
    const obj = {
      agents: [
        { name: "a", platform: "claude-code", workspacePath: "/tmp/proj" },
        { name: "b", platform: "claude-code", workspacePath: "/tmp/proj/sub" },
        { name: "c", platform: "openclaw", workspacePath: "/tmp/proj/sub" },
      ],
      defaultAgent: "a",
    };
    expect(resolveClaudeCodeAgentNameFromConfig(obj, "/tmp/proj/sub/src")).toBe("b");
  });

  it("uses defaultAgent when cwd matches no workspace", () => {
    const obj = {
      agents: [
        { name: "x", platform: "claude-code", workspacePath: "/other/repo" },
        { name: "y", platform: "claude-code", workspacePath: "/another" },
      ],
      defaultAgent: "y",
    };
    expect(resolveClaudeCodeAgentNameFromConfig(obj, "/tmp/unrelated")).toBe("y");
  });

  it("falls back to first claude-code agent when no workspace match and no default", () => {
    const obj = {
      agents: [
        { name: "first", platform: "claude-code", workspacePath: "/a" },
        { name: "second", platform: "claude-code", workspacePath: "/b" },
      ],
    };
    expect(resolveClaudeCodeAgentNameFromConfig(obj, "/zzz")).toBe("first");
  });

  it("uses legacy agentName when no agents array", () => {
    expect(resolveClaudeCodeAgentNameFromConfig({ agentName: "legacy-cc" }, "/tmp")).toBe(
      "legacy-cc",
    );
  });

  it("ignores defaultAgent when it is not a claude-code agent", () => {
    const obj = {
      agents: [{ name: "only", platform: "claude-code", workspacePath: "/x" }],
      defaultAgent: "not-listed",
    };
    expect(resolveClaudeCodeAgentNameFromConfig(obj, "/zzz")).toBe("only");
  });
});
