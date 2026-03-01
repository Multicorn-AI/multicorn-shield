/**
 * Local type definitions for the OpenClaw Plugin SDK.
 *
 * Extracted from openclaw/dist/plugin-sdk/plugins/types.d.ts (v2026.2.26).
 * We define only the subset needed for the Shield plugin so there's no
 * build-time dependency on the OpenClaw package itself.
 *
 * @module openclaw/plugin-sdk.types
 */

export interface PluginLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export type PluginHookName = string;

export interface PluginHookToolContext {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
}

export interface PluginHookBeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
}

export interface PluginHookBeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
}

export interface PluginHookAfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

type BeforeToolCallHandler = (
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
) =>
  | Promise<PluginHookBeforeToolCallResult | undefined>
  | PluginHookBeforeToolCallResult
  | undefined;

type AfterToolCallHandler = (
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,
) => Promise<void> | undefined;

export interface PluginHookHandlerMap {
  before_tool_call: BeforeToolCallHandler;
  after_tool_call: AfterToolCallHandler;
}

export interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  on: <K extends keyof PluginHookHandlerMap>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ) => void;
  resolvePath: (input: string) => string;
  // Other methods exist but aren't needed by Shield
  [key: string]: unknown;
}

export interface OpenClawPluginDefinition {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
}
