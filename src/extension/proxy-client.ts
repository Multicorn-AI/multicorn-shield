/**
 * HTTP client for hosted Multicorn proxy URLs (JSON-RPC over Streamable HTTP).
 *
 * @module extension/proxy-client
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProxyLogger } from "../proxy/logger.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import { assertSafeProxyUrl } from "./proxy-url-validator.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

/** MCP tool shape from `tools/list` (subset used by Shield). */
export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface RoutedProxyTool extends McpToolDefinition {
  readonly sourceProxyUrl: string;
}

export interface ProxyToolRouterResult {
  readonly tools: readonly RoutedProxyTool[];
  readonly routing: ReadonlyMap<string, string>;
}

/** Row from GET /api/v1/proxy/config (matches dashboard wire format). */
export interface ProxyConfigItem {
  readonly proxy_url: string;
  readonly server_name: string;
  readonly target_url: string;
}

export class ProxyConfigFetchError extends Error {
  constructor(
    readonly kind: "network" | "auth" | "http" | "malformed",
    message: string,
  ) {
    super(message);
    this.name = "ProxyConfigFetchError";
  }
}

class ProxyTransportError extends Error {
  constructor(
    readonly kind: "network" | "http" | "malformed" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "ProxyTransportError";
  }
}

class ProxyRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ProxyRpcError";
  }
}

function truncateBody(text: string, max = 500): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

interface ApiSuccessShape {
  readonly success: true;
  readonly data: unknown;
}

function isApiSuccessShape(v: unknown): v is ApiSuccessShape {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o["success"] === true && "data" in o;
}

function isProxyConfigRow(v: unknown): v is ProxyConfigItem {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["proxy_url"] === "string" &&
    o["proxy_url"].length > 0 &&
    typeof o["server_name"] === "string" &&
    typeof o["target_url"] === "string"
  );
}

/**
 * Load proxy configs for the API key from the Shield API.
 */
export async function fetchProxyConfigs(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  options?: { allowPrivateNetworks?: boolean },
): Promise<readonly ProxyConfigItem[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/proxy/config`;
  assertSafeProxyUrl(
    url,
    options?.allowPrivateNetworks === true ? { allowPrivateNetworks: true } : undefined,
  );
  let response: Response;
  try {
    /* Must use X-Multicorn-Key for Shield API (not Bearer). */
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Multicorn-Key": apiKey,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProxyConfigFetchError(
      "network",
      "Could not reach Shield API to load proxy configs. Check your network and base URL.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProxyConfigFetchError(
      "auth",
      "Shield API key is invalid or revoked. Update the Multicorn Shield extension settings in Claude Desktop.",
    );
  }

  if (!response.ok) {
    const snippet = await response.text().catch(() => "");
    throw new ProxyConfigFetchError(
      "http",
      `Shield API returned HTTP ${String(response.status)}${snippet ? `: ${truncateBody(snippet)}` : ""}`,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ProxyConfigFetchError(
      "malformed",
      "Shield API returned a non-json body for proxy config.",
    );
  }

  if (!isApiSuccessShape(json)) {
    throw new ProxyConfigFetchError(
      "malformed",
      "Unexpected response envelope from Shield API for proxy config.",
    );
  }

  const data = json.data;
  if (!Array.isArray(data)) {
    return [];
  }

  const out: ProxyConfigItem[] = [];
  for (const row of data) {
    if (isProxyConfigRow(row)) {
      out.push(row);
    }
  }
  return out;
}

function isToolDefinition(value: unknown): value is McpToolDefinition {
  if (typeof value !== "object" || value === null) return false;
  const name = (value as Record<string, unknown>)["name"];
  return typeof name === "string" && name.length > 0;
}

export function parseToolsListResult(result: unknown): readonly McpToolDefinition[] {
  if (typeof result !== "object" || result === null) return [];
  const tools = (result as Record<string, unknown>)["tools"];
  if (!Array.isArray(tools)) return [];

  const out: McpToolDefinition[] = [];
  for (const t of tools) {
    if (isToolDefinition(t)) {
      const row = t as unknown as Record<string, unknown>;
      const def: McpToolDefinition = {
        name: t.name,
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        ...(row["inputSchema"] !== undefined ? { inputSchema: row["inputSchema"] } : {}),
      };
      out.push(def);
    }
  }
  return out;
}

/**
 * Merges tool lists keyed by proxy URL. Duplicate tool names: first proxy in iteration order wins.
 */
export function buildProxyToolRouter(
  toolsByProxyUrl: ReadonlyMap<string, readonly McpToolDefinition[]>,
  logger: ProxyLogger,
): ProxyToolRouterResult {
  const routing = new Map<string, string>();
  const tools: RoutedProxyTool[] = [];

  for (const [proxyUrl, list] of toolsByProxyUrl) {
    for (const tool of list) {
      if (!isToolDefinition(tool)) continue;
      const name = tool.name;
      if (routing.has(name)) {
        const existing = routing.get(name);
        logger.warn("Skipping duplicate tool name from hosted proxy.", {
          tool: name,
          skippedProxy: proxyUrl,
          keptProxy: existing ?? "",
        });
        continue;
      }
      routing.set(name, proxyUrl);
      const routed: RoutedProxyTool = {
        name,
        sourceProxyUrl: proxyUrl,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      };
      tools.push(routed);
    }
  }

  return { tools, routing };
}

function asCallToolResult(value: unknown): CallToolResult {
  if (typeof value !== "object" || value === null) {
    return { content: [{ type: "text", text: String(value) }] };
  }
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj["content"])) {
    return value as CallToolResult;
  }
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function parseJsonObjectFromBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new ProxyTransportError("malformed", "Hosted proxy returned an empty body.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (t.length === 0 || t.startsWith(":")) continue;
      if (t.startsWith("data:")) {
        const payload = t.slice("data:".length).trim();
        if (payload.length === 0) continue;
        try {
          return JSON.parse(payload);
        } catch {
          continue;
        }
      }
      if (t.startsWith("{")) {
        try {
          return JSON.parse(t);
        } catch {
          continue;
        }
      }
    }
    throw new ProxyTransportError(
      "malformed",
      `Could not parse JSON-RPC response from hosted proxy: ${truncateBody(trimmed, 200)}`,
    );
  }
}

export interface ProxySessionOptions {
  readonly requestTimeoutMs?: number;
  readonly allowPrivateNetworks?: boolean;
}

/**
 * One MCP session to a hosted proxy base URL (Bearer API key).
 */
export class ProxySession {
  private readonly proxyUrl: string;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private sessionId: string | null = null;
  private closed = false;

  constructor(proxyUrl: string, apiKey: string, options?: ProxySessionOptions) {
    assertSafeProxyUrl(
      proxyUrl,
      options?.allowPrivateNetworks === true ? { allowPrivateNetworks: true } : undefined,
    );
    this.proxyUrl = proxyUrl.replace(/\/+$/, "") + "/mcp";
    this.apiKey = apiKey;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 60_000;
  }

  /**
   * Drops session state and best-effort HTTP DELETE for Streamable HTTP session cleanup when supported.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const sid = this.sessionId;
    this.sessionId = null;
    if (sid === null || sid.length === 0) {
      return;
    }
    try {
      await fetch(this.proxyUrl, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "MCP-Session-Id": sid,
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* ignore: many upstreams return 405 or ignore DELETE */
    }
  }

  async initialize(): Promise<void> {
    if (this.closed) {
      throw new ProxyTransportError("malformed", "Proxy session is closed.");
    }
    await this.postRpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "multicorn-shield-extension", version: PACKAGE_VERSION },
    });
    await this.postNotify("notifications/initialized", {});
  }

  async listTools(): Promise<readonly McpToolDefinition[]> {
    if (this.closed) {
      throw new ProxyTransportError("malformed", "Proxy session is closed.");
    }
    try {
      const rawResult = await this.postRpc("tools/list", {});
      if (typeof rawResult !== "object" || rawResult === null) {
        return [];
      }
      return parseToolsListResult(rawResult);
    } catch (e) {
      if (e instanceof ProxyRpcError) {
        throw new ProxyTransportError("malformed", `tools/list failed: ${e.message}`);
      }
      throw e;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (this.closed) {
      return {
        isError: true,
        content: [{ type: "text", text: "Proxy session is closed. Restart Claude Desktop." }],
      };
    }
    try {
      const rawResult = await this.postRpc("tools/call", { name, arguments: args });
      return asCallToolResult(rawResult);
    } catch (e) {
      if (e instanceof ProxyRpcError) {
        return {
          isError: true,
          content: [{ type: "text", text: e.message }],
        };
      }
      if (e instanceof ProxyTransportError) {
        return {
          isError: true,
          content: [{ type: "text", text: friendlyTransportMessage(e) }],
        };
      }
      const message = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool call failed: ${message}`,
          },
        ],
      };
    }
  }

  private captureSessionFromResponse(response: Response): void {
    const sid = response.headers.get("mcp-session-id") ?? response.headers.get("MCP-Session-Id");
    if (typeof sid === "string" && sid.length > 0) {
      this.sessionId = sid;
    }
  }

  private async postRpc(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    const payload: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) {
      payload["params"] = params;
    }

    let response: Response;
    try {
      response = await fetch(this.proxyUrl, {
        method: "POST",
        headers: this.buildPostHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("abort") || msg.includes("Timeout")) {
        throw new ProxyTransportError(
          "timeout",
          `Request to hosted proxy timed out after ${String(this.requestTimeoutMs / 1000)}s (${method}).`,
        );
      }
      throw new ProxyTransportError(
        "network",
        `Could not reach hosted proxy for ${method}: ${msg}`,
      );
    }

    this.captureSessionFromResponse(response);

    const text = await response.text().catch(() => "");

    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new ProxyTransportError(
        "http",
        `Hosted proxy or upstream MCP server was unavailable (HTTP ${String(response.status)}). Try again shortly.`,
      );
    }

    if (!response.ok) {
      throw new ProxyTransportError(
        "http",
        `Hosted proxy returned HTTP ${String(response.status)}${text ? `: ${truncateBody(text)}` : ""}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = parseJsonObjectFromBody(text);
    } catch (e) {
      if (e instanceof ProxyTransportError) {
        throw e;
      }
      throw new ProxyTransportError(
        "malformed",
        "Hosted proxy returned a body that was not valid JSON-RPC.",
      );
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new ProxyTransportError(
        "malformed",
        "Hosted proxy returned an invalid JSON-RPC envelope.",
      );
    }

    const obj = parsed as Record<string, unknown>;
    if (obj["error"] !== undefined) {
      const err = obj["error"] as Record<string, unknown>;
      const code = typeof err["code"] === "number" ? err["code"] : -1;
      const message =
        typeof err["message"] === "string"
          ? err["message"]
          : "Hosted proxy returned a JSON-RPC error.";
      throw new ProxyRpcError(code, message);
    }

    return obj["result"];
  }

  private async postNotify(method: string, params?: unknown): Promise<void> {
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      payload["params"] = params;
    }

    let response: Response;
    try {
      response = await fetch(this.proxyUrl, {
        method: "POST",
        headers: this.buildPostHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProxyTransportError("network", `Could not send ${method} to hosted proxy: ${msg}`);
    }

    this.captureSessionFromResponse(response);
    const text = await response.text().catch(() => "");

    if (!response.ok) {
      throw new ProxyTransportError(
        "http",
        `Hosted proxy returned HTTP ${String(response.status)} for ${method}${text ? `: ${truncateBody(text)}` : ""}`,
      );
    }

    if (text.trim().length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = parseJsonObjectFromBody(text);
    } catch {
      return;
    }

    if (typeof parsed === "object" && parsed !== null) {
      const err = (parsed as Record<string, unknown>)["error"];
      if (typeof err === "object" && err !== null) {
        const message =
          typeof (err as Record<string, unknown>)["message"] === "string"
            ? ((err as Record<string, unknown>)["message"] as string)
            : "Notification rejected by hosted proxy.";
        throw new ProxyTransportError("http", message);
      }
    }
  }

  private buildPostHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.apiKey}`,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    };
    if (this.sessionId !== null && this.sessionId.length > 0) {
      h["MCP-Session-Id"] = this.sessionId;
    }
    return h;
  }
}

function friendlyTransportMessage(e: ProxyTransportError): string {
  if (e.kind === "timeout") {
    return e.message;
  }
  if (e.kind === "network") {
    return `${e.message} Check your network and that the hosted proxy URL from the dashboard is correct.`;
  }
  if (e.kind === "http") {
    return `${e.message} See your Multicorn dashboard for proxy and MCP server status.`;
  }
  return e.message;
}

/**
 * Whether a tool result looks like a permission block (open consent once).
 */
export function resultSuggestsConsentNeeded(result: CallToolResult): boolean {
  if (result.isError !== true) return false;
  const first = result.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    return false;
  }
  const t = first.text;
  return (
    t.includes("Action blocked by Shield") ||
    t.includes("Permission required") ||
    t.includes("This agent cannot use") ||
    (t.includes("does not have") && t.includes("access to")) ||
    t.includes("Configure permissions:")
  );
}
