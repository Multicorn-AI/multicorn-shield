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
import { validateScopeAccess } from "../scopes/scope-validator.js";
import { createActionLogger } from "../logger/action-logger.js";
import type { Scope } from "../types/index.js";
import type { ActionLogger } from "../logger/action-logger.js";
import {
  parseJsonRpcLine,
  extractToolCallParams,
  buildBlockedResponse,
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

const SCOPE_REFRESH_INTERVAL_MS = 60_000;

export interface ProxyServerConfig {
  readonly command: string;
  readonly commandArgs: readonly string[];
  readonly apiKey: string;
  readonly agentName: string;
  readonly baseUrl: string;
  readonly logger: ProxyLogger;
}

export interface ProxyServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createProxyServer(config: ProxyServerConfig): ProxyServer {
  let child: ChildProcess | null = null;
  let actionLogger: ActionLogger | null = null;
  let grantedScopes: readonly Scope[] = [];
  let agentId = "";
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let consentInProgress = false;
  const pendingLines: string[] = [];
  let draining = false;

  async function refreshScopes(): Promise<void> {
    if (agentId.length === 0) return;
    try {
      const scopes = await fetchGrantedScopes(agentId, config.apiKey, config.baseUrl);
      if (scopes.length > 0) {
        grantedScopes = scopes;
        await saveCachedScopes(config.agentName, agentId, scopes);
        config.logger.debug("Scopes refreshed.", { count: scopes.length });
      }
    } catch (error) {
      config.logger.warn("Scope refresh failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function ensureConsent(): Promise<void> {
    if (grantedScopes.length > 0 || consentInProgress) return;
    // agentId is empty when the service was unreachable at startup.
    // Consent requires the service, so skip and let the permission check block the call.
    if (agentId.length === 0) return;

    consentInProgress = true;
    try {
      const scopes = await waitForConsent(
        agentId,
        config.agentName,
        config.apiKey,
        config.baseUrl,
        config.logger,
      );
      grantedScopes = scopes;
      await saveCachedScopes(config.agentName, agentId, scopes);
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

    await ensureConsent();

    const service = extractServiceFromToolName(toolParams.name);
    const action = extractActionFromToolName(toolParams.name);
    const requestedScope: Scope = { service, permissionLevel: "execute" };
    const validation = validateScopeAccess(grantedScopes, requestedScope);

    config.logger.debug("Tool call intercepted.", {
      tool: toolParams.name,
      service,
      allowed: validation.allowed,
    });

    if (!validation.allowed) {
      if (actionLogger !== null) {
        await actionLogger.logAction({
          agent: config.agentName,
          service,
          actionType: action,
          status: "blocked",
        });
      }

      const blocked = buildBlockedResponse(request.id, service, "execute");
      return JSON.stringify(blocked);
    }

    if (actionLogger !== null) {
      await actionLogger.logAction({
        agent: config.agentName,
        service,
        actionType: action,
        status: "approved",
      });
    }

    return null;
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
    );

    agentId = agentRecord.id;
    grantedScopes = agentRecord.scopes;

    config.logger.info("Agent resolved.", {
      agent: config.agentName,
      id: agentId,
      scopeCount: grantedScopes.length,
    });

    actionLogger = createActionLogger({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      batchMode: { enabled: true, maxSize: 20, flushIntervalMs: 5000 },
      onError: (err) => {
        config.logger.warn("Action log failed.", { error: err.message });
      },
    });

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

    refreshTimer = setInterval(() => {
      void refreshScopes();
    }, SCOPE_REFRESH_INTERVAL_MS);

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
