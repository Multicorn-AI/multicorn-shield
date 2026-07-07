#!/usr/bin/env node
/**
 * multicorn-shield CLI entry point (hosted proxy wizard, MCP wrap, Claude restore).
 *
 * Usage:
 *   npx multicorn-shield init
 *   npx multicorn-shield --wrap <command> [args...]
 *   npx multicorn-shield restore
 *
 * @module bin/multicorn-shield
 */

import {
  loadConfig,
  runInit,
  collectAgentsFromConfig,
  deleteAgentByName,
  getAgentByPlatform,
  getDefaultAgent,
  isAllowedShieldApiBaseUrl,
  DEFAULT_SHIELD_API_BASE_URL,
  type ProxyConfig,
  type InitHybridIntegrationMode,
} from "../src/proxy/config.js";
import { createProxyServer } from "../src/proxy/index.js";
import {
  createLogger,
  isValidLogLevel,
  type LogLevel,
  type ProxyLogger,
} from "../src/proxy/logger.js";
import { deriveDashboardUrl } from "../src/proxy/consent.js";
import { restoreClaudeDesktopMcpFromBackup } from "../src/extension/restore.js";
import { PACKAGE_VERSION } from "../src/package-meta.js";
import { runFilesCommand } from "../src/commands/files.js";

export interface CliArgs {
  readonly subcommand: "init" | "wrap" | "help" | "agents" | "delete-agent" | "files";
  readonly wrapCommand: string;
  readonly wrapArgs: readonly string[];
  readonly logLevel: LogLevel;
  /** Set only when `--base-url` appears on the command line (omit default so init can resolve from config). */
  readonly baseUrl: string | undefined;
  readonly dashboardUrl: string;
  readonly agentName: string;
  readonly deleteAgentName: string;
  /** Set only when `--api-key` appears on the command line. */
  readonly apiKey: string | undefined;
  /** Extra diagnostics during `init` (menu selection, agent counts). */
  readonly verbose: boolean;
  /** `init` subcommand: hybrid platform integration mode (native default). */
  readonly initIntegration: InitHybridIntegrationMode | undefined;
  /** `files` subcommand: directory to share. */
  readonly filesDir: string;
  /** `files` subcommand: filesystem server port. */
  readonly filesPort: number | undefined;
  /** `files` subcommand: proxy port override. */
  readonly filesProxyPort: number | undefined;
  /** `files` subcommand: --stop flag. */
  readonly filesStop: boolean;
  /** `files` subcommand: target coding agent client (e.g. "cursor", "cline"). */
  readonly filesClient: string | undefined;
  /** `files` subcommand: --foreground flag (keep terminal open, for debugging). */
  readonly filesForeground: boolean;
  /** `files` subcommand: status sub-action. */
  readonly filesStatus: boolean;
  /** `files` subcommand: restart sub-action (stop then start). */
  readonly filesRestart: boolean;
  /** `files` subcommand: internal flag to respawn the shared proxy on start. */
  readonly filesRespawnProxy: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);

  let subcommand: CliArgs["subcommand"] = "help";
  let wrapCommand = "";
  let wrapArgs: string[] = [];
  let logLevel: LogLevel = "info";
  let baseUrl: string | undefined = undefined;
  let dashboardUrl = "";
  let agentName = "";
  let deleteAgentName = "";
  let apiKey: string | undefined = undefined;
  let verbose = false;
  let filesDir = "";
  let filesPort: number | undefined = undefined;
  let filesProxyPort: number | undefined = undefined;
  let filesStop = false;
  let filesClient: string | undefined = undefined;
  let filesForeground = false;
  let filesStatus = false;
  let filesRestart = false;
  let filesRespawnProxy = false;
  let initIntegration: InitHybridIntegrationMode | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "init") {
      subcommand = "init";
    } else if (arg === "files") {
      subcommand = "files";
      // Parse files-specific args from remainder
      const tail = args.slice(i + 1);
      for (let j = 0; j < tail.length; j++) {
        const token = tail[j];
        if (token === undefined) continue;
        if (token === "--agent") {
          const value = tail[j + 1];
          if (value !== undefined) {
            agentName = value;
            j++;
          }
        } else if (token === "--port") {
          const value = tail[j + 1];
          if (value !== undefined) {
            filesPort = Number.parseInt(value, 10);
            j++;
          }
        } else if (token === "--proxy-port") {
          const value = tail[j + 1];
          if (value !== undefined) {
            filesProxyPort = Number.parseInt(value, 10);
            j++;
          }
        } else if (token === "--api-key") {
          const value = tail[j + 1];
          if (value !== undefined) {
            apiKey = value;
            j++;
          }
        } else if (token === "--base-url") {
          const value = tail[j + 1];
          if (value !== undefined) {
            baseUrl = value;
            j++;
          }
        } else if (token === "--client") {
          const value = tail[j + 1];
          if (value !== undefined) {
            filesClient = value;
            j++;
          }
        } else if (token === "--stop") {
          filesStop = true;
        } else if (token === "--foreground") {
          filesForeground = true;
        } else if (token === "--respawn-proxy") {
          filesRespawnProxy = true;
        } else if (token === "--detach") {
          // Legacy flag (now default behavior) - ignored
        } else if (token === "stop") {
          filesStop = true;
        } else if (token === "status") {
          filesStatus = true;
        } else if (token === "restart") {
          filesRestart = true;
        } else if (!token.startsWith("-") && filesDir === "") {
          filesDir = token;
        }
      }
      break;
    } else if (arg === "agents") {
      subcommand = "agents";
    } else if (arg === "delete-agent") {
      subcommand = "delete-agent";
      const name = args[i + 1];
      if (name === undefined || name.startsWith("-")) {
        process.stderr.write("Error: delete-agent requires an agent name.\n");
        process.stderr.write("Example: npx multicorn-shield delete-agent my-agent\n");
        process.exit(1);
      }
      deleteAgentName = name;
      i++;
    } else if (arg === "--wrap") {
      subcommand = "wrap";
      const tail = args.slice(i + 1);

      // Strip proxy-owned flags from the tail. Once we encounter a
      // non-flag token, everything from that point on belongs to the
      // child command (even if later tokens look like flags).
      const remaining: string[] = [];
      for (let j = 0; j < tail.length; j++) {
        const token = tail[j];
        if (token === undefined) continue;
        if (remaining.length > 0) {
          remaining.push(token);
          continue;
        }
        if (token === "--agent-name") {
          const value = tail[j + 1];
          if (value !== undefined) {
            agentName = value;
            j++;
          }
        } else if (token === "--log-level") {
          const value = tail[j + 1];
          if (value !== undefined && isValidLogLevel(value)) {
            logLevel = value;
            j++;
          }
        } else if (token === "--base-url") {
          const value = tail[j + 1];
          if (value !== undefined) {
            baseUrl = value;
            j++;
          }
        } else if (token === "--dashboard-url") {
          const value = tail[j + 1];
          if (value !== undefined) {
            dashboardUrl = value;
            j++;
          }
        } else if (token === "--api-key") {
          const value = tail[j + 1];
          if (value !== undefined) {
            apiKey = value;
            j++;
          }
        } else {
          remaining.push(token);
        }
      }

      if (remaining.length === 0) {
        process.stderr.write("Error: --wrap requires a command to run.\n");
        process.stderr.write("Example: npx multicorn-shield --wrap my-mcp-server\n");
        process.exit(1);
      }
      wrapCommand = remaining[0] ?? "";
      wrapArgs = remaining.slice(1);
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
    } else if (arg === "--api-key") {
      const next = args[i + 1];
      if (next !== undefined) {
        apiKey = next;
        i++;
      }
    } else if (arg === "--verbose" || arg === "--debug") {
      verbose = true;
    } else if (arg === "--integration") {
      const next = args[i + 1];
      if (next === "native" || next === "hosted") {
        initIntegration = next;
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
    apiKey,
    verbose,
    initIntegration,
    filesDir,
    filesPort,
    filesProxyPort,
    filesStop,
    filesClient,
    filesForeground,
    filesStatus,
    filesRestart,
    filesRespawnProxy,
  };
}

function printHelp(): void {
  process.stderr.write(
    [
      "multicorn-shield: MCP permission proxy and Shield setup",
      "",
      "Usage:",
      "  npx multicorn-shield init",
      "      Interactive setup for native plugins (files, terminal, browser).",
      "      Native: OpenClaw, Claude Code, Windsurf, Cline, Gemini CLI, OpenCode, Codex CLI.",
      "      MCP-only clients (Cursor, Copilot, etc.): https://app.multicorn.ai/agents/new",
      "      Saves API key to ~/.multicorn/config.json.",
      "      --integration hosted  Use hosted MCP proxy for Windsurf, Cline, Gemini CLI,",
      "                            OpenCode, or Codex CLI (default: native).",
      "",
      "  npx multicorn-shield files <dir> --agent <name> [--client <client>]",
      "      Share a local folder with a coding agent. Starts a filesystem MCP server",
      "      scoped to <dir>, registers the agent, writes your coding agent's MCP config,",
      "      then exits. The service runs in the background until stopped.",
      "",
      "      --client <name>  Target client: cursor, cline, windsurf, claude, copilot,",
      "                       goose, gemini, codex, continue, kilo, opencode",
      "                       Auto-detected if omitted. Use --client all to write to every",
      "                       detected client.",
      "      --foreground     Keep the terminal open (for debugging). Default is background.",
      "      --stop           Tear down the servers started by a previous `files` invocation.",
      "",
      "  npx multicorn-shield files stop --agent <name>",
      "      Stop background processes for the named agent.",
      "",
      "  npx multicorn-shield files restart --agent <name>",
      "      Stop then start the named agent, reusing the folder from its last run.",
      "      Rewrites the coding agent's MCP config entry, so this repairs a stale",
      "      entry that a plain stop/start would leave in place.",
      "",
      "  npx multicorn-shield files status",
      "      Show all running file-sharing sessions.",
      "",
      "  npx multicorn-shield restore",
      "      Restore MCP servers in claude_desktop_config.json from the Shield extension backup.",
      "",
      "  npx multicorn-shield agents",
      "      List configured agents and show which is the default.",
      "",
      "  npx multicorn-shield delete-agent <name>",
      "      Remove a saved agent.",
      "",
      "  npx multicorn-shield --wrap <command> [args...]",
      "      Start <command> as an MCP server and proxy all tool calls through",
      "      Shield's permission layer.",
      "",
      "Options:",
      "  --version, -v        Print version and exit",
      "  --verbose, --debug   Print extra diagnostics during init (menu selection, agent counts)",
      "  --api-key <key>       Multicorn API key (overrides MULTICORN_API_KEY env var and config file)",
      "  --log-level <level>   Log level: debug | info | warn | error  (default: info)",
      "  --base-url <url>      Multicorn API base URL  (default: https://api.multicorn.ai)",
      "  --dashboard-url <url> Dashboard URL for consent page  (default: derived from --base-url)",
      "  --agent-name <name>   Override agent name derived from the wrapped command",
      "",
      "Examples:",
      "  npx multicorn-shield init",
      "  npx multicorn-shield files ./my-repo --agent my-agent",
      "  npx multicorn-shield files ./my-repo --agent my-agent --foreground",
      "  npx multicorn-shield files status",
      "  npx multicorn-shield files stop --agent my-agent",
      "  npx multicorn-shield files restart --agent my-agent",
      "  npx multicorn-shield --wrap npx @modelcontextprotocol/server-filesystem /tmp",
      "  npx multicorn-shield --wrap my-mcp-server --log-level debug",
      "",
    ].join("\n"),
  );
}

export async function runCli(): Promise<void> {
  const first = process.argv[2];
  if (first === "restore") {
    await restoreClaudeDesktopMcpFromBackup();
    process.stderr.write(
      "Restored MCP server entries from ~/.multicorn/extension-backup.json into Claude Desktop config.\n" +
        "Restart Claude Desktop to apply changes.\n",
    );
    return;
  }

  if (first === "--version" || first === "-v") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    process.exit(0);
  }

  const cli = parseArgs(process.argv);
  const logger = createLogger(cli.logLevel);

  if (cli.subcommand === "help") {
    printHelp();
    process.exit(0);
  }

  if (cli.subcommand === "init") {
    await runInit(cli.baseUrl, {
      verbose: cli.verbose,
      ...(cli.initIntegration !== undefined ? { integration: cli.initIntegration } : {}),
    });
    return;
  }

  if (cli.subcommand === "files") {
    if (cli.filesStatus) {
      await runFilesCommand({
        dir: "",
        agent: "",
        port: undefined,
        proxyPort: undefined,
        apiKey: undefined,
        baseUrl: undefined,
        stop: false,
        client: undefined,
        foreground: true,
        status: true,
        restart: false,
        respawnProxy: false,
      });
      return;
    }
    if (!cli.filesStop && cli.agentName.length === 0) {
      process.stderr.write("Error: --agent <name> is required for the files command.\n");
      process.stderr.write("Example: npx multicorn-shield files ./my-repo --agent my-agent\n");
      process.exit(1);
    }
    // restart can recover the folder from the running session, so it doesn't
    // require a directory argument the way a fresh start does.
    if (!cli.filesStop && !cli.filesRestart && cli.filesDir.length === 0) {
      process.stderr.write("Error: a directory path is required.\n");
      process.stderr.write("Example: npx multicorn-shield files ./my-repo --agent my-agent\n");
      process.exit(1);
    }
    await runFilesCommand({
      dir: cli.filesDir,
      agent: cli.agentName,
      port: cli.filesPort,
      proxyPort: cli.filesProxyPort,
      apiKey: cli.apiKey,
      baseUrl: cli.baseUrl,
      stop: cli.filesStop,
      client: cli.filesClient,
      foreground: cli.filesForeground,
      status: false,
      restart: cli.filesRestart,
      respawnProxy: cli.filesRespawnProxy,
    });
    return;
  }

  if (cli.subcommand === "agents") {
    const config = await loadConfig();
    if (config === null) {
      process.stderr.write(
        "No config found. Run `npx multicorn-shield init` to set up your API key.\n",
      );
      process.exit(1);
    }
    const agents = collectAgentsFromConfig(config);
    if (agents.length === 0) {
      process.stderr.write("No agents configured. Run `npx multicorn-shield init` to add one.\n");
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

  // --wrap mode: validate explicit --base-url before disk read when the flag is set.
  if (cli.baseUrl !== undefined && cli.baseUrl.length > 0) {
    if (!isAllowedShieldApiBaseUrl(cli.baseUrl)) {
      process.stderr.write(
        "Error: --base-url must use HTTPS. Received a non-HTTPS URL.\n" +
          "Use https:// or http://localhost for local development.\n",
      );
      process.exit(1);
    }
  }

  // Resolve API key: CLI flag > env var > config file.
  const config = await resolveWrapConfig(cli, logger);

  const finalBaseUrl =
    cli.baseUrl !== undefined && cli.baseUrl.length > 0 ? cli.baseUrl : config.baseUrl;

  if (cli.baseUrl === undefined || cli.baseUrl.length === 0) {
    if (!isAllowedShieldApiBaseUrl(finalBaseUrl)) {
      process.stderr.write(
        "Error: --base-url must use HTTPS. Received a non-HTTPS URL.\n" +
          "Use https:// or http://localhost for local development.\n",
      );
      process.exit(1);
    }
  }

  const agentName = resolveWrapAgentName(cli, config);
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

/**
 * Resolve the proxy config for --wrap mode.
 * Priority: --api-key flag > MULTICORN_API_KEY env var > ~/.multicorn/config.json.
 * When the key comes from flag or env, an in-memory config is built (nothing written to disk).
 */
export async function resolveWrapConfig(cli: CliArgs, logger: ProxyLogger): Promise<ProxyConfig> {
  // 1. --api-key CLI flag
  if (cli.apiKey !== undefined && cli.apiKey.length > 0) {
    logger.debug("Using API key from --api-key flag.");
    return {
      apiKey: cli.apiKey,
      baseUrl: cli.baseUrl ?? DEFAULT_SHIELD_API_BASE_URL,
    };
  }

  // 2. MULTICORN_API_KEY env var
  const envKey = process.env["MULTICORN_API_KEY"];
  if (typeof envKey === "string" && envKey.length > 0) {
    logger.debug("Using API key from MULTICORN_API_KEY environment variable.");
    return {
      apiKey: envKey,
      baseUrl: cli.baseUrl ?? DEFAULT_SHIELD_API_BASE_URL,
    };
  }

  // 3. Config file
  const config = await loadConfig();
  if (config !== null) {
    return config;
  }

  process.stderr.write(
    "No API key found. Provide one via the --api-key flag, the MULTICORN_API_KEY " +
      "environment variable, or run `npx multicorn-shield init` to set up a config file.\n",
  );
  process.exit(1);
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
  const fromPlatform = getAgentByPlatform(config, platformKey, process.cwd());
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

// Only run runCli when executed as this script directly, not when imported for testing or deprecated shim.
const isDirectRun =
  process.argv[1] !== undefined &&
  (import.meta.url.endsWith(process.argv[1]) ||
    import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith("/multicorn-shield.js") ||
    import.meta.url.endsWith("/multicorn-shield.ts"));

if (isDirectRun && process.env["VITEST"] === undefined) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Fatal error: ${message}\n`);
    process.exit(1);
  });
}
