/**
 * Multicorn Shield Claude Desktop Extension MCP server (stdio).
 *
 * @module extension/server
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";

function debugLog(msg: string): void {
  try {
    const dir = join(homedir(), ".multicorn");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "extension-debug.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  normalizeObjectSchema,
  safeParseAsync,
  getParseErrorMessage,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createLogger, isValidLogLevel, type LogLevel } from "../proxy/logger.js";
import { deriveDashboardUrl } from "../proxy/consent.js";
import { ChildManager } from "./child-manager.js";
import {
  readClaudeDesktopMcpConfig,
  writeExtensionBackup,
  isShieldExtensionEntry,
  type McpServerEntry,
} from "./config-reader.js";
import { buildToolRouter } from "./tool-router.js";
import { ShieldExtensionRuntime } from "./runtime.js";
import { PACKAGE_VERSION } from "../package-meta.js";

const SETUP_TIMEOUT_MS = 15_000;

const NO_CHILDREN_STATUS_MESSAGE = `Multicorn Shield could not start. No child MCP servers were found.

If you are using Claude Desktop, add your MCP servers to claude_desktop_config.json and restart Claude Desktop, or use the local proxy instead:

  npx multicorn-proxy --wrap <your-mcp-server-command>

The hosted proxy for one-click setup is coming soon.`;

const ARGS_SCHEMA = z.record(z.string(), z.unknown());

const ARGS_OBJECT_SCHEMA = normalizeObjectSchema(ARGS_SCHEMA);
const ARGS_INPUT_JSON_SCHEMA =
  ARGS_OBJECT_SCHEMA !== undefined
    ? toJsonSchemaCompat(ARGS_OBJECT_SCHEMA, {
        strictUnions: true,
        pipeStrategy: "input",
      })
    : ({ type: "object" } as const);

interface RegisteredShieldTool {
  description: string;
  call: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

function readApiKey(): string | null {
  const key = process.env["MULTICORN_API_KEY"]?.trim();
  if (key === undefined || key.length === 0) return null;
  return key;
}

function readBaseUrl(): string {
  const raw = process.env["MULTICORN_BASE_URL"]?.trim();
  return raw !== undefined && raw.length > 0 ? raw : "https://api.multicorn.ai";
}

function readAgentName(): string {
  const raw = process.env["MULTICORN_AGENT_NAME"]?.trim();
  return raw !== undefined && raw.length > 0 ? raw : "claude-desktop-shield";
}

function readLogLevel(): LogLevel {
  const raw = process.env["MULTICORN_LOG_LEVEL"]?.trim();
  if (raw !== undefined && isValidLogLevel(raw)) return raw;
  return "info";
}

function asCallToolResult(value: unknown): CallToolResult {
  if (typeof value !== "object" || value === null) {
    return { content: [{ type: "text", text: String(value) }] };
  }
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj["content"])) {
    return value as CallToolResult;
  }
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export async function runShieldExtension(): Promise<void> {
  const debugBaseUrl = process.env["MULTICORN_BASE_URL"] ?? "";
  const debugApiKeyPrefix = process.env["MULTICORN_API_KEY"]?.slice(0, 8) ?? "";
  console.error(`[SHIELD-DEBUG] BASE_URL=${debugBaseUrl} API_KEY=${debugApiKeyPrefix}...`);
  const logger = createLogger(readLogLevel());

  const apiKey = readApiKey();
  if (apiKey === null) {
    logger.error("MULTICORN_API_KEY is not set. Configure the extension in Claude Desktop.");
    process.exit(1);
  }

  const baseUrl = readBaseUrl();
  const agentName = readAgentName();
  const dashboardUrl = deriveDashboardUrl(baseUrl);

  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const toolRegistry = new Map<string, RegisteredShieldTool>();

  // McpServer cannot express connect-first + deferred tools without SDK internals; Server is the supported low-level API here.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional
  const server = new Server(
    { name: "multicorn-shield", version: PACKAGE_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = Array.from(toolRegistry.entries()).map(([name, entry]) => ({
      name,
      description: entry.description,
      inputSchema: ARGS_INPUT_JSON_SCHEMA,
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    let registered = toolRegistry.get(toolName);
    if (registered === undefined) {
      await readyPromise;
      registered = toolRegistry.get(toolName);
    }
    if (registered === undefined) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool ${toolName} not found`,
          },
        ],
      };
    }

    const parseResult = await safeParseAsync(ARGS_SCHEMA, request.params.arguments ?? {});
    if (!parseResult.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Input validation error: Invalid arguments for tool ${toolName}: ${getParseErrorMessage(parseResult.error)}`,
          },
        ],
      };
    }

    return registered.call(parseResult.data);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  let childManager: ChildManager | undefined;
  let runtime: ShieldExtensionRuntime | undefined;

  void (async () => {
    const setupTimeout = setTimeout(() => {
      rejectReady(
        new Error(
          "[SHIELD] Background setup timed out after 15 seconds. " +
            "Steps include reading Claude Desktop MCP config, starting child MCP servers, " +
            "listing tools, and starting the Shield runtime. See ~/.multicorn/extension-debug.log for earlier [SHIELD] lines.",
        ),
      );
    }, SETUP_TIMEOUT_MS);

    try {
      debugLog("[SHIELD] About to read Claude Desktop MCP config.");
      const desktop = await readClaudeDesktopMcpConfig();
      if (desktop !== null) {
        await writeExtensionBackup(desktop.configPath, desktop.mcpServers);
      } else {
        logger.warn("Could not read Claude Desktop config. No MCP backup was written.", {});
      }

      const childEntries: Record<string, McpServerEntry> = {};
      if (desktop !== null) {
        for (const [name, entry] of Object.entries(desktop.mcpServers)) {
          if (!isShieldExtensionEntry(name, entry)) {
            childEntries[name] = entry;
          }
        }
      }

      const serverCount = Object.keys(childEntries).length;
      debugLog(
        `[SHIELD] Config read; ${String(serverCount)} MCP server(s) to wrap (excluding Shield).`,
      );

      childManager = new ChildManager({ logger });
      debugLog("[SHIELD] About to start all child MCP servers.");
      const startedChildren = await childManager.startAll(childEntries);
      debugLog(
        `[SHIELD] Child MCP servers started: ${String(startedChildren.length)} process(es).`,
      );

      if (startedChildren.length === 0) {
        debugLog("[SHIELD] No children started; registering multicorn_shield_status only.");
        toolRegistry.set("multicorn_shield_status", {
          description: "Reports why Shield could not start when no wrapped MCP servers were found.",
          call: () =>
            Promise.resolve({
              isError: true,
              content: [{ type: "text", text: NO_CHILDREN_STATUS_MESSAGE }],
            }),
        });
        await server.sendToolListChanged();
        debugLog("[SHIELD] Setup complete (no children); signaling ready.");
        clearTimeout(setupTimeout);
        resolveReady();
        return;
      }

      const toolsByServer = await childManager.listToolsForAll();
      const { tools: routedTools, routing } = buildToolRouter(toolsByServer, logger);

      runtime = new ShieldExtensionRuntime({
        apiKey,
        agentName,
        baseUrl,
        dashboardUrl,
        logger,
      });
      debugLog("[SHIELD] About to start Shield extension runtime.");
      await runtime.start();
      debugLog("[SHIELD] Shield extension runtime started successfully.");

      const rt = runtime;
      const cm = childManager;

      for (const tool of routedTools) {
        const sourceServer = routing.get(tool.name);
        if (sourceServer === undefined) continue;

        toolRegistry.set(tool.name, {
          description: tool.description ?? "",
          call: async (args) => {
            const decision = await rt.evaluateToolCall(tool.name);
            if (!decision.allow) {
              return decision.result;
            }

            const child = cm.getChildByServerName(sourceServer);
            if (child === undefined) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `Shield could not route tool "${tool.name}" to MCP server "${sourceServer}".`,
                  },
                ],
              };
            }

            try {
              const result = await child.session.request("tools/call", {
                name: tool.name,
                arguments: args,
              });
              return asCallToolResult(result);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return {
                isError: true,
                content: [{ type: "text", text: `Tool call failed: ${message}` }],
              };
            }
          },
        });
      }

      await server.sendToolListChanged();
      debugLog("[SHIELD] Setup complete; signaling ready.");
      clearTimeout(setupTimeout);
      resolveReady();
    } catch (error) {
      clearTimeout(setupTimeout);
      const message = error instanceof Error ? error.message : String(error);
      debugLog(`[SHIELD] Setup failed: ${message}`);
      logger.error(`Shield extension setup failed: ${message}`, {});
      rejectReady(error);
    }
  })();

  const cleanup = async (): Promise<void> => {
    if (runtime !== undefined) {
      await runtime.stop();
    }
    childManager?.stopAll();
    await server.close();
  };

  const stdinEnded = new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("end", () => {
      resolve();
    });
  });

  const onSignal = (): void => {
    void cleanup()
      .then(() => {
        process.exit(0);
      })
      .catch(() => {
        process.exit(1);
      });
  };

  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  await stdinEnded;
  await cleanup();
}
