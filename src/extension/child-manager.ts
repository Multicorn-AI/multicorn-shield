/**
 * Spawns MCP child processes from Claude Desktop config entries and exposes JSON-RPC.
 *
 * @module extension/child-manager
 */

import { spawn, type ChildProcess } from "node:child_process";
import { JsonRpcChildSession } from "./json-rpc-child.js";
import type { McpServerEntry } from "./config-reader.js";
import type { McpToolDefinition } from "./tool-router.js";
import { parseToolsListResult } from "./tool-router.js";
import type { ProxyLogger } from "../proxy/logger.js";
import { PACKAGE_VERSION } from "../package-meta.js";

export interface ManagedChild {
  readonly serverName: string;
  readonly process: ChildProcess;
  readonly session: JsonRpcChildSession;
}

const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface ChildManagerOptions {
  readonly logger: ProxyLogger;
}

export class ChildManager {
  private readonly logger: ProxyLogger;
  private readonly children: ManagedChild[] = [];

  constructor(options: ChildManagerOptions) {
    this.logger = options.logger;
  }

  /**
   * Starts all MCP servers from config (caller must exclude Shield self).
   */
  async startAll(
    entries: Readonly<Record<string, McpServerEntry>>,
  ): Promise<readonly ManagedChild[]> {
    const names = Object.keys(entries);
    for (const serverName of names) {
      const entry = entries[serverName];
      if (entry === undefined) continue;

      try {
        const managed = await this.startOne(serverName, entry);
        this.children.push(managed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("Failed to start MCP child server.", { serverName, error: message });
      }
    }
    return this.children;
  }

  private async startOne(serverName: string, entry: McpServerEntry): Promise<ManagedChild> {
    const env = { ...process.env, ...entry.env } as NodeJS.ProcessEnv;

    const child = spawn(entry.command, [...entry.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    child.on("error", (err) => {
      this.logger.error("MCP child process error.", { serverName, error: err.message });
    });

    child.on("exit", (code, signal) => {
      this.logger.info("MCP child process exited.", {
        serverName,
        code: code ?? undefined,
        signal: signal ?? undefined,
      });
    });

    const session = new JsonRpcChildSession({
      child,
      label: serverName,
      logStderr: (line) => {
        this.logger.debug("MCP child stderr.", { serverName, line });
      },
    });

    await session.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "multicorn-shield-extension", version: PACKAGE_VERSION },
    });

    session.notify("notifications/initialized", {});

    return { serverName, process: child, session };
  }

  async listToolsForAll(): Promise<Map<string, readonly McpToolDefinition[]>> {
    const map = new Map<string, readonly McpToolDefinition[]>();

    for (const c of this.children) {
      try {
        const result = await c.session.request("tools/list", {});
        map.set(c.serverName, parseToolsListResult(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("tools/list failed for MCP child.", {
          serverName: c.serverName,
          error: message,
        });
        map.set(c.serverName, []);
      }
    }

    return map;
  }

  getChildByServerName(serverName: string): ManagedChild | undefined {
    return this.children.find((c) => c.serverName === serverName);
  }

  stopAll(): void {
    for (const c of this.children) {
      c.process.kill("SIGTERM");
    }
    this.children.length = 0;
  }
}
