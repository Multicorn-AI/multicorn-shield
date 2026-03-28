#!/usr/bin/env node
/**
 * multicorn-proxy CLI entry point.
 *
 * Usage:
 *   npx multicorn-proxy init
 *   npx multicorn-proxy --wrap <command> [args...]
 *   npx multicorn-proxy --wrap <command> [args...] --log-level debug
 *
 * @module bin/multicorn-proxy
 */

import { loadConfig, runInit } from "../src/proxy/config.js";
import { createProxyServer } from "../src/proxy/index.js";
import { createLogger, isValidLogLevel, type LogLevel } from "../src/proxy/logger.js";
import { deriveDashboardUrl } from "../src/proxy/consent.js";

interface CliArgs {
  readonly subcommand: "init" | "wrap" | "help";
  readonly wrapCommand: string;
  readonly wrapArgs: readonly string[];
  readonly logLevel: LogLevel;
  readonly baseUrl: string;
  readonly dashboardUrl: string;
  readonly agentName: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);

  let subcommand: CliArgs["subcommand"] = "help";
  let wrapCommand = "";
  let wrapArgs: string[] = [];
  let logLevel: LogLevel = "info";
  let baseUrl = "https://api.multicorn.ai";
  let dashboardUrl = "";
  let agentName = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "init") {
      subcommand = "init";
    } else if (arg === "--wrap") {
      subcommand = "wrap";
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        process.stderr.write("Error: --wrap requires a command to run.\n");
        process.stderr.write("Example: npx multicorn-proxy --wrap my-mcp-server\n");
        process.exit(1);
      }
      wrapCommand = next;
      // Everything after --wrap <cmd> is forwarded to the child process.
      // Proxy flags (--log-level, etc.) must appear before --wrap.
      wrapArgs = args.slice(i + 2);
      break;
    } else if (arg === "--log-level") {
      const next = args[i + 1];
      if (next !== undefined && isValidLogLevel(next)) {
        logLevel = next;
        i++;
      }
    } else if (arg === "--base-url") {
      const next = args[i + 1];
      if (next !== undefined) {
        baseUrl = next;
        i++;
      }
    } else if (arg === "--dashboard-url") {
      const next = args[i + 1];
      if (next !== undefined) {
        dashboardUrl = next;
        i++;
      }
    } else if (arg === "--agent-name") {
      const next = args[i + 1];
      if (next !== undefined) {
        agentName = next;
        i++;
      }
    }
  }

  return { subcommand, wrapCommand, wrapArgs, logLevel, baseUrl, dashboardUrl, agentName };
}

function printHelp(): void {
  process.stderr.write(
    [
      "multicorn-proxy: MCP permission proxy",
      "",
      "Usage:",
      "  npx multicorn-proxy init",
      "      Interactive setup. Saves API key to ~/.multicorn/config.json.",
      "",
      "  npx multicorn-proxy --wrap <command> [args...]",
      "      Start <command> as an MCP server and proxy all tool calls through",
      "      Shield's permission layer.",
      "",
      "Options:",
      "  --log-level <level>   Log level: debug | info | warn | error  (default: info)",
      "  --base-url <url>      Multicorn API base URL  (default: https://api.multicorn.ai)",
      "  --dashboard-url <url> Dashboard URL for consent page  (default: derived from --base-url)",
      "  --agent-name <name>   Override agent name derived from the wrapped command",
      "",
      "Examples:",
      "  npx multicorn-proxy init",
      "  npx multicorn-proxy --wrap npx @modelcontextprotocol/server-filesystem /tmp",
      "  npx multicorn-proxy --wrap my-mcp-server --log-level debug",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);
  const logger = createLogger(cli.logLevel);

  if (cli.subcommand === "help") {
    printHelp();
    process.exit(0);
  }

  if (cli.subcommand === "init") {
    await runInit(cli.baseUrl);
    return;
  }

  // Validate base URL before any network calls that send the API key.
  if (
    !cli.baseUrl.startsWith("https://") &&
    !cli.baseUrl.startsWith("http://localhost") &&
    !cli.baseUrl.startsWith("http://127.0.0.1")
  ) {
    process.stderr.write(
      `Error: --base-url must use HTTPS. Received: "${cli.baseUrl}"\n` +
        "Use https:// or http://localhost for local development.\n",
    );
    process.exit(1);
  }

  // --wrap mode
  const config = await loadConfig();
  if (config === null) {
    process.stderr.write(
      "No config found. Run `npx multicorn-proxy init` to set up your API key.\n",
    );
    process.exit(1);
  }

  const agentName =
    cli.agentName.length > 0
      ? cli.agentName
      : config.agentName !== undefined && config.agentName.length > 0
        ? config.agentName
        : deriveAgentName(cli.wrapCommand);

  const finalBaseUrl = cli.baseUrl !== "https://api.multicorn.ai" ? cli.baseUrl : config.baseUrl;
  const finalDashboardUrl =
    cli.dashboardUrl !== "" ? cli.dashboardUrl : deriveDashboardUrl(finalBaseUrl);

  const proxy = createProxyServer({
    command: cli.wrapCommand,
    commandArgs: cli.wrapArgs,
    apiKey: config.apiKey,
    agentName,
    baseUrl: finalBaseUrl,
    dashboardUrl: finalDashboardUrl,
    logger,
    platform: "other-mcp",
  });

  async function shutdown(): Promise<void> {
    logger.info("Shutting down.");
    await proxy.stop();
    process.exit(0);
  }

  process.on("SIGTERM", () => {
    void shutdown();
  });

  process.on("SIGINT", () => {
    void shutdown();
  });

  await proxy.start();
}

function deriveAgentName(command: string): string {
  const base = command.split("/").pop() ?? command;
  return base.replace(/\.[cm]?[jt]s$/, "");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
