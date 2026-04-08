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

import {
  loadConfig,
  runInit,
  collectAgentsFromConfig,
  deleteAgentByName,
  getAgentByPlatform,
  getDefaultAgent,
  type ProxyConfig,
} from "../src/proxy/config.js";
import { createProxyServer } from "../src/proxy/index.js";
import { createLogger, isValidLogLevel, type LogLevel } from "../src/proxy/logger.js";
import { deriveDashboardUrl } from "../src/proxy/consent.js";

interface CliArgs {
  readonly subcommand: "init" | "wrap" | "help" | "agents" | "delete-agent";
  readonly wrapCommand: string;
  readonly wrapArgs: readonly string[];
  readonly logLevel: LogLevel;
  readonly baseUrl: string;
  readonly dashboardUrl: string;
  readonly agentName: string;
  readonly deleteAgentName: string;
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
  let deleteAgentName = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "init") {
      subcommand = "init";
    } else if (arg === "agents") {
      subcommand = "agents";
    } else if (arg === "delete-agent") {
      subcommand = "delete-agent";
      const name = args[i + 1];
      if (name === undefined || name.startsWith("-")) {
        process.stderr.write("Error: delete-agent requires an agent name.\n");
        process.stderr.write("Example: npx multicorn-proxy delete-agent my-agent\n");
        process.exit(1);
      }
      deleteAgentName = name;
      i++;
    } else if (arg === "--wrap") {
      subcommand = "wrap";
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        process.stderr.write("Error: --wrap requires a command to run.\n");
        process.stderr.write("Example: npx multicorn-proxy --wrap my-mcp-server\n");
        process.exit(1);
      }
      wrapCommand = next;
      wrapArgs = args.slice(i + 2);

      // Strip proxy-owned flags that ended up after --wrap so they
      // aren't forwarded to the child process.
      const cleaned: string[] = [];
      for (let j = 0; j < wrapArgs.length; j++) {
        const token = wrapArgs[j];
        if (token === "--agent-name") {
          const value = wrapArgs[j + 1];
          if (value !== undefined) {
            agentName = value;
            j++;
          }
        } else if (token === "--log-level") {
          const value = wrapArgs[j + 1];
          if (value !== undefined && isValidLogLevel(value)) {
            logLevel = value;
            j++;
          }
        } else if (token === "--base-url") {
          const value = wrapArgs[j + 1];
          if (value !== undefined) {
            baseUrl = value;
            j++;
          }
        } else if (token === "--dashboard-url") {
          const value = wrapArgs[j + 1];
          if (value !== undefined) {
            dashboardUrl = value;
            j++;
          }
        } else if (token !== undefined) {
          cleaned.push(token);
        }
      }
      wrapArgs = cleaned;
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

  return {
    subcommand,
    wrapCommand,
    wrapArgs,
    logLevel,
    baseUrl,
    dashboardUrl,
    agentName,
    deleteAgentName,
  };
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
      "  npx multicorn-proxy agents",
      "      List configured agents and show which is the default.",
      "",
      "  npx multicorn-proxy delete-agent <name>",
      "      Remove a saved agent.",
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

  if (cli.subcommand === "agents") {
    const config = await loadConfig();
    if (config === null) {
      process.stderr.write(
        "No config found. Run `npx multicorn-proxy init` to set up your API key.\n",
      );
      process.exit(1);
    }
    const agents = collectAgentsFromConfig(config);
    if (agents.length === 0) {
      process.stderr.write("No agents configured. Run `npx multicorn-proxy init` to add one.\n");
      process.exit(0);
    }
    const def = config.defaultAgent;
    process.stdout.write("Configured agents:\n");
    for (const a of agents) {
      const mark = a.name === def ? " (default)" : "";
      process.stdout.write(`${a.name} (${a.platform})${mark}\n`);
    }
    return;
  }

  if (cli.subcommand === "delete-agent") {
    const safeName = cli.deleteAgentName.replace(/[^\x20-\x7E]/g, "");
    const ok = await deleteAgentByName(cli.deleteAgentName);
    if (!ok) {
      process.stderr.write(`No agent named "${safeName}" in config.\n`);
      process.exit(1);
    }
    process.stdout.write(`Removed agent "${safeName}".\n`);
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

  const agentName = resolveWrapAgentName(cli, config);

  const finalBaseUrl = cli.baseUrl !== "https://api.multicorn.ai" ? cli.baseUrl : config.baseUrl;
  const finalDashboardUrl =
    cli.dashboardUrl !== "" ? cli.dashboardUrl : deriveDashboardUrl(finalBaseUrl);

  /* eslint-disable @typescript-eslint/no-deprecated -- legacy top-level platform until wrap supports --platform */
  const legacyPlatform = config.platform;
  /* eslint-enable @typescript-eslint/no-deprecated */
  const platformForServer =
    typeof legacyPlatform === "string" && legacyPlatform.length > 0 ? legacyPlatform : "other-mcp";

  const proxy = createProxyServer({
    command: cli.wrapCommand,
    commandArgs: cli.wrapArgs,
    apiKey: config.apiKey,
    agentName,
    baseUrl: finalBaseUrl,
    dashboardUrl: finalDashboardUrl,
    logger,
    platform: platformForServer,
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

function resolveWrapAgentName(cli: CliArgs, config: ProxyConfig): string {
  if (cli.agentName.length > 0) {
    return cli.agentName;
  }
  /* eslint-disable @typescript-eslint/no-deprecated -- legacy top-level fields for wrap defaulting until --platform exists */
  const legacyPlatform = config.platform;
  const legacyAgentName = config.agentName;
  /* eslint-enable @typescript-eslint/no-deprecated */
  // After migration, config.platform is usually absent so this lookup falls through to getDefaultAgent. When --platform is added as a CLI flag, this becomes the primary resolution path.
  const platformKey =
    typeof legacyPlatform === "string" && legacyPlatform.length > 0 ? legacyPlatform : "other-mcp";
  const fromPlatform = getAgentByPlatform(config, platformKey);
  if (fromPlatform !== undefined) {
    return fromPlatform.name;
  }
  const fallbackDefault = getDefaultAgent(config);
  if (fallbackDefault !== undefined) {
    return fallbackDefault.name;
  }
  if (typeof legacyAgentName === "string" && legacyAgentName.length > 0) {
    return legacyAgentName;
  }
  return deriveAgentName(cli.wrapCommand);
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
