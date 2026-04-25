/**
 * Multicorn Shield Claude Desktop Extension MCP server (stdio).
 *
 * @module extension/server
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
import {
  readClaudeDesktopMcpConfig,
  writeExtensionBackup,
  isShieldExtensionEntry,
  type McpServerEntry,
} from "./config-reader.js";
import {
  fetchProxyConfigs,
  ProxyConfigFetchError,
  ProxySession,
  buildProxyToolRouter,
  resultSuggestsConsentNeeded,
  type ProxyConfigItem,
  type McpToolDefinition,
} from "./proxy-client.js";
import { assertSafeProxyUrl } from "./proxy-url-validator.js";
import { ShieldExtensionRuntime } from "./runtime.js";
import { PACKAGE_VERSION } from "../package-meta.js";

const SETUP_TIMEOUT_MS = 15_000;

function getMulticornConfigPath(): string {
  return join(homedir(), ".multicorn", "config.json");
}

/** Optional `proxyConfigs` in ~/.multicorn/config.json (camelCase; see init / dashboard export). */
interface LocalProxyConfigRow {
  readonly serverName: string;
  readonly proxyUrl: string;
  readonly targetUrl: string;
}

function isLocalProxyConfigRow(value: unknown): value is LocalProxyConfigRow {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o["serverName"] === "string" &&
    o["serverName"].length > 0 &&
    typeof o["proxyUrl"] === "string" &&
    o["proxyUrl"].length > 0 &&
    typeof o["targetUrl"] === "string" &&
    o["targetUrl"].length > 0
  );
}

function localRowToProxyConfigItem(row: LocalProxyConfigRow): ProxyConfigItem {
  return {
    proxy_url: row.proxyUrl,
    server_name: row.serverName,
    target_url: row.targetUrl,
  };
}

/**
 * Reads optional `proxyConfigs` from ~/.multicorn/config.json.
 * Invalid entries are skipped. Missing file or parse errors yield an empty list.
 */
async function readProxyConfigsFromLocalMulticornConfig(): Promise<readonly ProxyConfigItem[]> {
  let raw: string;
  try {
    raw = await readFile(getMulticornConfigPath(), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const list = (parsed as Record<string, unknown>)["proxyConfigs"];
  if (!Array.isArray(list)) return [];

  const out: ProxyConfigItem[] = [];
  for (const row of list) {
    if (isLocalProxyConfigRow(row)) {
      out.push(localRowToProxyConfigItem(row));
    }
  }
  return out;
}

function noProxyConfigStatusMessage(dashboardUrl: string): string {
  const base = dashboardUrl.replace(/\/+$/, "");
  return `Multicorn Shield is active but no hosted proxy configurations were found for your account.

Create one in the dashboard (Proxy setup), then restart Claude Desktop:

  ${base}/proxy

Your API key is used for both the Shield API and hosted proxy routes.`;
}

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
  /* Claude Desktop may pass unresolved ${user_config.*} placeholders as literal env values. */
  if (key.startsWith("${")) return null;
  return key;
}

function readBaseUrl(): string {
  const raw = process.env["MULTICORN_BASE_URL"]?.trim();
  if (raw === undefined || raw.length === 0) return "https://api.multicorn.ai";
  if (raw.startsWith("${")) return "https://api.multicorn.ai";
  return raw;
}

function readAgentName(): string {
  try {
    const rawFile = readFileSync(getMulticornConfigPath(), "utf8");
    const obj = JSON.parse(rawFile) as Record<string, unknown>;
    const agents = obj["agents"];
    if (Array.isArray(agents)) {
      for (const e of agents) {
        if (
          typeof e === "object" &&
          e !== null &&
          (e as { platform?: string }).platform === "claude-desktop" &&
          typeof (e as { name?: string }).name === "string"
        ) {
          const n = (e as { name: string }).name.trim();
          if (n.length > 0) {
            return n;
          }
        }
      }
    }
  } catch {
    // Config file missing or malformed - fall through to env var and default.
  }
  const raw = process.env["MULTICORN_AGENT_NAME"]?.trim();
  if (raw !== undefined && raw.length > 0 && !raw.startsWith("${")) {
    return raw;
  }
  return "claude-desktop-shield";
}

function readLogLevel(): LogLevel {
  const raw = process.env["MULTICORN_LOG_LEVEL"]?.trim();
  if (raw !== undefined && isValidLogLevel(raw)) return raw;
  return "info";
}

async function autoCreateProxyConfig(
  baseUrl: string,
  apiKey: string,
  serverName: string,
  entry: McpServerEntry,
  agentName: string,
): Promise<boolean> {
  const targetUrl = `stdio://${entry.command}/${entry.args.join("/")}`;
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/proxy/config`;

  debugLog(`[SHIELD] Auto-creating proxy config for "${serverName}".`);

  const allowPrivateNetworks = process.env["MULTICORN_ALLOW_PRIVATE_PROXY_HOSTS"] === "1";
  assertSafeProxyUrl(url, { allowPrivateNetworks });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Multicorn-Key": apiKey,
      },
      body: JSON.stringify({
        server_name: serverName,
        target_url: targetUrl,
        agent_name: agentName,
      }),
      signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`[SHIELD] Failed to create proxy config for "${serverName}": ${message}`);
    return false;
  }

  if (response.status === 409) {
    debugLog(`[SHIELD] Proxy config for "${serverName}" already exists (409), skipping.`);
    return false;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    debugLog(
      `[SHIELD] Failed to create proxy config for "${serverName}": HTTP ${String(response.status)} ${body.slice(0, 200)}`,
    );
    return false;
  }

  debugLog(`[SHIELD] Proxy config created for "${serverName}".`);
  return true;
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

  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional
  const server = new Server(
    { name: "multicorn-shield", version: PACKAGE_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await readyPromise;
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

  let runtime: ShieldExtensionRuntime | undefined;
  const proxySessions: ProxySession[] = [];

  void (async () => {
    const setupTimeout = setTimeout(() => {
      rejectReady(
        new Error(
          "[SHIELD] Background setup timed out after 15 seconds. " +
            "Steps include proxy config resolution, hosted proxy sessions, and Shield runtime. " +
            "See ~/.multicorn/extension-debug.log for earlier [SHIELD] lines.",
        ),
      );
    }, SETUP_TIMEOUT_MS);

    try {
      debugLog("[SHIELD] Reading Claude Desktop MCP config for backup.");
      const desktop = await readClaudeDesktopMcpConfig();
      if (desktop !== null) {
        await writeExtensionBackup(desktop.configPath, desktop.mcpServers);
      } else {
        logger.warn("Could not read Claude Desktop config. No MCP backup was written.", {});
      }

      const discoveredServers: Record<string, McpServerEntry> = {};
      if (desktop !== null) {
        for (const [name, entry] of Object.entries(desktop.mcpServers)) {
          if (!isShieldExtensionEntry(name, entry)) {
            discoveredServers[name] = entry;
          }
        }
      }

      const serverCount = Object.keys(discoveredServers).length;
      debugLog(
        `[SHIELD] Config read; ${String(serverCount)} MCP server(s) discovered (excluding Shield).`,
      );

      debugLog("[SHIELD] Resolving proxy configs (local config or API).");

      const allowPrivateNetworks = process.env["MULTICORN_ALLOW_PRIVATE_PROXY_HOSTS"] === "1";

      let configs: readonly ProxyConfigItem[];
      const localConfigs = await readProxyConfigsFromLocalMulticornConfig();
      if (localConfigs.length > 0) {
        debugLog(`[SHIELD] Loaded ${String(localConfigs.length)} proxy configs from local config.`);
        configs = localConfigs;
      } else {
        debugLog("[SHIELD] No local proxy configs; fetching from API.");
        try {
          configs = await fetchProxyConfigs(baseUrl, apiKey, SETUP_TIMEOUT_MS, {
            allowPrivateNetworks,
          });
        } catch (e) {
          clearTimeout(setupTimeout);
          if (e instanceof ProxyConfigFetchError) {
            const msg =
              e.kind === "auth"
                ? e.message
                : `${e.message} (${dashboardUrl.replace(/\/+$/, "")}/proxy)`;
            toolRegistry.set("multicorn_shield_status", {
              description: "Reports Shield API or proxy config errors during extension setup.",
              call: () =>
                Promise.resolve({
                  isError: true,
                  content: [{ type: "text", text: msg }],
                }),
            });
            await server.sendToolListChanged();
            debugLog(`[SHIELD] Proxy config fetch failed (${e.kind}); status tool only.`);
            resolveReady();
            return;
          }
          throw e;
        }

        debugLog(`[SHIELD] Fetched ${String(configs.length)} proxy config(s) from API.`);

        if (serverCount > 0) {
          const existingNames = new Set(configs.map((c) => c.server_name));
          let createdCount = 0;
          for (const [name, entry] of Object.entries(discoveredServers)) {
            if (!existingNames.has(name)) {
              const created = await autoCreateProxyConfig(baseUrl, apiKey, name, entry, agentName);
              if (created) createdCount += 1;
            }
          }
          if (createdCount > 0) {
            debugLog(
              `[SHIELD] Auto-created ${String(createdCount)} proxy config(s); re-fetching from API.`,
            );
            try {
              configs = await fetchProxyConfigs(baseUrl, apiKey, SETUP_TIMEOUT_MS, {
                allowPrivateNetworks,
              });
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              debugLog(`[SHIELD] Re-fetch after auto-creation failed: ${message}`);
            }
          }
        }
      }

      debugLog(`[SHIELD] Proxy config count: ${String(configs.length)}.`);

      if (configs.length === 0) {
        debugLog("[SHIELD] No proxy configs; registering multicorn_shield_status only.");
        toolRegistry.set("multicorn_shield_status", {
          description: "Setup instructions when no hosted proxy configs exist for this API key.",
          call: () =>
            Promise.resolve({
              isError: true,
              content: [{ type: "text", text: noProxyConfigStatusMessage(dashboardUrl) }],
            }),
        });
        await server.sendToolListChanged();
        clearTimeout(setupTimeout);
        resolveReady();
        return;
      }

      runtime = new ShieldExtensionRuntime({
        apiKey,
        agentName,
        baseUrl,
        dashboardUrl,
        logger,
      });
      debugLog("[SHIELD] Starting extension runtime (hosted proxy path).");
      await runtime.start();
      debugLog(
        `[SHIELD] Runtime ready agentId=${runtime.getAgentId().length > 0 ? "(set)" : "(empty)"} authInvalid=${String(runtime.isAuthInvalid())}`,
      );

      const toolsByProxy = new Map<string, readonly McpToolDefinition[]>();
      const sessionByProxyUrl = new Map<string, ProxySession>();

      for (const cfg of configs) {
        const session = new ProxySession(cfg.proxy_url, apiKey, { allowPrivateNetworks });
        try {
          debugLog(`[SHIELD] Initializing proxy session for ${cfg.server_name}.`);
          await session.initialize();
          const list = await session.listTools();
          toolsByProxy.set(cfg.proxy_url, list);
          sessionByProxyUrl.set(cfg.proxy_url, session);
          proxySessions.push(session);
          debugLog(`[SHIELD] tools/list from ${cfg.server_name}: ${String(list.length)} tool(s).`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("Failed to list tools from hosted proxy.", {
            serverName: cfg.server_name,
            proxyUrl: cfg.proxy_url,
            error: message,
          });
          debugLog(`[SHIELD] Proxy session failed for ${cfg.server_name}: ${message}`);
          await session.close();
        }
      }

      const { tools: routedTools, routing } = buildProxyToolRouter(toolsByProxy, logger);

      const rt = runtime;

      for (const tool of routedTools) {
        const proxyUrl = routing.get(tool.name);
        if (proxyUrl === undefined) continue;
        const session = sessionByProxyUrl.get(proxyUrl);
        if (session === undefined) continue;

        toolRegistry.set(tool.name, {
          description: tool.description ?? "",
          call: async (args) => {
            if (rt.isAuthInvalid()) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "Action blocked: Shield API key is invalid or has been revoked. Update the Multicorn Shield extension settings in Claude Desktop.",
                  },
                ],
              };
            }
            const result = await session.callTool(tool.name, args);
            if (resultSuggestsConsentNeeded(result)) {
              rt.openConsentBrowserOnce();
            }
            return result;
          },
        });
      }

      if (toolRegistry.size === 0) {
        logger.warn("No tools registered after proxy setup; check proxy URLs and MCP servers.", {});
        toolRegistry.set("multicorn_shield_status", {
          description: "Reports when hosted proxies returned no tools.",
          call: () =>
            Promise.resolve({
              isError: true,
              content: [
                {
                  type: "text",
                  text: `No MCP tools were discovered from your hosted proxy URLs. Confirm each proxy's upstream MCP server is reachable (${dashboardUrl.replace(/\/+$/, "")}/proxy).`,
                },
              ],
            }),
        });
      }

      await server.sendToolListChanged();
      debugLog("[SHIELD] Setup complete (hosted proxy path); signaling ready.");
      clearTimeout(setupTimeout);
      resolveReady();
    } catch (error) {
      clearTimeout(setupTimeout);
      const message = error instanceof Error ? error.message : String(error);
      debugLog(`[SHIELD] Setup failed: ${message}`);
      logger.error(`Shield extension setup failed: ${message}`, {});
      await Promise.all(proxySessions.map((s) => s.close().catch(() => undefined)));
      rejectReady(error);
    }
  })();

  const cleanup = async (): Promise<void> => {
    if (runtime !== undefined) {
      await runtime.stop();
    }
    await Promise.all(proxySessions.map((s) => s.close().catch(() => undefined)));
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
