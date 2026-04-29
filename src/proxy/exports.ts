/**
 * Subpath entry `multicorn-shield/proxy` for hosted proxy and tooling.
 *
 * @module proxy/exports
 */

export {
  parseJsonRpcLine,
  extractToolCallParams,
  buildBlockedResponse,
  buildSpendingBlockedResponse,
  buildInternalErrorResponse,
  buildServiceUnreachableResponse,
  buildAuthErrorResponse,
  extractServiceFromToolName,
  extractActionFromToolName,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  type ToolCallParams,
} from "./interceptor.js";

export {
  fetchGrantedScopes,
  findAgentByName,
  registerAgent,
  deriveDashboardUrl,
  ShieldAuthError,
  type AgentRecord,
} from "./consent.js";

export { createLogger, isValidLogLevel, type ProxyLogger, type LogLevel } from "./logger.js";

export { validateScopeAccess } from "../scopes/scope-validator.js";

export { mapMcpToolToScope } from "../mcp-tool-mapper.js";

export {
  createActionLogger,
  type ActionLogger,
  type ActionLoggerConfig,
  type ActionPayload,
} from "../logger/action-logger.js";

export type { Scope, PermissionLevel } from "../types/index.js";
