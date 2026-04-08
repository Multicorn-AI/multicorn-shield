/**
 * Config management for the MCP proxy.
 *
 * Reads and writes `~/.multicorn/config.json`. The interactive `init` command
 * prompts for an API key, validates it against the service, then saves it.
 *
 * @module proxy/config
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const style = {
  violet: (s: string) => `\x1b[38;2;124;58;237m${s}\x1b[0m`,
  violetLight: (s: string) => `\x1b[38;2;167;139;250m${s}\x1b[0m`,
  green: (s: string) => `\x1b[38;2;34;197;94m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[38;2;245;158;11m${s}\x1b[0m`,
  red: (s: string) => `\x1b[38;2;239;68;68m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[38;2;6;182;212m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

const BANNER = [
  " ███ █  █ █ ███ █   ██▄ ",
  " █   █  █ █ █   █   █  █",
  " ███ ████ █ ██  █   █  █",
  "   █ █  █ █ █   █   █  █",
  " ███ █  █ █ ███ ███ ██▀ ",
]
  .map((line) => style.violet(line))
  .join("\n");

function withSpinner(message: string): { stop: (success: boolean, result: string) => void } {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const interval = setInterval(() => {
    const frame = frames[i % frames.length];
    process.stderr.write(`\r${style.violet(frame ?? "⠋")} ${message}`);
    i++;
  }, 80);
  return {
    stop(success: boolean, result: string) {
      clearInterval(interval);
      const icon = success ? style.green("✓") : style.red("✗");
      process.stderr.write(`\r\x1b[2K${icon} ${result}\n`);
    },
  };
}

const CONFIG_DIR = join(homedir(), ".multicorn");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

export type OpenClawUpdateResult = "updated" | "not-found" | "parse-error";

export interface ProxyConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly agentName?: string;
  readonly platform?: string;
}

export interface ApiKeyValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

export async function loadConfig(): Promise<ProxyConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isProxyConfig(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveConfig(config: ProxyConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Mode 0o600: owner read/write only. Prevents other users from reading the API key.
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === "object" && e !== null && "code" in e;
}

/**
 * If ~/.openclaw/openclaw.json exists, set MULTICORN_API_KEY, MULTICORN_BASE_URL,
 * and optionally MULTICORN_AGENT_NAME under hooks.internal.entries["multicorn-shield"].env.
 * Returns the outcome so the caller can decide how to message the user.
 */
export async function updateOpenClawConfigIfPresent(
  apiKey: string,
  baseUrl: string,
  agentName?: string,
): Promise<OpenClawUpdateResult> {
  let raw: string;
  try {
    raw = await readFile(OPENCLAW_CONFIG_PATH, "utf8");
  } catch (e) {
    if (isErrnoException(e) && e.code === "ENOENT") {
      return "not-found";
    }
    throw e;
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "parse-error";
  }

  let hooks = obj["hooks"] as Record<string, unknown> | undefined;
  if (hooks === undefined || typeof hooks !== "object") {
    hooks = {};
    obj["hooks"] = hooks;
  }
  let internal = hooks["internal"] as Record<string, unknown> | undefined;
  if (internal === undefined || typeof internal !== "object") {
    internal = { enabled: true, entries: {} };
    hooks["internal"] = internal;
  }
  let entries = internal["entries"] as Record<string, unknown> | undefined;
  if (entries === undefined || typeof entries !== "object") {
    entries = {};
    internal["entries"] = entries;
  }
  let shield = entries["multicorn-shield"] as Record<string, unknown> | undefined;
  if (shield === undefined || typeof shield !== "object") {
    shield = { enabled: true, env: {} };
    entries["multicorn-shield"] = shield;
  }
  let env = shield["env"] as Record<string, unknown> | undefined;
  if (env === undefined || typeof env !== "object") {
    env = {};
    shield["env"] = env;
  }
  env["MULTICORN_API_KEY"] = apiKey;
  env["MULTICORN_BASE_URL"] = baseUrl;
  if (agentName !== undefined) {
    env["MULTICORN_AGENT_NAME"] = agentName;

    // Overwrite the default agent (first entry) in agents.list so the TUI picks up the name
    const agentsList = obj["agents"] as Record<string, unknown> | undefined;
    const list = agentsList?.["list"];
    if (Array.isArray(list) && list.length > 0) {
      const first = list[0] as Record<string, unknown>;
      if (first["id"] !== agentName) {
        first["id"] = agentName;
        first["name"] = agentName;
      }
    } else {
      if (agentsList !== undefined && typeof agentsList === "object") {
        agentsList["list"] = [{ id: agentName, name: agentName }];
      } else {
        obj["agents"] = { list: [{ id: agentName, name: agentName }] };
      }
    }
  }

  await writeFile(OPENCLAW_CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n", {
    encoding: "utf8",
  });
  return "updated";
}

export async function validateApiKey(
  apiKey: string,
  baseUrl: string,
): Promise<ApiKeyValidationResult> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/agents`, {
      headers: { "X-Multicorn-Key": apiKey },
      signal: AbortSignal.timeout(8000),
    });

    if (response.status === 401) {
      return { valid: false, error: "API key not recognised. Check the key and try again." };
    }

    if (!response.ok) {
      return {
        valid: false,
        error: `Service returned ${String(response.status)}. Check your base URL and try again.`,
      };
    }

    return { valid: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      error: `Could not reach ${baseUrl}. Check your network connection. (${detail})`,
    };
  }
}

function normalizeAgentName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

async function isOpenClawConnected(): Promise<boolean> {
  try {
    const raw = await readFile(OPENCLAW_CONFIG_PATH, "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const hooks = obj["hooks"] as Record<string, unknown> | undefined;
    const internal = hooks?.["internal"] as Record<string, unknown> | undefined;
    const entries = internal?.["entries"] as Record<string, unknown> | undefined;
    const shield = entries?.["multicorn-shield"] as Record<string, unknown> | undefined;
    const env = shield?.["env"] as Record<string, unknown> | undefined;
    const key = env?.["MULTICORN_API_KEY"];
    return typeof key === "string" && key.length > 0;
  } catch {
    return false;
  }
}

function isClaudeCodeConnected(): boolean {
  try {
    return existsSync(join(homedir(), ".claude", "plugins", "cache", "multicorn-shield"));
  } catch {
    return false;
  }
}

export function getClaudeDesktopConfigPath(): string {
  switch (process.platform) {
    case "win32":
      return join(
        process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json",
      );
    case "linux":
      return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
    default:
      return join(
        homedir(),
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      );
  }
}

export type ClaudeDesktopUpdateResult = "updated" | "created" | "parse-error" | "skipped";

export function getCursorConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

async function isCursorConnected(): Promise<boolean> {
  try {
    const raw = await readFile(getCursorConfigPath(), "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const mcpServers = obj["mcpServers"] as Record<string, unknown> | undefined;
    if (mcpServers === undefined || typeof mcpServers !== "object") return false;
    for (const entry of Object.values(mcpServers)) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const url = rec["url"];
      if (typeof url === "string" && url.includes("multicorn")) return true;
      const args = rec["args"];
      if (Array.isArray(args) && args.includes("multicorn-proxy")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function updateClaudeDesktopConfig(
  agentName: string,
  mcpServerCommand: string,
  overwrite = false,
): Promise<ClaudeDesktopUpdateResult> {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentName)) {
    throw new Error("Agent name must contain only letters, numbers, hyphens, and underscores");
  }

  const configPath = getClaudeDesktopConfigPath();

  let obj: Record<string, unknown> = {};
  let fileExists = false;

  try {
    const raw = await readFile(configPath, "utf8");
    fileExists = true;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return "parse-error";
    }
  } catch (e) {
    if (isErrnoException(e) && e.code === "ENOENT") {
      fileExists = false;
    } else {
      throw e;
    }
  }

  let mcpServers = obj["mcpServers"] as Record<string, unknown> | undefined;
  if (mcpServers === undefined || typeof mcpServers !== "object") {
    mcpServers = {};
    obj["mcpServers"] = mcpServers;
  }

  if (mcpServers[agentName] !== undefined && !overwrite) {
    return "skipped";
  }

  const commandParts = mcpServerCommand.trim().split(/\s+/);

  mcpServers[agentName] = {
    command: "npx",
    args: ["multicorn-proxy", "--wrap", ...commandParts, "--agent-name", agentName],
  };

  const configDir = join(configPath, "..");
  if (!fileExists) {
    await mkdir(configDir, { recursive: true });
  }
  await writeFile(configPath, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8" });
  return fileExists ? "updated" : "created";
}

// TODO SR-03: Refactor runInit into smaller functions once the interactive flow is finalized
export async function runInit(
  baseUrl = "https://api.multicorn.ai",
  platform?: string,
): Promise<ProxyConfig | null> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      style.red("Error: interactive terminal required. Cannot run init with piped input.") + "\n",
    );
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  function ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        resolve(answer);
      });
    });
  }

  // Banner + header
  process.stderr.write("\n" + BANNER + "\n");
  process.stderr.write(style.dim("Agent governance for the AI era") + "\n\n");
  process.stderr.write(style.bold(style.violet("Multicorn Shield proxy setup")) + "\n\n");
  process.stderr.write(
    style.dim("Get your API key at https://app.multicorn.ai/settings/api-keys") + "\n\n",
  );

  // Step A: API key
  let apiKey = "";
  const existing = await loadConfig().catch(() => null);

  // Resolve baseUrl: --base-url flag > config file > env var > hardcoded default.
  // This must happen before key validation so all code paths hit the right server.
  if (baseUrl === "https://api.multicorn.ai") {
    if (existing !== null && existing.baseUrl.length > 0) {
      baseUrl = existing.baseUrl;
    } else {
      const envBaseUrl = process.env["MULTICORN_BASE_URL"];
      if (envBaseUrl !== undefined && envBaseUrl.length > 0) {
        baseUrl = envBaseUrl;
      }
    }
  }

  if (existing !== null && existing.apiKey.startsWith("mcs_") && existing.apiKey.length >= 8) {
    const masked = "mcs_..." + existing.apiKey.slice(-4);
    process.stderr.write("Found existing API key: " + style.cyan(masked) + "\n");
    const answer = await ask("Use this key? (Y/n) ");
    if (answer.trim().toLowerCase() !== "n") {
      apiKey = existing.apiKey;
    }
  }

  while (apiKey.length === 0) {
    const input = await ask("API key (starts with mcs_): ");
    const key = input.trim();

    if (key.length === 0) {
      process.stderr.write(style.red("API key is required.") + "\n");
      continue;
    }

    const spinner = withSpinner("Validating key...");
    let result: Awaited<ReturnType<typeof validateApiKey>>;
    try {
      result = await validateApiKey(key, baseUrl);
    } catch (error) {
      spinner.stop(false, "Validation failed");
      throw error;
    }

    if (!result.valid) {
      spinner.stop(false, result.error ?? "Validation failed. Try again.");
      continue;
    }

    spinner.stop(true, "Key validated");
    apiKey = key;
  }

  interface ConfiguredAgent {
    readonly platformLabel: string;
    readonly agentName: string;
    readonly shortName?: string;
    readonly proxyUrl?: string;
  }

  const configuredAgents: ConfiguredAgent[] = [];
  let lastConfig: ProxyConfig = {
    apiKey,
    baseUrl,
    ...(platform !== undefined ? { platform } : {}),
  };

  const platformLabels = ["OpenClaw", "Claude Code", "Cursor"];
  const platformBySelection: Record<number, string> = {
    1: "openclaw",
    2: "claude-code",
    3: "cursor",
  };
  const defaultAgentNames: Record<number, string> = {
    1: "my-openclaw-agent",
    2: "my-claude-code-agent",
    3: "my-cursor-agent",
  };

  let configuring = true;
  while (configuring) {
    // Step 1: Platform selection
    process.stderr.write(
      "\n" + style.bold(style.violet("Which platform are you connecting?")) + "\n",
    );
    const openClawConnected = await isOpenClawConnected();
    const claudeCodeConnected = isClaudeCodeConnected();
    const cursorConnected = await isCursorConnected();
    for (let i = 0; i < platformLabels.length; i++) {
      let connectedMarker = "";
      if (i === 0 && openClawConnected) {
        connectedMarker = " " + style.green("\u2713") + style.dim(" connected");
      } else if (i === 1 && claudeCodeConnected) {
        connectedMarker = " " + style.green("\u2713") + style.dim(" connected");
      } else if (i === 2 && cursorConnected) {
        connectedMarker = " " + style.green("\u2713") + style.dim(" connected");
      }
      process.stderr.write(
        `  ${style.violet(String(i + 1))}. ${platformLabels[i] ?? ""}${connectedMarker}\n`,
      );
    }

    let selection = 0;
    while (selection === 0) {
      const input = await ask("Select (1-3): ");
      const num = parseInt(input.trim(), 10);
      if (num >= 1 && num <= 3) {
        selection = num;
      }
    }

    const selectedPlatform = platformBySelection[selection] ?? "cursor";
    const selectedLabel = platformLabels[selection - 1] ?? "Cursor";

    // Step 2: Agent name (with platform-based default)
    const defaultAgentName = defaultAgentNames[selection] ?? "my-agent";
    let agentName = "";
    while (agentName.length === 0) {
      const input = await ask(
        `\nWhat would you like to call this agent? ${style.dim(`(${defaultAgentName})`)} `,
      );
      const raw = input.trim().length > 0 ? input.trim() : defaultAgentName;
      const transformed = normalizeAgentName(raw);
      if (transformed.length === 0) {
        process.stderr.write(
          style.red("Agent name must contain letters or numbers. Please try again.") + "\n",
        );
        continue;
      }
      if (transformed !== raw) {
        process.stderr.write(style.yellow("Agent name set to: ") + style.cyan(transformed) + "\n");
      }
      agentName = transformed;
    }

    if (selection === 1) {
      // OpenClaw: no MCP server URL or short name needed
      process.stderr.write("\n" + style.green("\u2713") + " Agent registered!\n");
      process.stderr.write(
        "\nTo connect this agent, add the Multicorn Shield plugin to your OpenClaw agent:\n",
      );
      process.stderr.write("\n  " + style.cyan("openclaw plugins add multicorn-shield") + "\n");
      process.stderr.write(
        "\nThen start your agent. Shield will intercept tool calls automatically.\n",
      );
      configuredAgents.push({
        platformLabel: selectedLabel,
        agentName,
      });
    } else if (selection === 2) {
      // Claude Code: no MCP server URL or short name needed
      process.stderr.write("\n" + style.green("\u2713") + " Agent registered!\n");
      process.stderr.write(
        "\nTo connect this agent, install the Multicorn Shield plugin in Claude Code:\n",
      );
      process.stderr.write("\n  " + style.cyan("claude plugins install multicorn-shield") + "\n");
      process.stderr.write(
        "\nThen start a new Claude Code session. Shield will intercept tool calls automatically.\n",
      );
      configuredAgents.push({
        platformLabel: selectedLabel,
        agentName,
      });
    } else {
      // Cursor: full flow with MCP server URL, short name, and proxy config

      // Step 3: Target MCP server URL (required)
      let targetUrl = "";
      while (targetUrl.length === 0) {
        process.stderr.write(
          "\n" +
            style.bold("Your MCP server URL:") +
            "\n" +
            style.dim(
              "The URL of the MCP server Shield will govern. Example: http://127.0.0.1:3847/mcp",
            ) +
            "\n",
        );
        const input = await ask("URL: ");
        if (input.trim().length === 0) {
          process.stderr.write(style.red("MCP server URL is required.") + "\n");
          continue;
        }
        targetUrl = input.trim();
      }

      // Step 4: Short name (auto-generated from agent name)
      const defaultShortName = normalizeAgentName(agentName) || "shield-mcp";
      const shortNameInput = await ask(
        `\nShort name (used in your proxy URL): ${style.dim(`(${defaultShortName})`)} `,
      );
      const shortName =
        shortNameInput.trim().length > 0
          ? normalizeAgentName(shortNameInput.trim()) || defaultShortName
          : defaultShortName;

      // Step 5: Create proxy config via API
      let proxyUrl = "";
      let created = false;
      while (!created) {
        const spinner = withSpinner("Creating proxy config...");
        try {
          const response = await fetch(`${baseUrl}/api/v1/proxy/config`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Multicorn-Key": apiKey,
            },
            body: JSON.stringify({
              server_name: shortName,
              target_url: targetUrl,
              platform: selectedPlatform,
              agent_name: agentName,
            }),
            signal: AbortSignal.timeout(10000),
          });

          if (!response.ok) {
            let errorMsg = `Service returned ${String(response.status)}.`;
            try {
              const errBody = (await response.json()) as Record<string, unknown>;
              const errObj = errBody["error"] as Record<string, unknown> | undefined;
              if (typeof errObj?.["message"] === "string") {
                errorMsg = errObj["message"];
              } else if (typeof errBody["message"] === "string") {
                errorMsg = errBody["message"];
              } else if (typeof errBody["detail"] === "string") {
                errorMsg = errBody["detail"];
              }
            } catch {
              // response body wasn't JSON
            }
            spinner.stop(false, errorMsg);
            const retry = await ask("Try again? (Y/n) ");
            if (retry.trim().toLowerCase() === "n") {
              break;
            }
            continue;
          }

          const envelope = (await response.json()) as Record<string, unknown>;
          const data = envelope["data"] as Record<string, unknown> | undefined;
          proxyUrl = typeof data?.["proxy_url"] === "string" ? data["proxy_url"] : "";
          spinner.stop(true, "Proxy config created!");
          created = true;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          spinner.stop(false, `Failed to create proxy config: ${detail}`);
          const retry = await ask("Try again? (Y/n) ");
          if (retry.trim().toLowerCase() === "n") {
            break;
          }
        }
      }

      if (created && proxyUrl.length > 0) {
        process.stderr.write("\n" + style.bold("Your Shield proxy URL:") + "\n");
        process.stderr.write("  " + style.cyan(proxyUrl) + "\n");

        const mcpSnippet = JSON.stringify(
          {
            mcpServers: {
              [shortName]: {
                url: proxyUrl,
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                },
              },
            },
          },
          null,
          2,
        );

        process.stderr.write("\n" + style.dim("Add this to ~/.cursor/mcp.json:") + "\n\n");
        process.stderr.write(style.cyan(mcpSnippet) + "\n\n");
        process.stderr.write(
          style.dim("Replace YOUR_SHIELD_API_KEY with your API key if not shown above.") + "\n",
        );
        process.stderr.write(
          style.dim(
            "Then restart Cursor and check Settings > Tools & MCPs for a green status indicator.",
          ) + "\n",
        );
        process.stderr.write(
          style.dim(
            `Ask Cursor to use your MCP server by its short name. For example: "use the ${shortName} tool to list files in /tmp"`,
          ) + "\n",
        );

        configuredAgents.push({
          platformLabel: selectedLabel,
          agentName,
          shortName,
          proxyUrl,
        });
      }
    }

    // Save local config
    lastConfig = { apiKey, baseUrl, agentName, platform: selectedPlatform };
    try {
      await saveConfig(lastConfig);
      process.stderr.write(style.green("\u2713") + ` Config saved to ${style.cyan(CONFIG_PATH)}\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(style.red(`Failed to save config: ${detail}`) + "\n");
    }

    // Step 6: Connect another?
    const another = await ask("\nConnect another agent? (Y/n) ");
    if (another.trim().toLowerCase() === "n") {
      configuring = false;
    }
  }

  rl.close();

  // Summary
  if (configuredAgents.length > 0) {
    process.stderr.write("\n" + style.bold(style.violet("Setup complete")) + "\n\n");
    for (const agent of configuredAgents) {
      process.stderr.write(
        `  ${style.green("\u2713")} ${agent.platformLabel} - ${style.cyan(agent.agentName)}${agent.proxyUrl != null ? ` ${style.dim(`(${agent.proxyUrl})`)}` : ""}\n`,
      );
    }
    process.stderr.write("\n");
  }

  return lastConfig;
}

function isProxyConfig(value: unknown): value is ProxyConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["apiKey"] === "string" && typeof obj["baseUrl"] === "string";
}
