/**
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchProxyConfigs,
  ProxyConfigFetchError,
  ProxySession,
  buildProxyToolRouter,
  parseToolsListResult,
  resultSuggestsConsentNeeded,
} from "../proxy-client.js";
import { createLogger } from "../../proxy/logger.js";

describe("fetchProxyConfigs", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns proxy rows from a successful Shield envelope", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              proxy_url: "https://proxy.example/r/t1/mcp",
              server_name: "s1",
              target_url: "https://upstream/mcp",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const rows = await fetchProxyConfigs("https://api.multicorn.ai", "k", 5000);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.proxy_url).toBe("https://proxy.example/r/t1/mcp");
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "https://api.multicorn.ai/api/v1/proxy/config",
    );
    const init = vi.mocked(fetch).mock.calls[0]?.[1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(init?.headers?.["X-Multicorn-Key"]).toBe("k");
  });

  it("returns an empty list when data is not an array", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const rows = await fetchProxyConfigs("https://api.example/", "k", 5000);
    expect(rows).toEqual([]);
  });

  it("throws ProxyConfigFetchError auth on 401", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 401 }));

    await expect(fetchProxyConfigs("https://api.example", "k", 5000)).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("throws network when fetch rejects", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));

    await expect(fetchProxyConfigs("https://api.example", "k", 5000)).rejects.toBeInstanceOf(
      ProxyConfigFetchError,
    );
  });

  it("throws malformed when the response body is not JSON", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(fetchProxyConfigs("https://api.example", "k", 5000)).rejects.toMatchObject({
      kind: "malformed",
    });
  });

  it("throws malformed when the envelope is not success", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: { message: "no" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchProxyConfigs("https://api.example", "k", 5000)).rejects.toMatchObject({
      kind: "malformed",
    });
  });

  it("throws http when the API returns a non-2xx status with a body snippet", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("rate limited", { status: 429, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(fetchProxyConfigs("https://api.example", "k", 5000)).rejects.toMatchObject({
      kind: "http",
    });
  });

  it("skips invalid rows inside a successful data array", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              proxy_url: "https://p.example/mcp",
              server_name: "good",
              target_url: "https://u/mcp",
            },
            { proxy_url: "bad" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const rows = await fetchProxyConfigs("https://api.example", "k", 5000);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.server_name).toBe("good");
  });
});

describe("buildProxyToolRouter", () => {
  it("keeps the first proxy when two URLs expose the same tool name", () => {
    const warn = vi.fn();
    const logger = createLogger("error");
    logger.warn = warn;

    const toolsByProxy = new Map([
      ["https://a/r/1/mcp", [{ name: "dup", description: "first" }]],
      ["https://b/r/2/mcp", [{ name: "dup", description: "second" }]],
    ]);

    const { tools, routing } = buildProxyToolRouter(toolsByProxy, logger);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.sourceProxyUrl).toBe("https://a/r/1/mcp");
    expect(routing.get("dup")).toBe("https://a/r/1/mcp");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("parseToolsListResult", () => {
  it("extracts tool definitions and skips invalid rows", () => {
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

describe("resultSuggestsConsentNeeded", () => {
  it("returns true for blocked Shield permission messages", () => {
    expect(
      resultSuggestsConsentNeeded({
        isError: true,
        content: [
          {
            type: "text",
            text: "Action blocked by Multicorn Shield: agent does not have write access to Gmail. Configure permissions at https://app.example",
          },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      resultSuggestsConsentNeeded({
        isError: true,
        content: [{ type: "text", text: "Unknown upstream failure" }],
      }),
    ).toBe(false);
  });
});

describe("ProxySession", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs initialize, notification, tools/list, and tools/call over HTTP", async () => {
    const f = vi.mocked(fetch);
    f.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: {} },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", "mcp-session-id": "sess-1" },
        },
      ),
    );
    f.mockResolvedValueOnce(
      new Response("", { status: 200, headers: { "mcp-session-id": "sess-1" } }),
    );
    f.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { tools: [{ name: "grep", description: "search" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    f.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const session = new ProxySession("https://proxy.example/mcp", "api-key", {
      requestTimeoutMs: 5000,
    });
    await session.initialize();
    const tools = await session.listTools();
    expect(tools.map((t) => t.name)).toEqual(["grep"]);

    const result = await session.callTool("grep", { pattern: "x" });
    expect(result.isError).not.toBe(true);
    const firstBlock = result.content[0];
    expect(firstBlock).toMatchObject({ type: "text", text: "ok" });

    const initCall = f.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(initCall?.headers?.["Authorization"]).toBe("Bearer api-key");
    await session.close();
  });

  it("returns isError for JSON-RPC errors from tools/call", async () => {
    const f = vi.mocked(fetch);
    f.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: {} },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    f.mockResolvedValueOnce(new Response("", { status: 200 }));
    f.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32000, message: "Action blocked by Multicorn Shield: no access" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const session = new ProxySession("https://proxy.example/mcp", "k");
    await session.initialize();
    const result = await session.callTool("t", {});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Action blocked");
    await session.close();
  });

  it("returns isError for HTTP 502 without throwing", async () => {
    const f = vi.mocked(fetch);
    f.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    f.mockResolvedValueOnce(new Response("", { status: 200 }));
    f.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));

    const session = new ProxySession("https://proxy.example/mcp", "k");
    await session.initialize();
    const result = await session.callTool("t", {});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("502");
    await session.close();
  });

  it("returns isError when response body is not valid JSON-RPC", async () => {
    const f = vi.mocked(fetch);
    f.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    f.mockResolvedValueOnce(new Response("", { status: 200 }));
    f.mockResolvedValueOnce(
      new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const session = new ProxySession("https://proxy.example/mcp", "k");
    await session.initialize();
    const result = await session.callTool("t", {});
    expect(result.isError).toBe(true);
    await session.close();
  });

  it("initialize fails when notifications/initialized returns a JSON-RPC error body", async () => {
    const f = vi.mocked(fetch);
    f.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    f.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32600, message: "rejected notification" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const session = new ProxySession("https://proxy.example/mcp", "k");
    await expect(session.initialize()).rejects.toThrow(/rejected notification/);
  });

  it("initialize fails when the notification request cannot reach the network", async () => {
    const f = vi.mocked(fetch);
    f.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    f.mockRejectedValueOnce(new Error("econnreset"));

    const session = new ProxySession("https://proxy.example/mcp", "k");
    await expect(session.initialize()).rejects.toThrow(/notifications\/initialized/);
  });

  it("listTools throws when tools/list receives HTTP 503", async () => {
    const f = vi.mocked(fetch);
    f.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    f.mockResolvedValueOnce(new Response("", { status: 200 }));
    f.mockResolvedValueOnce(new Response("upstream", { status: 503 }));

    const session = new ProxySession("https://proxy.example/mcp", "k");
    await session.initialize();
    await expect(session.listTools()).rejects.toThrow(/unavailable/);
    await session.close();
  });

  it("close sends DELETE with the MCP session id when the server returned one", async () => {
    const f = vi.mocked(fetch);
    f.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "mcp-session-id": "sess-xyz",
        },
      }),
    );
    f.mockResolvedValueOnce(new Response("", { status: 200 }));

    const session = new ProxySession("https://proxy.example/mcp", "k");
    await session.initialize();
    await session.close();

    const deleteCall = f.mock.calls.find((c) => (c[1] as { method?: string }).method === "DELETE");
    if (deleteCall === undefined) {
      throw new Error("expected a DELETE request to close the MCP session");
    }
    const headers = (deleteCall[1] as { headers?: Record<string, string> }).headers ?? {};
    expect(headers["MCP-Session-Id"] ?? headers["mcp-session-id"]).toBe("sess-xyz");
  });
});
