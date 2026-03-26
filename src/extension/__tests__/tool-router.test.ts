/**
 * @vitest-environment node
 */

import { describe, it, expect, vi } from "vitest";
import { buildToolRouter, parseToolsListResult } from "../tool-router.js";
import { createLogger } from "../../proxy/logger.js";

describe("tool-router", () => {
  it("keeps the first server when two children expose the same tool name", () => {
    const warn = vi.fn();
    const logger = createLogger("error");
    logger.warn = warn;

    const toolsByServer = new Map([
      ["first", [{ name: "dup", description: "a" }]],
      ["second", [{ name: "dup", description: "b" }]],
    ]);

    const { tools, routing } = buildToolRouter(toolsByServer, logger);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.sourceServerName).toBe("first");
    expect(routing.get("dup")).toBe("first");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("parseToolsListResult extracts tool definitions", () => {
    const list = parseToolsListResult({
      tools: [
        { name: "t1", description: "d", inputSchema: { type: "object" } },
        { name: "", description: "skip" },
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("t1");
  });
});
