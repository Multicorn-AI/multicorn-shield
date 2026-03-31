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
const OPENCLAW_MIN_VERSION = "2026.2.26";

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

interface OpenClawDetection {
  readonly status: "not-found" | "parse-error" | "detected";
  readonly version: string | null;
}

async function detectOpenClaw(): Promise<OpenClawDetection> {
  let raw: string;
  try {
    raw = await readFile(OPENCLAW_CONFIG_PATH, "utf8");
  } catch (e) {
    if (isErrnoException(e) && e.code === "ENOENT") {
      return { status: "not-found", version: null };
    }
    throw e;
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { status: "parse-error", version: null };
  }

  const meta = obj["meta"];
  if (typeof meta === "object" && meta !== null) {
    const v = (meta as Record<string, unknown>)["lastTouchedVersion"];
    if (typeof v === "string" && v.length > 0) {
      return { status: "detected", version: v };
    }
  }
  return { status: "detected", version: null };
}

function isVersionAtLeast(version: string, minimum: string): boolean {
  const vParts = version.split(".").map(Number);
  const mParts = minimum.split(".").map(Number);
  const len = Math.max(vParts.length, mParts.length);
  for (let i = 0; i < len; i++) {
    const v = vParts[i] ?? 0;
    const m = mParts[i] ?? 0;
    if (Number.isNaN(v) || Number.isNaN(m)) return false;
    if (v > m) return true;
    if (v < m) return false;
  }
  return true;
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

async function isClaudeDesktopConnected(): Promise<boolean> {
  try {
    const raw = await readFile(getClaudeDesktopConfigPath(), "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const mcpServers = obj["mcpServers"] as Record<string, unknown> | undefined;
    if (mcpServers === undefined || typeof mcpServers !== "object") return false;
    for (const entry of Object.values(mcpServers)) {
      if (typeof entry !== "object" || entry === null) continue;
      const args = (entry as Record<string, unknown>)["args"];
      if (Array.isArray(args) && args.includes("multicorn-proxy")) return true;
    }
    return false;
  } catch {
    return false;
  }
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

  const configuredPlatforms = new Set<number>();
  let lastConfig: ProxyConfig = {
    apiKey,
    baseUrl,
    ...(platform !== undefined ? { platform } : {}),
  };

  let configuring = true;
  while (configuring) {
    // Step B: Platform selection
    process.stderr.write(
      "\n" + style.bold(style.violet("Which platform are you connecting?")) + "\n",
    );
    const platformLabels = ["OpenClaw", "Claude Code", "Claude Desktop", "Other MCP Agent"];
    const openClawConnected = await isOpenClawConnected();
    const claudeCodeConnected = isClaudeCodeConnected();
    const claudeDesktopConnected = await isClaudeDesktopConnected();
    for (let i = 0; i < platformLabels.length; i++) {
      const sessionMarker = configuredPlatforms.has(i + 1) ? " " + style.green("\u2713") : "";
      let connectedMarker = "";
      if (!configuredPlatforms.has(i + 1)) {
        if (i === 0 && openClawConnected) {
          connectedMarker = " " + style.green("\u2713") + style.dim(" connected");
        } else if (i === 1 && claudeCodeConnected) {
          connectedMarker = " " + style.green("\u2713") + style.dim(" connected");
        } else if (i === 2 && claudeDesktopConnected) {
          connectedMarker = " " + style.green("\u2713") + style.dim(" connected");
        }
      }
      process.stderr.write(
        `  ${style.violet(String(i + 1))}. ${platformLabels[i] ?? ""}${sessionMarker}${connectedMarker}\n`,
      );
    }

    let selection = 0;
    while (selection === 0) {
      const input = await ask("Select (1-4): ");
      const num = parseInt(input.trim(), 10);
      if (num >= 1 && num <= 4) {
        selection = num;
      }
    }

    // Step C: Agent name
    let agentName = "";
    while (agentName.length === 0) {
      const input = await ask("\nWhat would you like to call this agent? ");
      if (input.trim().length === 0) continue;
      const transformed = normalizeAgentName(input);
      if (transformed.length === 0) {
        process.stderr.write(
          style.red("Agent name must contain letters or numbers. Please try again.") + "\n",
        );
        continue;
      }
      if (transformed !== input.trim()) {
        process.stderr.write(style.yellow("Agent name set to: ") + style.cyan(transformed) + "\n");
      }
      agentName = transformed;
    }

    // Step D: Platform-specific setup
    if (selection === 1) {
      let detection: OpenClawDetection;
      try {
        detection = await detectOpenClaw();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(style.red("\u2717") + ` Failed to read OpenClaw config: ${detail}\n`);
        rl.close();
        return null;
      }

      if (detection.status === "not-found") {
        process.stderr.write(
          style.red("\u2717") +
            " OpenClaw is not installed. Install OpenClaw first, then run npx multicorn-proxy init again.\n",
        );
        rl.close();
        return null;
      }

      if (detection.status === "parse-error") {
        process.stderr.write(
          style.red("\u2717") +
            " Could not update OpenClaw config. Set MULTICORN_API_KEY in ~/.openclaw/openclaw.json manually.\n",
        );
      }

      if (detection.status === "detected") {
        if (detection.version !== null) {
          process.stderr.write(
            style.green("\u2713") + ` OpenClaw detected ${style.dim(`(${detection.version})`)}\n`,
          );
          if (isVersionAtLeast(detection.version, OPENCLAW_MIN_VERSION)) {
            process.stderr.write(
              style.green("\u2713") + " " + style.green("Version compatible") + "\n",
            );
          } else {
            process.stderr.write(
              style.yellow("\u26A0") +
                ` Shield has been tested with OpenClaw ${style.cyan(OPENCLAW_MIN_VERSION)} and above. Your version (${detection.version}) may work but is untested. We recommend upgrading to at least ${style.cyan(OPENCLAW_MIN_VERSION)}.\n`,
            );
            const answer = await ask("Continue anyway? (y/N) ");
            if (answer.trim().toLowerCase() !== "y") {
              rl.close();
              return null;
            }
          }
        } else {
          process.stderr.write(
            style.yellow("\u26A0") + " Could not detect OpenClaw version. Continuing anyway.\n",
          );
        }

        const spinner = withSpinner("Updating OpenClaw config...");
        try {
          const result = await updateOpenClawConfigIfPresent(apiKey, baseUrl, agentName);
          if (result === "not-found") {
            spinner.stop(false, "OpenClaw config disappeared unexpectedly.");
            rl.close();
            return null;
          }
          if (result === "parse-error") {
            spinner.stop(
              false,
              "Could not update OpenClaw config. Set MULTICORN_API_KEY in ~/.openclaw/openclaw.json manually.",
            );
          } else {
            spinner.stop(
              true,
              "OpenClaw config updated at " + style.cyan("~/.openclaw/openclaw.json"),
            );
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          spinner.stop(false, `Failed to update OpenClaw config: ${detail}`);
        }
      }
    } else if (selection === 2) {
      process.stderr.write("\nTo connect Claude Code to Shield:\n\n");
      process.stderr.write(
        "  " +
          style.bold("Step 1") +
          " - Add the Multicorn marketplace:\n" +
          "    " +
          style.cyan("claude plugin marketplace add Multicorn-AI/multicorn-shield") +
          "\n\n",
      );
      process.stderr.write(
        "  " +
          style.bold("Step 2") +
          " - Install the plugin:\n" +
          "    " +
          style.cyan("claude plugin install multicorn-shield@multicorn-shield") +
          "\n\n",
      );
      process.stderr.write(
        "  " +
          style.bold("Step 3") +
          " - Start Claude Code:\n" +
          "    " +
          style.cyan("claude") +
          "\n\n",
      );
      process.stderr.write(
        style.dim("Run /plugin inside Claude Code to confirm multicorn-shield is installed.") +
          "\n",
      );
      process.stderr.write(
        style.dim("Requires Claude Code to be installed. Get it at https://code.claude.com") + "\n",
      );
    } else if (selection === 3) {
      const mcpCommand = await ask(
        "\nWhat MCP server should Shield govern for this agent?\nThis is the command you'd normally use to start your MCP server.\nExample: npx -y @modelcontextprotocol/server-filesystem /tmp\nLeave blank to skip and configure later: ",
      );

      if (mcpCommand.trim().length === 0) {
        const configPath = getClaudeDesktopConfigPath();
        process.stderr.write("\n" + style.dim("Add this to your Claude Desktop config at:") + "\n");
        process.stderr.write("  " + style.cyan(configPath) + "\n\n");
        const snippet = JSON.stringify(
          {
            mcpServers: {
              [agentName]: {
                command: "npx",
                args: [
                  "multicorn-proxy",
                  "--wrap",
                  "<your-mcp-server-command>",
                  "--agent-name",
                  agentName,
                ],
              },
            },
          },
          null,
          2,
        );
        process.stderr.write(style.cyan(snippet) + "\n\n");
      } else {
        let shouldWrite = true;
        const spinner = withSpinner("Updating Claude Desktop config...");
        try {
          let result = await updateClaudeDesktopConfig(agentName, mcpCommand.trim());
          if (result === "skipped") {
            spinner.stop(false, `Agent "${agentName}" already exists in Claude Desktop config.`);
            const overwrite = await ask("Overwrite the existing entry? (y/N) ");
            if (overwrite.trim().toLowerCase() === "y") {
              const retrySpinner = withSpinner("Updating Claude Desktop config...");
              result = await updateClaudeDesktopConfig(agentName, mcpCommand.trim(), true);
              retrySpinner.stop(
                true,
                "Claude Desktop config updated at " + style.cyan(getClaudeDesktopConfigPath()),
              );
            } else {
              shouldWrite = false;
              process.stderr.write(style.dim("Skipped. Existing config left unchanged.") + "\n");
            }
          } else if (result === "parse-error") {
            spinner.stop(false, "Claude Desktop config file contains invalid JSON.");
            const configPath = getClaudeDesktopConfigPath();
            process.stderr.write(
              style.yellow("\u26A0") +
                " Fix the JSON in " +
                style.cyan(configPath) +
                " or add this entry manually:\n\n",
            );
            const snippet = JSON.stringify(
              {
                mcpServers: {
                  [agentName]: {
                    command: "npx",
                    args: [
                      "multicorn-proxy",
                      "--wrap",
                      ...mcpCommand.trim().split(/\s+/),
                      "--agent-name",
                      agentName,
                    ],
                  },
                },
              },
              null,
              2,
            );
            process.stderr.write(style.cyan(snippet) + "\n\n");
          } else {
            const verb = result === "created" ? "Created" : "Updated";
            spinner.stop(
              true,
              verb + " Claude Desktop config at " + style.cyan(getClaudeDesktopConfigPath()),
            );
            process.stderr.write(style.dim("Restart Claude Desktop to pick up changes.") + "\n");
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          spinner.stop(false, `Failed to update Claude Desktop config: ${detail}`);
          shouldWrite = false;
        }

        void shouldWrite;
      }
    } else {
      process.stderr.write("\n" + style.dim("Start the Shield proxy with:") + "\n");
      process.stderr.write(
        "  " +
          style.cyan(
            `npx multicorn-proxy --wrap <your-mcp-server-command> --agent-name ${agentName}`,
          ) +
          "\n\n",
      );
    }

    configuredPlatforms.add(selection);

    // Step E: Save config
    lastConfig = { apiKey, baseUrl, agentName, ...(platform !== undefined ? { platform } : {}) };
    try {
      await saveConfig(lastConfig);
      process.stderr.write(style.green("\u2713") + ` Config saved to ${style.cyan(CONFIG_PATH)}\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(style.red(`Failed to save config: ${detail}`) + "\n");
    }

    // Step F: Configure another agent
    if (configuredPlatforms.size >= 4) {
      configuring = false;
      continue;
    }

    const another = await ask("\nWould you like to configure another agent? (y/N) ");
    if (another.trim().toLowerCase() !== "y") {
      configuring = false;
    }
  }

  rl.close();

  // Summary
  process.stderr.write("\n" + style.bold(style.violet("Setup complete")) + "\n\n");
  const allPlatforms = ["OpenClaw", "Claude Code", "Claude Desktop", "Other MCP Agent"];
  for (const idx of configuredPlatforms) {
    process.stderr.write(`  ${style.green("\u2713")} ${allPlatforms[idx - 1] ?? ""}\n`);
  }

  // Next steps grouped by platform
  process.stderr.write("\n" + style.bold(style.violet("Next steps")) + "\n");

  const blocks: string[] = [];

  if (configuredPlatforms.has(1)) {
    blocks.push(
      "\n" +
        style.bold("To complete your OpenClaw setup:") +
        "\n" +
        "  \u2192 Restart your gateway: " +
        style.cyan("openclaw gateway restart") +
        "\n" +
        "  \u2192 Start a session: " +
        style.cyan("openclaw tui") +
        "\n",
    );
  }
  if (configuredPlatforms.has(2)) {
    blocks.push(
      "\n" +
        style.bold("To complete your Claude Code setup:") +
        "\n" +
        "  \u2192 Add marketplace: " +
        style.cyan("claude plugin marketplace add Multicorn-AI/multicorn-shield") +
        "\n" +
        "  \u2192 Install plugin: " +
        style.cyan("claude plugin install multicorn-shield@multicorn-shield") +
        "\n",
    );
  }
  if (configuredPlatforms.has(3)) {
    blocks.push(
      "\n" +
        style.bold("To complete your Claude Desktop setup:") +
        "\n" +
        "  \u2192 Restart Claude Desktop to pick up config changes\n",
    );
  }
  if (configuredPlatforms.has(4)) {
    blocks.push(
      "\n" +
        style.bold("To complete your Other MCP Agent setup:") +
        "\n" +
        "  \u2192 Start your agent with: " +
        style.cyan("npx multicorn-proxy --wrap <your-server> --agent-name <name>") +
        "\n",
    );
  }

  process.stderr.write(blocks.join("") + "\n");

  return lastConfig;
}

function isProxyConfig(value: unknown): value is ProxyConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["apiKey"] === "string" && typeof obj["baseUrl"] === "string";
}
