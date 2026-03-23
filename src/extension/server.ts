/**
 * Multicorn Shield Claude Desktop Extension MCP server (stdio).
 *
 * @module extension/server
 */

import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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

const ARGS_SCHEMA = z.record(z.string(), z.unknown());

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
  const logger = createLogger(readLogLevel());

  const apiKey = readApiKey();
  if (apiKey === null) {
    logger.error("MULTICORN_API_KEY is not set. Configure the extension in Claude Desktop.");
    process.exit(1);
  }

  const baseUrl = readBaseUrl();
  const agentName = readAgentName();
  const dashboardUrl = deriveDashboardUrl(baseUrl);

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

  const childManager = new ChildManager({ logger });
  await childManager.startAll(childEntries);

  const toolsByServer = await childManager.listToolsForAll();
  const { tools: routedTools, routing } = buildToolRouter(toolsByServer, logger);

  const runtime = new ShieldExtensionRuntime({
    apiKey,
    agentName,
    baseUrl,
    dashboardUrl,
    logger,
  });
  await runtime.start();

  const mcpServer = new McpServer(
    { name: "multicorn-shield", version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );

  for (const tool of routedTools) {
    const sourceServer = routing.get(tool.name);
    if (sourceServer === undefined) continue;

    mcpServer.registerTool(
      tool.name,
      {
        description: tool.description ?? "",
        inputSchema: ARGS_SCHEMA,
      },
      async (args) => {
        const decision = await runtime.evaluateToolCall(tool.name);
        if (!decision.allow) {
          return decision.result;
        }

        const child = childManager.getChildByServerName(sourceServer);
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
    );
  }

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  const cleanup = async (): Promise<void> => {
    await runtime.stop();
    childManager.stopAll();
    await mcpServer.close();
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
