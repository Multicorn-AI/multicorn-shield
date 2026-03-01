/**
 * OpenClaw event types for the Multicorn Shield hook.
 *
 * These interfaces model the event objects that OpenClaw passes to hook
 * handlers. Derived from the OpenClaw hooks documentation
 * (docs.openclaw.ai/automation/hooks).
 *
 * @module openclaw/types
 */

import type { PermissionLevel } from "../types/index.js";

/**
 * Context attached to an `agent:tool_call` event.
 *
 * Contains the tool name, its arguments, and the session that triggered it.
 */
export interface ToolCallContext {
  readonly toolName: string;
  readonly toolArguments: Readonly<Record<string, unknown>>;
}

/**
 * The event object OpenClaw passes to every hook handler.
 *
 * Hooks filter on `type` and `action` to decide whether to act.
 * The `messages` array can be pushed to in order to send feedback
 * to the user (e.g. a "permission denied" message).
 */
export interface OpenClawEvent {
  readonly type: string;
  readonly action: string;
  readonly sessionKey: string;
  readonly timestamp: Date;
  readonly messages: string[];
  readonly context: Readonly<Record<string, unknown>>;
}

/**
 * A narrowed event that is guaranteed to be an `agent:tool_call`.
 */
export interface ToolCallEvent extends OpenClawEvent {
  readonly type: "agent";
  readonly action: "tool_call";
  readonly context: ToolCallContext & Readonly<Record<string, unknown>>;
}

/**
 * The result of mapping an OpenClaw tool to a Shield service and permission.
 */
export interface ToolScopeMapping {
  readonly service: string;
  readonly permissionLevel: PermissionLevel;
}

/**
 * Check whether an event is an `agent:tool_call` with the expected context shape.
 */
export function isToolCallEvent(event: OpenClawEvent): event is ToolCallEvent {
  if (event.type !== "agent" || event.action !== "tool_call") return false;

  const ctx = event.context;
  return (
    typeof ctx["toolName"] === "string" &&
    typeof ctx["toolArguments"] === "object" &&
    ctx["toolArguments"] !== null
  );
}
