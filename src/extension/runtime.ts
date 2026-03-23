/**
 * Shield permission and audit layer for the Desktop Extension (mirrors MCP proxy behaviour).
 *
 * @module extension/runtime
 */

import { validateScopeAccess, hasScope } from "../scopes/scope-validator.js";
import { createActionLogger } from "../logger/action-logger.js";
import type { Scope } from "../types/index.js";
import type { ActionLogger } from "../logger/action-logger.js";
import {
  buildBlockedResponse,
  buildInternalErrorResponse,
  buildServiceUnreachableResponse,
} from "../proxy/interceptor.js";
import { mapMcpToolToScope } from "../mcp-tool-mapper.js";
import {
  fetchGrantedScopes,
  saveCachedScopes,
  waitForConsent,
  resolveAgentRecord,
} from "../proxy/consent.js";
import type { ProxyLogger } from "../proxy/logger.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const JSON_RPC_ID = 0;

export interface ShieldExtensionRuntimeConfig {
  readonly apiKey: string;
  readonly agentName: string;
  readonly baseUrl: string;
  readonly dashboardUrl: string;
  readonly logger: ProxyLogger;
  readonly scopeRefreshIntervalMs?: number;
}

function toolError(text: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text }],
  };
}

function messageFromJsonRpcResponse(json: string): string {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null) {
      const err = (parsed as Record<string, unknown>)["error"];
      if (typeof err === "object" && err !== null) {
        const msg = (err as Record<string, unknown>)["message"];
        if (typeof msg === "string") return msg;
      }
    }
  } catch {
    return "Action blocked by Multicorn Shield.";
  }
  return "Action blocked by Multicorn Shield.";
}

const DEFAULT_SCOPE_REFRESH_INTERVAL_MS = 60_000;

export class ShieldExtensionRuntime {
  private readonly config: ShieldExtensionRuntimeConfig;
  private actionLogger: ActionLogger | null = null;
  private grantedScopes: readonly Scope[] = [];
  private agentId = "";
  private authInvalid = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private consentInProgress = false;

  constructor(config: ShieldExtensionRuntimeConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    const cfg = this.config;
    if (
      !cfg.baseUrl.startsWith("https://") &&
      !cfg.baseUrl.startsWith("http://localhost") &&
      !cfg.baseUrl.startsWith("http://127.0.0.1")
    ) {
      throw new Error(
        `[multicorn-shield-extension] Base URL must use HTTPS. Received: "${cfg.baseUrl}".`,
      );
    }

    const agentRecord = await resolveAgentRecord(
      cfg.agentName,
      cfg.apiKey,
      cfg.baseUrl,
      cfg.logger,
    );

    this.agentId = agentRecord.id;
    this.grantedScopes = agentRecord.scopes;
    this.authInvalid = agentRecord.authInvalid === true;

    this.actionLogger = createActionLogger({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      batchMode: { enabled: false },
      onError: (err) => {
        cfg.logger.warn("Action log failed.", { error: err.message });
      },
    });

    const refreshIntervalMs = cfg.scopeRefreshIntervalMs ?? DEFAULT_SCOPE_REFRESH_INTERVAL_MS;
    this.refreshTimer = setInterval(() => {
      void this.refreshScopes();
    }, refreshIntervalMs);

    const timer = this.refreshTimer as unknown as { unref?: () => void };
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.actionLogger !== null) {
      await this.actionLogger.shutdown();
      this.actionLogger = null;
    }
  }

  private async refreshScopes(): Promise<void> {
    if (this.agentId.length === 0) return;
    try {
      const scopes = await fetchGrantedScopes(
        this.agentId,
        this.config.apiKey,
        this.config.baseUrl,
      );
      this.grantedScopes = scopes;
      if (scopes.length > 0) {
        await saveCachedScopes(this.config.agentName, this.agentId, scopes, this.config.apiKey);
      }
    } catch (error) {
      this.config.logger.warn("Scope refresh failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureConsent(requestedScope?: Scope): Promise<void> {
    if (this.agentId.length === 0) return;

    if (requestedScope !== undefined) {
      if (hasScope(this.grantedScopes, requestedScope) || this.consentInProgress) return;
    } else {
      if (this.grantedScopes.length > 0 || this.consentInProgress) return;
    }

    this.consentInProgress = true;
    try {
      const scopeParam =
        requestedScope !== undefined
          ? { service: requestedScope.service, permissionLevel: requestedScope.permissionLevel }
          : undefined;
      const scopes = await waitForConsent(
        this.agentId,
        this.config.agentName,
        this.config.apiKey,
        this.config.baseUrl,
        this.config.dashboardUrl,
        this.config.logger,
        scopeParam,
      );
      this.grantedScopes = scopes;
      await saveCachedScopes(this.config.agentName, this.agentId, scopes, this.config.apiKey);
    } finally {
      this.consentInProgress = false;
    }
  }

  /**
   * Returns whether the tool call may proceed to the child MCP server.
   */
  async evaluateToolCall(
    toolName: string,
  ): Promise<{ allow: true } | { allow: false; result: CallToolResult }> {
    const cfg = this.config;

    try {
      if (this.authInvalid) {
        return {
          allow: false,
          result: toolError(
            "Action blocked: Shield API key is invalid or has been revoked. Open Claude Desktop, open the Multicorn Shield extension settings, and enter a valid API key.",
          ),
        };
      }

      if (this.agentId.length === 0) {
        const blocked = buildServiceUnreachableResponse(JSON_RPC_ID, cfg.dashboardUrl);
        return {
          allow: false,
          result: toolError(messageFromJsonRpcResponse(JSON.stringify(blocked))),
        };
      }

      const mapped = mapMcpToolToScope(toolName);
      const { service, permissionLevel, actionType } = mapped;
      const requestedScope: Scope = { service, permissionLevel };
      let validation = validateScopeAccess(this.grantedScopes, requestedScope);

      cfg.logger.debug("Tool call intercepted.", {
        tool: toolName,
        service,
        permissionLevel,
        allowed: validation.allowed,
      });

      if (!validation.allowed) {
        await this.ensureConsent(requestedScope);
        validation = validateScopeAccess(this.grantedScopes, requestedScope);
        if (!validation.allowed) {
          if (this.actionLogger !== null && cfg.agentName.trim().length > 0) {
            await this.actionLogger.logAction({
              agent: cfg.agentName,
              service,
              actionType,
              status: "blocked",
            });
          }
          const blocked = buildBlockedResponse(
            JSON_RPC_ID,
            service,
            permissionLevel,
            cfg.dashboardUrl,
          );
          return {
            allow: false,
            result: toolError(messageFromJsonRpcResponse(JSON.stringify(blocked))),
          };
        }
      }

      if (this.actionLogger !== null) {
        if (cfg.agentName.trim().length === 0) {
          cfg.logger.warn("Cannot log action: agent name not resolved.");
        } else {
          await this.actionLogger.logAction({
            agent: cfg.agentName,
            service,
            actionType,
            status: "approved",
          });
        }
      }

      return { allow: true };
    } catch (error) {
      cfg.logger.error("Tool call handler error.", {
        error: error instanceof Error ? error.message : String(error),
      });
      const blocked = buildInternalErrorResponse(JSON_RPC_ID);
      return {
        allow: false,
        result: toolError(messageFromJsonRpcResponse(JSON.stringify(blocked))),
      };
    }
  }
}
