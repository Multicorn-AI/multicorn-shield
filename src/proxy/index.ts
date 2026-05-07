/**
 * MCP proxy server.
 *
 * Wraps an existing MCP server as a child process and sits between the agent
 * and that server on the stdio transport. Every `tools/call` request is
 * intercepted and checked against the agent's granted permissions before being
 * forwarded. Blocked calls are returned as JSON-RPC error responses without
 * ever reaching the wrapped server.
 *
 * Flow:
 *   Agent stdout → proxy stdin → (intercept) → child stdin
 *   child stdout → proxy stdout → Agent stdin
 *   child stderr → proxy stderr (logged)
 *
 * @module proxy/index
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { validateScopeAccess, hasScope } from "../scopes/scope-validator.js";
import { createActionLogger } from "../logger/action-logger.js";
import { createSpendingChecker, dollarsToCents } from "../spending/spending-checker.js";
import type { SpendingLimits, SpendingChecker } from "../spending/spending-checker.js";
import type { Scope } from "../types/index.js";
import type { ActionLogger } from "../logger/action-logger.js";
import {
  parseJsonRpcLine,
  extractToolCallParams,
  buildBlockedResponse,
  buildSpendingBlockedResponse,
  buildInternalErrorResponse,
  buildServiceUnreachableResponse,
  buildAuthErrorResponse,
  extractServiceFromToolName,
  extractActionFromToolName,
} from "./interceptor.js";
import {
  fetchGrantedScopes,
  saveCachedScopes,
  waitForConsent,
  resolveAgentRecord,
} from "./consent.js";
import type { ProxyLogger } from "./logger.js";

const DEFAULT_SCOPE_REFRESH_INTERVAL_MS = 60_000;

export interface ProxyServerConfig {
  readonly command: string;
  readonly commandArgs: readonly string[];
  readonly apiKey: string;
  readonly agentName: string;
  readonly baseUrl: string;
  readonly dashboardUrl: string;
  readonly logger: ProxyLogger;
  readonly spendingLimits?: SpendingLimits;
  readonly scopeRefreshIntervalMs?: number;
  readonly platform?: string;
}

export interface ProxyServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createProxyServer(config: ProxyServerConfig): ProxyServer {
  // Enforce HTTPS on the base URL to prevent API key transmission over cleartext.
  // Allow http://localhost and http://127.0.0.1 for local development only.
  if (
    !config.baseUrl.startsWith("https://") &&
    !config.baseUrl.startsWith("http://localhost") &&
    !config.baseUrl.startsWith("http://127.0.0.1")
  ) {
    throw new Error(
      `[multicorn-shield] Base URL must use HTTPS. Received: "${config.baseUrl}". ` +
        "Use https:// or http://localhost for local development.",
    );
  }

  let child: ChildProcess | null = null;
  let actionLogger: ActionLogger | null = null;
  let spendingChecker: SpendingChecker | null = null;
  let grantedScopes: readonly Scope[] = [];
  let agentId = "";
  let authInvalid = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let consentInProgress = false;
  const pendingLines: string[] = [];
  let draining = false;
  let stopped = false;

  async function refreshScopes(): Promise<void> {
    if (stopped) return;
    if (agentId.length === 0) return;
    try {
      const scopes = await fetchGrantedScopes(agentId, config.apiKey, config.baseUrl);
      grantedScopes = scopes;
      if (scopes.length > 0) {
        await saveCachedScopes(config.agentName, agentId, scopes, config.apiKey);
      }
      config.logger.debug("Scopes refreshed.", { count: scopes.length });
    } catch (error) {
      config.logger.warn("Scope refresh failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function ensureConsent(requestedScope?: Scope): Promise<void> {
    // agentId is empty when the service was unreachable at startup.
    // Consent requires the service, so skip and let the permission check block the call.
    if (agentId.length === 0) return;

    // If a specific scope is requested, check if that exact scope is granted
    // If no scope is requested, check if any scopes exist (first-time setup)
    if (requestedScope !== undefined) {
      if (hasScope(grantedScopes, requestedScope) || consentInProgress) return;
    } else {
      if (grantedScopes.length > 0 || consentInProgress) return;
    }

    consentInProgress = true;
    try {
      const scopeParam =
        requestedScope !== undefined
          ? { service: requestedScope.service, permissionLevel: requestedScope.permissionLevel }
          : undefined;
      const scopes = await waitForConsent(
        agentId,
        config.agentName,
        config.apiKey,
        config.baseUrl,
        config.dashboardUrl,
        config.logger,
        scopeParam,
        config.platform ?? "other-mcp",
      );
      grantedScopes = scopes;
      await saveCachedScopes(config.agentName, agentId, scopes, config.apiKey);
    } finally {
      consentInProgress = false;
    }
  }

  async function handleToolCall(line: string): Promise<string | null> {
    const request = parseJsonRpcLine(line);
    if (request === null) return null;

    if (request.method !== "tools/call") return null;

    const toolParams = extractToolCallParams(request);
    if (toolParams === null) return null;

    try {
      // Fail-closed: check service state before any scope validation or consent.
      // When startup failed (unreachable or auth invalid), every tool call returns the correct error.
      if (authInvalid) {
        const blocked = buildAuthErrorResponse(request.id);
        return JSON.stringify(blocked);
      }
      if (agentId.length === 0) {
        const blocked = buildServiceUnreachableResponse(request.id, config.dashboardUrl);
        return JSON.stringify(blocked);
      }

      const service = extractServiceFromToolName(toolParams.name);
      const action = extractActionFromToolName(toolParams.name);

      config.logger.debug("Extracted tool identity.", {
        tool: toolParams.name,
        service,
        action,
      });

      const requestedScope: Scope = { service, permissionLevel: "execute" };
      const validation = validateScopeAccess(grantedScopes, requestedScope);

      config.logger.debug("Scope validation result.", {
        tool: toolParams.name,
        allowed: validation.allowed,
        scopeCount: grantedScopes.length,
      });

      // Trigger consent if the specific scope is missing
      if (!validation.allowed) {
        await ensureConsent(requestedScope);
        // Re-validate after consent attempt
        const revalidation = validateScopeAccess(grantedScopes, requestedScope);

        config.logger.debug("Post-consent revalidation result.", {
          tool: toolParams.name,
          allowed: revalidation.allowed,
          scopeCount: grantedScopes.length,
        });

        if (!revalidation.allowed) {
          if (actionLogger !== null) {
            if (!config.agentName || config.agentName.trim().length === 0) {
              process.stderr.write(
                "[multicorn-shield] Cannot log action: agent name not resolved\n",
              );
            } else {
              config.logger.debug("Logging blocked action (post-consent).", {
                agent: config.agentName,
                service,
                action,
              });
              await actionLogger.logAction({
                agent: config.agentName,
                service,
                actionType: action,
                status: "blocked",
              });
              config.logger.debug("Blocked action logged.", { tool: toolParams.name });
            }
          }
          return JSON.stringify(
            buildBlockedResponse(request.id, service, "execute", config.dashboardUrl),
          );
        }
      }

      const costCents = extractCostCents(toolParams.arguments);
      const costUsd = costCents > 0 ? costCents / 100 : undefined;

      if (spendingChecker !== null) {
        if (costCents > 0) {
          const spendResult = spendingChecker.checkSpend(costCents);
          if (!spendResult.allowed) {
            if (actionLogger !== null) {
              if (!config.agentName || config.agentName.trim().length === 0) {
                process.stderr.write(
                  "[multicorn-shield] Cannot log action: agent name not resolved\n",
                );
              } else {
                config.logger.debug("Logging blocked action (spending).", {
                  agent: config.agentName,
                  service,
                  action,
                });
                await actionLogger.logAction({
                  agent: config.agentName,
                  service,
                  actionType: action,
                  status: "blocked",
                  ...(costUsd !== undefined ? { cost: costUsd } : {}),
                });
                config.logger.debug("Spending-blocked action logged.", { tool: toolParams.name });
              }
            }

            const blocked = buildSpendingBlockedResponse(
              request.id,
              spendResult.reason ?? "spending limit exceeded",
              config.dashboardUrl,
            );
            return JSON.stringify(blocked);
          }
          spendingChecker.recordSpend(costCents);
        }
      }

      if (actionLogger !== null) {
        if (!config.agentName || config.agentName.trim().length === 0) {
          process.stderr.write("[multicorn-shield] Cannot log action: agent name not resolved\n");
        } else {
          config.logger.debug("Logging approved action.", {
            agent: config.agentName,
            service,
            action,
          });
          await actionLogger.logAction({
            agent: config.agentName,
            service,
            actionType: action,
            status: "approved",
            ...(costUsd !== undefined ? { cost: costUsd } : {}),
          });
          config.logger.debug("Approved action logged.", { tool: toolParams.name });
        }
      }

      return null;
    } catch (error) {
      config.logger.error("Tool call handler error.", {
        error: error instanceof Error ? error.message : String(error),
      });
      const blocked = buildInternalErrorResponse(request.id);
      return JSON.stringify(blocked);
    }
  }

  async function processLine(line: string): Promise<void> {
    const childProcess = child;
    if (childProcess?.stdin === null || childProcess === null) return;

    const override = await handleToolCall(line);

    if (override !== null) {
      process.stdout.write(override + "\n");
    } else {
      childProcess.stdin.write(line + "\n");
    }
  }

  async function drainQueue(): Promise<void> {
    if (draining) return;
    draining = true;

    while (pendingLines.length > 0) {
      const line = pendingLines.shift();
      if (line === undefined) break;
      await processLine(line);
    }

    draining = false;
  }

  function enqueueLine(line: string): void {
    pendingLines.push(line);
    void drainQueue();
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }

    if (actionLogger !== null) {
      await actionLogger.shutdown();
      actionLogger = null;
    }

    const childProcess = child;
    if (childProcess !== null) {
      childProcess.kill("SIGTERM");
      child = null;
    }
  }

  async function start(): Promise<void> {
    config.logger.info("Proxy starting.", { agent: config.agentName, command: config.command });

    const agentRecord = await resolveAgentRecord(
      config.agentName,
      config.apiKey,
      config.baseUrl,
      config.logger,
      config.platform ?? "other-mcp",
    );

    agentId = agentRecord.id;
    grantedScopes = agentRecord.scopes;
    authInvalid = agentRecord.authInvalid === true;

    if (authInvalid) {
      config.logger.error("API key rejected by the Multicorn service.", {
        agent: config.agentName,
      });
      process.stderr.write(
        "\nError: API key was rejected by the Multicorn service.\n" +
          "Check your key at https://app.multicorn.ai/settings#api-keys " +
          "or run `npx multicorn-shield init` to reconfigure.\n\n",
      );
      throw new Error("API key was rejected by the Multicorn service.");
    }

    config.logger.info("Agent resolved.", {
      agent: config.agentName,
      id: agentId,
      scopeCount: grantedScopes.length,
    });

    actionLogger = createActionLogger({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      batchMode: { enabled: false },
      onError: (err) => {
        config.logger.warn("Action log failed.", { error: err.message });
      },
    });

    if (config.spendingLimits !== undefined) {
      spendingChecker = createSpendingChecker({ limits: config.spendingLimits });
    }

    child = spawn(config.command, config.commandArgs as string[], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const childProcess = child;

    childProcess.on("error", (err) => {
      config.logger.error("Child process error.", { error: err.message });
    });

    childProcess.on("exit", (code, signal) => {
      config.logger.info("Child process exited.", {
        code: code ?? undefined,
        signal: signal ?? undefined,
      });
    });

    if (childProcess.stdout !== null) {
      childProcess.stdout.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk);
      });
    }

    if (childProcess.stderr !== null) {
      childProcess.stderr.on("data", (chunk: Buffer) => {
        config.logger.debug("Child stderr.", { data: chunk.toString().trim() });
      });
    }

    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      enqueueLine(line);
    });
    rl.on("close", () => {
      config.logger.info("Agent disconnected. Shutting down.");
      void stop();
    });

    const refreshIntervalMs = config.scopeRefreshIntervalMs ?? DEFAULT_SCOPE_REFRESH_INTERVAL_MS;
    refreshTimer = setInterval(() => {
      void refreshScopes();
    }, refreshIntervalMs);

    const timer = refreshTimer as unknown as { unref?: () => void };
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    config.logger.info("Proxy ready.", { agent: config.agentName });

    return new Promise((resolve) => {
      childProcess.on("exit", () => {
        resolve();
      });
    });
  }

  return { start, stop };
}

/**
 * Extract a cost in integer cents from tool call arguments.
 * Looks for an `amount` field (dollars) and converts to cents.
 * Returns 0 when no recognisable cost is present.
 */
function extractCostCents(args: Record<string, unknown>): number {
  const amount = args["amount"];
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return 0;
  return dollarsToCents(amount);
}
