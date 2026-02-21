/**
 * JSON-RPC message parsing and tool call interception for the MCP proxy.
 *
 * Handles the MCP stdio transport (newline-delimited JSON-RPC 2.0). Provides
 * types, parsers, and response builders used by the proxy to intercept
 * `tools/call` requests before they reach the wrapped MCP server.
 *
 * @module proxy/interceptor
 */

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
}

export interface ToolCallParams {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

// JSON-RPC server-defined error range starts at -32000
const BLOCKED_ERROR_CODE = -32000;
const SPENDING_BLOCKED_ERROR_CODE = -32001;

export function parseJsonRpcLine(line: string): JsonRpcRequest | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  return isJsonRpcRequest(parsed) ? parsed : null;
}

export function extractToolCallParams(request: JsonRpcRequest): ToolCallParams | null {
  if (request.method !== "tools/call") return null;
  if (typeof request.params !== "object" || request.params === null) return null;

  const params = request.params as Record<string, unknown>;
  const name = params["name"];
  const args = params["arguments"];

  if (typeof name !== "string") return null;
  if (typeof args !== "object" || args === null) return null;

  return { name, arguments: args as Record<string, unknown> };
}

export function buildBlockedResponse(
  id: string | number | null,
  service: string,
  permissionLevel: string,
): JsonRpcResponse {
  const displayService = capitalize(service);
  const message =
    `Action blocked by Multicorn Shield: agent does not have ${permissionLevel} access to ` +
    `${displayService}. Configure permissions at https://app.multicorn.ai`;

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: BLOCKED_ERROR_CODE,
      message,
    },
  };
}

export function buildSpendingBlockedResponse(
  id: string | number | null,
  reason: string,
): JsonRpcResponse {
  const message =
    `Action blocked by Multicorn Shield: ${reason}. ` +
    `Review spending limits at https://app.multicorn.ai`;

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: SPENDING_BLOCKED_ERROR_CODE,
      message,
    },
  };
}

export function extractServiceFromToolName(toolName: string): string {
  const idx = toolName.indexOf("_");
  return idx === -1 ? toolName : toolName.slice(0, idx);
}

export function extractActionFromToolName(toolName: string): string {
  const idx = toolName.indexOf("_");
  return idx === -1 ? "call" : toolName.slice(idx + 1);
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (obj["jsonrpc"] !== "2.0") return false;
  if (typeof obj["method"] !== "string") return false;

  const id = obj["id"];
  const validId =
    id === null || id === undefined || typeof id === "string" || typeof id === "number";

  return validId;
}

function capitalize(str: string): string {
  if (str.length === 0) return str;
  const first = str[0];
  return first !== undefined ? first.toUpperCase() + str.slice(1) : str;
}
