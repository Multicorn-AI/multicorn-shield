/**
 * Merges tool lists from multiple MCP children. Duplicate tool names: first wins.
 *
 * @module extension/tool-router
 */

import type { ProxyLogger } from "../proxy/logger.js";

/** MCP tool shape from `tools/list` (subset used by Shield). */
export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface RoutedTool extends McpToolDefinition {
  readonly sourceServerName: string;
}

export interface ToolRouterResult {
  readonly tools: readonly RoutedTool[];
  readonly routing: ReadonlyMap<string, string>;
}

function isToolDefinition(value: unknown): value is McpToolDefinition {
  if (typeof value !== "object" || value === null) return false;
  const name = (value as Record<string, unknown>)["name"];
  return typeof name === "string" && name.length > 0;
}

/**
 * Builds the combined tool list and a map from tool name to originating server key.
 * When two children expose the same tool name, the first server in iteration order wins;
 * the duplicate is skipped and a warning is logged.
 */
export function buildToolRouter(
  toolsByServer: ReadonlyMap<string, readonly McpToolDefinition[]>,
  logger: ProxyLogger,
): ToolRouterResult {
  const routing = new Map<string, string>();
  const tools: RoutedTool[] = [];

  for (const [serverName, list] of toolsByServer) {
    for (const tool of list) {
      if (!isToolDefinition(tool)) continue;
      const name = tool.name;
      if (routing.has(name)) {
        const existing = routing.get(name);
        logger.warn("Skipping duplicate tool name from MCP server.", {
          tool: name,
          skippedServer: serverName,
          keptServer: existing ?? "",
        });
        continue;
      }
      routing.set(name, serverName);
      const routed: RoutedTool = {
        name,
        sourceServerName: serverName,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      };
      tools.push(routed);
    }
  }

  return { tools, routing };
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
