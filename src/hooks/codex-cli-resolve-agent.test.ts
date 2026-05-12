import { describe, expect, it } from "vitest";
import { resolveCodexCliAgentNameFromConfig } from "./codex-cli-resolve-agent.js";

describe("resolveCodexCliAgentNameFromConfig", () => {
  it("picks longest workspace path under cwd", () => {
    const obj = {
      agents: [
        { name: "a", platform: "codex-cli", workspacePath: "/tmp/proj" },
        { name: "b", platform: "codex-cli", workspacePath: "/tmp/proj/sub" },
        { name: "c", platform: "claude-code", workspacePath: "/tmp/proj/sub" },
      ],
      defaultAgent: "a",
    };
    expect(resolveCodexCliAgentNameFromConfig(obj, "/tmp/proj/sub/src")).toBe("b");
  });

  it("uses defaultAgent when cwd matches no workspace", () => {
    const obj = {
      agents: [
        { name: "x", platform: "codex-cli", workspacePath: "/other/repo" },
        { name: "y", platform: "codex-cli", workspacePath: "/another" },
      ],
      defaultAgent: "y",
    };
    expect(resolveCodexCliAgentNameFromConfig(obj, "/tmp/unrelated")).toBe("y");
  });

  it("falls back to first codex-cli agent when no workspace match and no default", () => {
    const obj = {
      agents: [
        { name: "first", platform: "codex-cli", workspacePath: "/a" },
        { name: "second", platform: "codex-cli", workspacePath: "/b" },
      ],
    };
    expect(resolveCodexCliAgentNameFromConfig(obj, "/zzz")).toBe("first");
  });

  it("uses legacy agentName when no agents array", () => {
    expect(resolveCodexCliAgentNameFromConfig({ agentName: "legacy-codex" }, "/tmp")).toBe(
      "legacy-codex",
    );
  });

  it("ignores defaultAgent when it is not a codex-cli agent", () => {
    const obj = {
      agents: [{ name: "only", platform: "codex-cli", workspacePath: "/x" }],
      defaultAgent: "not-listed",
    };
    expect(resolveCodexCliAgentNameFromConfig(obj, "/zzz")).toBe("only");
  });

  it("ignores agents for other platforms", () => {
    const obj = {
      agents: [
        { name: "cc-agent", platform: "claude-code", workspacePath: "/tmp/proj" },
        { name: "codex-agent", platform: "codex-cli", workspacePath: "/tmp/proj" },
      ],
    };
    expect(resolveCodexCliAgentNameFromConfig(obj, "/tmp/proj")).toBe("codex-agent");
  });
});
