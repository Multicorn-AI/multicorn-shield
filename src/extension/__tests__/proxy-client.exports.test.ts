import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  fetchProxyConfigs,
  parseToolsListResult,
  buildProxyToolRouter,
  resultSuggestsConsentNeeded,
  ProxyConfigFetchError,
} from "../proxy-client.js";
import type { ProxyLogger } from "../../proxy/logger.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchProxyConfigs", () => {
  it("returns parsed proxy rows on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          success: true,
          data: [
            {
              proxy_url: "https://p.example/mcp",
              server_name: "s1",
              target_url: "https://upstream",
            },
          ],
        }),
    });

    const rows = await fetchProxyConfigs("https://api.example/", "mcs_key", 5000);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.proxy_url).toBe("https://p.example/mcp");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example/api/v1/proxy/config",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Multicorn-Key": "mcs_key" }) as Record<
          string,
          string
        >,
      }),
    );
  });

  it("throws auth ProxyConfigFetchError on 401", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    await expect(fetchProxyConfigs("https://api.example", "k", 5000)).rejects.toBeInstanceOf(
      ProxyConfigFetchError,
    );
  });

  it("throws network ProxyConfigFetchError when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    await expect(fetchProxyConfigs("https://api.example", "k", 5000)).rejects.toMatchObject({
      kind: "network",
    });
  });
});

describe("parseToolsListResult", () => {
  it("returns empty array for non-object input", () => {
    expect(parseToolsListResult(null)).toEqual([]);
    expect(parseToolsListResult("x")).toEqual([]);
  });

  it("parses tools with optional description and inputSchema", () => {
    const parsed = parseToolsListResult({
      tools: [
        { name: "a", description: "d", inputSchema: { type: "object" } },
        { name: "", invalid: true },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      name: "a",
      description: "d",
      inputSchema: { type: "object" },
    });
  });
});

describe("buildProxyToolRouter", () => {
  it("merges tools and skips duplicate names with a warning", () => {
    const warn = vi.fn();
    const logger: ProxyLogger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const map = new Map<string, readonly { name: string; description?: string }[]>([
      ["https://proxy-a", [{ name: "t1" }, { name: "dup" }]],
      ["https://proxy-b", [{ name: "dup" }, { name: "t2" }]],
    ]);

    const { tools, routing } = buildProxyToolRouter(map, logger);

    expect(tools.map((t) => t.name).sort()).toEqual(["dup", "t1", "t2"]);
    expect(routing.get("dup")).toBe("https://proxy-a");
    expect(warn).toHaveBeenCalledWith(
      "Skipping duplicate tool name from hosted proxy.",
      expect.objectContaining({ tool: "dup" }),
    );
  });
});

describe("resultSuggestsConsentNeeded", () => {
  it("returns false when not an error result", () => {
    const r: CallToolResult = { content: [{ type: "text", text: "ok" }] };
    expect(resultSuggestsConsentNeeded(r)).toBe(false);
  });

  it("returns true when error text mentions Shield block", () => {
    const r: CallToolResult = {
      isError: true,
      content: [{ type: "text", text: "Action blocked by Shield" }],
    };
    expect(resultSuggestsConsentNeeded(r)).toBe(true);
  });

  it("returns true for permission wording", () => {
    const r: CallToolResult = {
      isError: true,
      content: [{ type: "text", text: "Agent does not have access to gmail" }],
    };
    expect(resultSuggestsConsentNeeded(r)).toBe(true);
  });
});
