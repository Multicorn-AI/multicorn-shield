/**
 * MCP (Model Context Protocol) adapter for Multicorn Shield.
 *
 * Sits between the AI agent and the MCP server, enforcing Shield's permission
 * layer on every tool call. Permitted actions are forwarded to the underlying
 * MCP handler; blocked actions are returned immediately as structured objects
 * without reaching the server.
 *
 * **Flow:** agent → {@link McpAdapter.intercept} (Shield check) → MCP handler
 *
 * **Design principles:**
 * - Blocks are enforced, not advisory. Blocked tool calls never reach the server.
 * - Every intercepted call is logged, permitted and blocked alike.
 * - Structured block results carry a descriptive reason so callers can surface
 *   meaningful feedback rather than opaque errors.
 * - Naming conventions are configurable: bring your own service/action extractor
 *   if your tool names don't follow the default `service_action` pattern.
 *
 * @example Basic MCP integration
 * ```ts
 * import { createMcpAdapter, isBlockedResult } from "multicorn-shield/mcp";
 * import { createActionLogger } from "multicorn-shield";
 *
 * const logger = createActionLogger({ apiKey: "mcs_your_key_here" });
 *
 * const adapter = createMcpAdapter({
 *   agentId: "inbox-assistant",
 *   grantedScopes: [
 *     { service: "gmail", permissionLevel: "execute" },
 *     { service: "calendar", permissionLevel: "read" },
 *   ],
 *   logger,
 * });
 *
 * // Wrap your MCP server calls with adapter.intercept:
 * const result = await adapter.intercept(
 *   { toolName: "gmail_send_email", arguments: { to: "user@example.com" } },
 *   (call) => mcpServer.callTool(call.toolName, call.arguments),
 * );
 *
 * if (isBlockedResult(result)) {
 *   console.error(`Blocked: ${result.reason}`);
 * } else {
 *   console.log(result.content);
 * }
 * ```
 *
 * @module mcp/mcp-adapter
 */

import { PERMISSION_LEVELS, ACTION_STATUSES } from "../types/index.js";
import type { Scope, PermissionLevel, ActionStatus } from "../types/index.js";
import { validateScopeAccess } from "../scopes/scope-validator.js";
import type { ActionLogger } from "../logger/action-logger.js";
import { requiresContentReview, isPublicContentAction } from "../scopes/content-review-detector.js";

// ---------------------------------------------------------------------------
// MCP tool call types
// ---------------------------------------------------------------------------

/**
 * An MCP tool call received from an AI agent.
 *
 * Passed to {@link McpAdapter.intercept} before being forwarded to the MCP
 * server. The `toolName` is used to derive the target service and action type
 * for Shield's permission check.
 *
 * @example
 * ```ts
 * const call: McpToolCall = {
 *   toolName: "gmail_send_email",
 *   arguments: { to: "colleague@example.com", subject: "Update" },
 * };
 * ```
 */
export interface McpToolCall {
  /**
   * The MCP tool name identifying which tool the agent wants to invoke.
   *
   * By default, Shield splits on the first underscore to derive the service
   * name, e.g. `"gmail_send_email"` → service `"gmail"`, action `"send_email"`.
   * Override this with {@link McpAdapterConfig.extractService} and
   * {@link McpAdapterConfig.extractAction} for non-standard naming conventions.
   */
  readonly toolName: string;

  /**
   * The arguments provided by the agent for this tool invocation.
   * Passed through unmodified to the handler when the action is permitted.
   */
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * The result returned by an MCP server handler after a successful tool call.
 */
export interface McpToolResult {
  /** The response content from the MCP server tool. */
  readonly content: unknown;

  /**
   * When `true`, the tool itself encountered an error, distinct from a
   * Shield block or a network failure.
   */
  readonly isError?: boolean;
}

/**
 * The result returned by Shield when a tool call is blocked.
 *
 * Use {@link isBlockedResult} to distinguish this from a {@link McpToolResult}:
 *
 * ```ts
 * if (isBlockedResult(result)) {
 *   // result is McpBlockedResult
 *   console.error(result.reason);
 * }
 * ```
 */
export interface McpBlockedResult {
  /** Always `true`. Use this as the discriminant in type narrowing. */
  readonly blocked: true;

  /** Human-readable explanation of why the action was blocked. */
  readonly reason: string;

  /** The original tool name from the intercepted call. */
  readonly toolName: string;

  /** The service name derived from the tool name (e.g. `"gmail"`). */
  readonly service: string;

  /** The action type derived from the tool name (e.g. `"send_email"`). */
  readonly action: string;
}

/**
 * The result of passing a tool call through {@link McpAdapter.intercept}.
 *
 * - {@link McpToolResult}: the action was permitted and the handler ran.
 * - {@link McpBlockedResult}: Shield blocked the action before it reached the handler.
 *
 * Use {@link isBlockedResult} to narrow the type safely.
 */
export type McpAdapterResult = McpToolResult | McpBlockedResult;

/**
 * A function that handles an MCP tool call by forwarding it to the MCP server.
 *
 * Wrap your MCP client with this signature and pass it to
 * {@link McpAdapter.intercept}:
 *
 * ```ts
 * const handler: McpToolHandler = (call) =>
 *   mcpServer.callTool(call.toolName, call.arguments);
 * ```
 */
export type McpToolHandler = (call: McpToolCall) => Promise<McpToolResult>;

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link createMcpAdapter}.
 *
 * @example
 * ```ts
 * const adapter = createMcpAdapter({
 *   agentId: "inbox-assistant",
 *   grantedScopes: [{ service: "gmail", permissionLevel: "execute" }],
 *   logger: createActionLogger({ apiKey: "mcs_..." }),
 * });
 * ```
 */
export interface McpAdapterConfig {
  /**
   * The identifier of the agent making MCP tool calls.
   * Used when logging actions to the Multicorn audit trail.
   */
  readonly agentId: string;

  /**
   * The permission scopes granted to this agent via the consent screen.
   * Every tool call is validated against this set before being forwarded.
   */
  readonly grantedScopes: readonly Scope[];

  /**
   * Optional action logger for recording permitted and blocked tool calls.
   * When omitted, actions are checked but not logged.
   */
  readonly logger?: ActionLogger;

  /**
   * The permission level required for MCP tool calls.
   * Defaults to `"execute"`. MCP tools trigger side-effects by design.
   *
   * Override this when your tools only require `"read"` or `"write"` access.
   */
  readonly requiredPermissionLevel?: PermissionLevel;

  /**
   * Custom function to extract the service name from an MCP tool name.
   *
   * Default: the segment before the first `_` character.
   * `"gmail_send_email"` → `"gmail"`.
   *
   * Override for non-standard naming conventions:
   * ```ts
   * extractService: (toolName) => toolName.split(":")[0] ?? toolName,
   * ```
   */
  readonly extractService?: (toolName: string) => string;

  /**
   * Custom function to extract the action type from an MCP tool name.
   *
   * Default: the segment after the first `_` character.
   * `"gmail_send_email"` → `"send_email"`. Returns `"call"` when no `_` is present.
   *
   * Override for non-standard naming conventions:
   * ```ts
   * extractAction: (toolName) => toolName.split(":")[1] ?? "call",
   * ```
   */
  readonly extractAction?: (toolName: string) => string;

  /**
   * Optional function to check if an agent has auto-approval enabled for public content.
   * If provided and returns true, public content actions will bypass the review queue.
   *
   * If not provided, public content actions will always require review.
   */
  readonly checkAutoApprove?: (agentId: string) => Promise<boolean> | boolean;

  /**
   * Optional base URL for making API calls to check agent settings.
   * Used with apiKey to fetch auto-approval status if checkAutoApprove is not provided.
   */
  readonly baseUrl?: string;

  /**
   * Optional API key for making API calls to check agent settings.
   * Used with baseUrl to fetch auto-approval status if checkAutoApprove is not provided.
   */
  readonly apiKey?: string;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * The MCP adapter produced by {@link createMcpAdapter}.
 *
 * Acts as middleware between the AI agent and the MCP server, enforcing
 * Shield's permission layer on every tool call.
 */
export interface McpAdapter {
  /**
   * Intercept an MCP tool call, enforce Shield's permission layer, and
   * forward to the underlying handler if permitted.
   *
   * Steps performed on every call:
   * 1. Extract the service and action from `toolCall.toolName`.
   * 2. Check the derived scope against {@link McpAdapterConfig.grantedScopes}.
   * 3. Log the attempt (if a logger was provided).
   * 4. Return a {@link McpBlockedResult} if denied, or call `handler` if permitted.
   *
   * @param toolCall - The MCP tool call from the agent.
   * @param handler - The MCP server handler to invoke when access is permitted.
   * @returns The handler's result when allowed, or a {@link McpBlockedResult} when blocked.
   *
   * @example
   * ```ts
   * const result = await adapter.intercept(
   *   { toolName: "gmail_send_email", arguments: { to: "user@example.com" } },
   *   (call) => mcpServer.callTool(call.toolName, call.arguments),
   * );
   *
   * if (isBlockedResult(result)) {
   *   console.error(`Blocked: ${result.reason}`);
   * }
   * ```
   */
  intercept(toolCall: McpToolCall, handler: McpToolHandler): Promise<McpAdapterResult>;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Type guard to narrow an {@link McpAdapterResult} to a {@link McpBlockedResult}.
 *
 * @param result - The result returned by {@link McpAdapter.intercept}.
 * @returns `true` when Shield blocked the action before it reached the MCP server.
 *
 * @example
 * ```ts
 * const result = await adapter.intercept(call, handler);
 *
 * if (isBlockedResult(result)) {
 *   console.error(`Blocked (${result.service}): ${result.reason}`);
 * } else {
 *   processContent(result.content);
 * }
 * ```
 */
export function isBlockedResult(result: McpAdapterResult): result is McpBlockedResult {
  return "blocked" in result;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an MCP adapter that enforces Shield's permission layer on tool calls.
 *
 * The returned adapter wraps every MCP tool call through
 * {@link McpAdapter.intercept}, where it is checked against the granted scopes,
 * logged, and either forwarded to the MCP server or blocked.
 *
 * @param config - Adapter configuration including the agent's granted scopes.
 * @returns An {@link McpAdapter} ready to intercept tool calls.
 *
 * @example Basic setup
 * ```ts
 * const adapter = createMcpAdapter({
 *   agentId: "inbox-assistant",
 *   grantedScopes: [
 *     { service: "gmail", permissionLevel: "execute" },
 *     { service: "calendar", permissionLevel: "read" },
 *   ],
 *   logger: createActionLogger({ apiKey: "mcs_your_key_here" }),
 * });
 * ```
 *
 * @example With colon-delimited tool names (`gmail:send_email`)
 * ```ts
 * const adapter = createMcpAdapter({
 *   agentId: "my-agent",
 *   grantedScopes: [{ service: "gmail", permissionLevel: "execute" }],
 *   extractService: (toolName) => toolName.split(":")[0] ?? toolName,
 *   extractAction: (toolName) => toolName.split(":")[1] ?? "call",
 * });
 * ```
 */
export function createMcpAdapter(config: McpAdapterConfig): McpAdapter {
  const permissionLevel: PermissionLevel =
    config.requiredPermissionLevel ?? PERMISSION_LEVELS.Execute;

  function deriveService(toolName: string): string {
    if (config.extractService !== undefined) {
      return config.extractService(toolName);
    }
    const underscoreIndex = toolName.indexOf("_");
    return underscoreIndex === -1 ? toolName : toolName.slice(0, underscoreIndex);
  }

  function deriveAction(toolName: string): string {
    if (config.extractAction !== undefined) {
      return config.extractAction(toolName);
    }
    const underscoreIndex = toolName.indexOf("_");
    return underscoreIndex === -1 ? "call" : toolName.slice(underscoreIndex + 1);
  }

  async function recordAction(
    service: string,
    action: string,
    status: ActionStatus,
  ): Promise<void> {
    if (config.logger === undefined) return;
    await config.logger.logAction({
      agent: config.agentId,
      service,
      actionType: action,
      status,
    });
  }

  async function checkAutoApproveStatus(): Promise<boolean> {
    if (config.checkAutoApprove !== undefined) {
      const result: Promise<boolean> | boolean = config.checkAutoApprove(config.agentId);
      return result instanceof Promise ? await result : result;
    }

    // If baseUrl and apiKey are provided, try to fetch agent settings
    if (config.baseUrl && config.apiKey) {
      try {
        const agentId = config.agentId;
        const endpoint = `${config.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, 5000);

        try {
          const response = await fetch(endpoint, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              "X-Multicorn-Key": config.apiKey,
            },
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (response.ok) {
            const data = (await response.json()) as {
              data?: { public_content_auto_approve?: boolean };
            };
            return data.data?.public_content_auto_approve ?? false;
          }
        } catch {
          clearTimeout(timeoutId);
          // If fetch fails, default to requiring review
          return false;
        }
      } catch {
        // If fetch fails, default to requiring review
        return false;
      }
    }

    // Default: require review
    return false;
  }

  return {
    async intercept(toolCall: McpToolCall, handler: McpToolHandler): Promise<McpAdapterResult> {
      const service = deriveService(toolCall.toolName);
      const action = deriveAction(toolCall.toolName);
      const requestedScope: Scope = { service, permissionLevel };

      const validation = validateScopeAccess(config.grantedScopes, requestedScope);

      if (!validation.allowed) {
        await recordAction(service, action, ACTION_STATUSES.Blocked);

        return {
          blocked: true,
          reason:
            validation.reason ??
            `Action blocked: "${config.agentId}" does not have "${permissionLevel}" permission for "${service}".`,
          toolName: toolCall.toolName,
          service,
          action,
        };
      }

      // Check if this is a public content action that requires review
      const needsReview =
        requiresContentReview(requestedScope) || isPublicContentAction(toolCall.toolName, service);

      if (needsReview) {
        // Check if agent has auto-approval enabled
        const autoApprove = await checkAutoApproveStatus();

        if (!autoApprove) {
          // Log action with REQUIRES_APPROVAL status
          // Include full tool call arguments in metadata for content preview
          const metadata: Readonly<Record<string, string | number | boolean>> = {
            toolName: toolCall.toolName,
            arguments: JSON.stringify(toolCall.arguments),
            requiresReview: true,
          };

          // Log action with requires_approval status
          // The metadata will be stored and used to create the content review
          if (config.logger) {
            await config.logger.logAction({
              agent: config.agentId,
              service,
              actionType: action,
              status: ACTION_STATUSES.RequiresApproval,
              metadata,
            });
          }

          return {
            blocked: true,
            reason:
              `Action requires content review before execution. ` +
              `The action has been queued for review. Check your dashboard to approve or block it.`,
            toolName: toolCall.toolName,
            service,
            action,
          };
        }
        // If auto-approve is enabled, continue to normal execution
      }

      await recordAction(service, action, ACTION_STATUSES.Approved);
      return handler(toolCall);
    },
  };
}
