/**
 * MCP (Model Context Protocol) integration for Multicorn Shield.
 *
 * Provides the {@link createMcpAdapter} factory for routing MCP tool calls
 * through Shield's permission layer automatically.
 *
 * @module mcp
 */

export {
  createMcpAdapter,
  isBlockedResult,
  type McpToolCall,
  type McpToolResult,
  type McpBlockedResult,
  type McpAdapterResult,
  type McpToolHandler,
  type McpAdapter,
  type McpAdapterConfig,
} from "./mcp-adapter.js";
