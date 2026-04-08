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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenClawUpdateResult = "updated" | "not-found" | "parse-error";

/** One registered agent in ~/.multicorn/config.json (multi-agent model). */
export interface AgentEntry {
  readonly name: string;
  readonly platform: string;
}

export interface ProxyConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** @deprecated Prefer `agents` + lookup by platform. */
  readonly agentName?: string;
  /** @deprecated Prefer `agents` + lookup by platform. */
  readonly platform?: string;
  readonly agents?: readonly AgentEntry[];
  readonly defaultAgent?: string;
}

export interface ApiKeyValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

export type ClaudeDesktopUpdateResult = "updated" | "created" | "parse-error" | "skipped";

interface ConfiguredAgent {
  readonly platformLabel: string;
  readonly agentName: string;
  readonly shortName?: string;
  readonly proxyUrl?: string;
}

type AskFn = (question: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ANSI_PATTERN = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g");

function stripAnsi(str: string): string {
  return str.replace(ANSI_PATTERN, "");
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

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === "object" && e !== null && "code" in e;
}

function isProxyConfig(value: unknown): value is ProxyConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["apiKey"] === "string" && typeof obj["baseUrl"] === "string";
}

function isAgentEntry(value: unknown): value is AgentEntry {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o["name"] === "string" && typeof o["platform"] === "string";
}

/**
 * Returns the first agent whose platform matches (e.g. "claude-code", "openclaw").
 */
export function getAgentByPlatform(config: ProxyConfig, platform: string): AgentEntry | undefined {
  const list = config.agents;
  if (list === undefined || list.length === 0) return undefined;
  return list.find((a) => a.platform === platform);
}

/**
 * Resolves the default agent: matches `defaultAgent` name, else first entry, else undefined.
 */
export function getDefaultAgent(config: ProxyConfig): AgentEntry | undefined {
  const list = config.agents;
  if (list === undefined || list.length === 0) return undefined;
  const defName = config.defaultAgent;
  if (typeof defName === "string" && defName.length > 0) {
    const match = list.find((a) => a.name === defName);
    if (match !== undefined) return match;
  }
  return list[0];
}

/**
 * Builds a mutable list of agents from config (new `agents` array or legacy fields).
 */
export function collectAgentsFromConfig(cfg: ProxyConfig | null): AgentEntry[] {
  if (cfg === null) return [];
  if (cfg.agents !== undefined && cfg.agents.length > 0) {
    return cfg.agents.map((a) => ({ name: a.name, platform: a.platform }));
  }
  const raw = cfg as unknown as Record<string, unknown>;
  const legacyName = raw["agentName"];
  const legacyPlatform = raw["platform"];
  if (typeof legacyName === "string" && legacyName.length > 0) {
    const plat =
      typeof legacyPlatform === "string" && legacyPlatform.length > 0 ? legacyPlatform : "unknown";
    return [{ name: legacyName, platform: plat }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Config load / save
// ---------------------------------------------------------------------------

/**
 * Loads the proxy config from ~/.multicorn/config.json.
 * Migrates legacy single-agent shape to `agents` + `defaultAgent` on first read and writes back.
 *
 * **Persisted shape:** migration removes top-level `agentName` and `platform` from disk in favor of
 * `agents` + `defaultAgent`. Out-of-repo tools that read the raw JSON must switch to the new fields
 * (breaking change for that contract only; in-repo callers are updated).
 *
 * @returns The parsed config, or null if the file is missing or invalid.
 */
export async function loadConfig(): Promise<ProxyConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isProxyConfig(parsed)) return null;
    const obj = parsed as unknown as Record<string, unknown>;
    const agentNameRaw = obj["agentName"];
    const agentsRaw = obj["agents"];
    const hasNonEmptyAgents =
      Array.isArray(agentsRaw) && agentsRaw.length > 0 && agentsRaw.every((e) => isAgentEntry(e));
    const needsMigrate =
      typeof agentNameRaw === "string" && agentNameRaw.length > 0 && !hasNonEmptyAgents;

    if (!needsMigrate) {
      return parsed;
    }

    const platform =
      typeof obj["platform"] === "string" && obj["platform"].length > 0
        ? obj["platform"]
        : "unknown";
    const next: Record<string, unknown> = { ...obj };
    delete next["agentName"];
    delete next["platform"];
    next["agents"] = [{ name: agentNameRaw, platform }];
    next["defaultAgent"] = agentNameRaw;
    const migrated = next as unknown as ProxyConfig;
    await saveConfig(migrated);
    return migrated;
  } catch {
    return null;
  }
}

/**
 * Removes an agent by name from the config file. Clears `defaultAgent` if it pointed at that name.
 * @returns true if the agent was found and removed.
 */
export async function deleteAgentByName(name: string): Promise<boolean> {
  const config = await loadConfig();
  if (config === null) return false;
  const agents = collectAgentsFromConfig(config);
  const idx = agents.findIndex((a) => a.name === name);
  if (idx === -1) return false;
  const nextAgents = agents.filter((_, i) => i !== idx);
  let defaultAgent = config.defaultAgent;
  if (defaultAgent === name) {
    defaultAgent = undefined;
  }
  const raw = { ...(config as unknown as Record<string, unknown>) };
  if (nextAgents.length > 0) {
    raw["agents"] = nextAgents;
  } else {
    delete raw["agents"];
  }
  if (defaultAgent !== undefined && defaultAgent.length > 0) {
    raw["defaultAgent"] = defaultAgent;
  } else {
    delete raw["defaultAgent"];
  }
  await saveConfig(raw as unknown as ProxyConfig);
  return true;
}

/**
 * Persists the proxy config to ~/.multicorn/config.json with restricted permissions.
 * @param config - The config to save.
 */
export async function saveConfig(config: ProxyConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Mode 0o600: owner read/write only. Prevents other users from reading the API key.
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// OpenClaw config
// ---------------------------------------------------------------------------

/**
 * Updates ~/.openclaw/openclaw.json with Shield credentials if the file exists.
 * @param apiKey - The Shield API key to store.
 * @param baseUrl - The Shield API base URL to store.
 * @param agentName - Optional agent name to register.
 * @returns The outcome of the update attempt.
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

// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

/**
 * Validates an API key against the Shield service.
 * @param apiKey - The API key to validate.
 * @param baseUrl - The Shield API base URL.
 * @returns Validation result indicating whether the key is accepted.
 */
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

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

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

/**
 * Returns the path to the Cursor MCP config file.
 * @returns Absolute path to ~/.cursor/mcp.json.
 */
export function getCursorConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

/**
 * Checks whether a Multicorn proxy entry exists in the Cursor MCP config.
 * @returns True if an existing Multicorn entry was found.
 */
export async function isCursorConnected(): Promise<boolean> {
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
  } catch (err) {
    process.stderr.write(
      `Warning: could not check Cursor connection status: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

/**
 * Returns the platform-specific path to the Claude Desktop config file.
 * @returns Absolute path to claude_desktop_config.json.
 */
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

// ---------------------------------------------------------------------------
// Claude Desktop config
// ---------------------------------------------------------------------------

/**
 * Adds or updates a Multicorn proxy entry in the Claude Desktop config.
 * @param agentName - The agent name to register as an MCP server key.
 * @param mcpServerCommand - The command string the proxy should wrap.
 * @param overwrite - If true, overwrite an existing entry with the same name.
 * @returns The outcome of the update attempt.
 */
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

// detectOpenClaw and isVersionAtLeast were removed in the CLI rewrite (Apr 2026).
// Platform detection is now handled by checking for registered agents via the API.
// Version gating is enforced server-side.

// ---------------------------------------------------------------------------
// Init flow - extracted helpers
// ---------------------------------------------------------------------------

const PLATFORM_LABELS = ["OpenClaw", "Claude Code", "Cursor"];
const PLATFORM_BY_SELECTION: Record<number, string> = {
  1: "openclaw",
  2: "claude-code",
  3: "cursor",
};
const DEFAULT_AGENT_NAMES: Record<string, string> = {
  openclaw: "my-openclaw-agent",
  "claude-code": "my-claude-code-agent",
  cursor: "my-cursor-agent",
};

async function promptPlatformSelection(ask: AskFn): Promise<number> {
  process.stderr.write(
    "\n" + style.bold(style.violet("Which platform are you connecting?")) + "\n",
  );

  const connectedFlags = [
    await isOpenClawConnected(),
    isClaudeCodeConnected(),
    await isCursorConnected(),
  ];

  for (let i = 0; i < PLATFORM_LABELS.length; i++) {
    const marker = connectedFlags[i] ? " " + style.green("\u2713") + style.dim(" connected") : "";
    process.stderr.write(
      `  ${style.violet(String(i + 1))}. ${PLATFORM_LABELS[i] ?? ""}${marker}\n`,
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
  return selection;
}

async function promptAgentName(ask: AskFn, platform: string): Promise<string> {
  const defaultAgentName = DEFAULT_AGENT_NAMES[platform] ?? "my-agent";

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
  return agentName;
}

async function promptProxyConfig(
  ask: AskFn,
  agentName: string,
): Promise<{ targetUrl: string; shortName: string }> {
  let targetUrl = "";
  while (targetUrl.length === 0) {
    process.stderr.write(
      "\n" +
        style.bold("Target MCP server URL:") +
        "\n" +
        style.dim(
          "The URL of the MCP server you want Shield to protect. Example: https://your-server.example.com/mcp",
        ) +
        "\n",
    );
    const input = await ask("URL: ");
    if (input.trim().length === 0) {
      process.stderr.write(style.red("MCP server URL is required.") + "\n");
      continue;
    }
    try {
      new URL(input.trim());
    } catch {
      process.stderr.write(
        style.red(
          "\u2717 That does not look like a valid URL. Please enter a full URL including the scheme (e.g. https://your-server.example.com/mcp).",
        ) + "\n",
      );
      continue;
    }
    targetUrl = input.trim();
  }

  const defaultShortName = normalizeAgentName(agentName) || "shield-mcp";
  const shortNameInput = await ask(
    `\nShort name (a nickname for this connection, used in your proxy URL): ${style.dim(`(${defaultShortName})`)} `,
  );
  const shortName =
    shortNameInput.trim().length > 0
      ? normalizeAgentName(shortNameInput.trim()) || defaultShortName
      : defaultShortName;

  return { targetUrl, shortName };
}

async function createProxyConfig(
  baseUrl: string,
  apiKey: string,
  agentName: string,
  targetUrl: string,
  serverName: string,
  platform: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v1/proxy/config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Multicorn-Key": apiKey,
      },
      body: JSON.stringify({
        server_name: serverName,
        target_url: targetUrl,
        platform,
        agent_name: agentName,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create proxy config: ${detail}`);
  }

  if (!response.ok) {
    let errorMsg = `Shield API returned an error (HTTP ${String(response.status)}). Check your agent name and target URL, then try again.`;
    try {
      const errBody = (await response.json()) as Record<string, unknown>;
      const errObj = errBody["error"] as Record<string, unknown> | undefined;
      if (typeof errObj?.["message"] === "string") {
        errorMsg = stripAnsi(errObj["message"]);
      } else if (typeof errBody["message"] === "string") {
        errorMsg = stripAnsi(errBody["message"]);
      } else if (typeof errBody["detail"] === "string") {
        errorMsg = stripAnsi(errBody["detail"]);
      }
    } catch {
      // response body wasn't JSON
    }
    throw new Error(errorMsg);
  }

  const envelope = (await response.json()) as Record<string, unknown>;
  const data = envelope["data"] as Record<string, unknown> | undefined;
  return typeof data?.["proxy_url"] === "string" ? data["proxy_url"] : "";
}

function printPlatformSnippet(platform: string, routingToken: string, shortName: string): void {
  const mcpSnippet = JSON.stringify(
    {
      mcpServers: {
        [shortName]: {
          url: routingToken,
          headers: {
            Authorization: "Bearer YOUR_SHIELD_API_KEY",
          },
        },
      },
    },
    null,
    2,
  );

  if (platform === "openclaw") {
    process.stderr.write("\n" + style.dim("Add this to your OpenClaw agent config:") + "\n\n");
  } else if (platform === "claude-code") {
    process.stderr.write("\n" + style.dim("Add this to your Claude Code MCP config:") + "\n\n");
  } else {
    process.stderr.write("\n" + style.dim("Add this to ~/.cursor/mcp.json:") + "\n\n");
  }

  process.stderr.write(style.cyan(mcpSnippet) + "\n\n");
  process.stderr.write(
    style.dim(
      "Replace YOUR_SHIELD_API_KEY with your API key. Find it in Settings > API keys at https://app.multicorn.ai/settings/api-keys",
    ) + "\n",
  );

  if (platform === "cursor") {
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
  }
}

function printOpenClawInstructions(): void {
  process.stderr.write("\n" + style.green("\u2713") + " Agent registered!\n");
  process.stderr.write(
    "\nTo connect this agent, add the Multicorn Shield plugin to your OpenClaw agent:\n",
  );
  process.stderr.write("\n  " + style.cyan("openclaw plugins add multicorn-shield") + "\n");
  process.stderr.write(
    "\nThen start your agent. Shield will monitor and protect tool calls automatically.\n",
  );
}

function printClaudeCodeInstructions(): void {
  process.stderr.write("\n" + style.green("\u2713") + " Agent registered!\n");
  process.stderr.write(
    "\nTo connect this agent, install the Multicorn Shield plugin in Claude Code:\n",
  );
  process.stderr.write("\n  " + style.cyan("claude plugins install multicorn-shield") + "\n");
  process.stderr.write(
    "\nThen start a new Claude Code session. Shield will monitor and protect tool calls automatically.\n",
  );
}

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------

/**
 * Runs the interactive init flow: validates an API key, selects a platform,
 * and configures one or more agents.
 * @param baseUrl - The Shield API base URL (defaults to production).
 * @returns The last saved config, or null if the user exited early.
 */
export async function runInit(baseUrl = "https://api.multicorn.ai"): Promise<ProxyConfig | null> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      style.red("Error: interactive terminal required. Cannot run init with piped input.") + "\n",
    );
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask: AskFn = (question) =>
    new Promise((resolve) => {
      rl.question(question, resolve);
    });

  // Banner + header
  process.stderr.write("\n" + BANNER + "\n");
  process.stderr.write(style.dim("Agent governance for the AI era") + "\n\n");
  process.stderr.write(style.bold(style.violet("Multicorn Shield proxy setup")) + "\n\n");
  process.stderr.write(
    style.dim("Get your API key at https://app.multicorn.ai/settings/api-keys") + "\n\n",
  );

  // Load existing config
  const existing = await loadConfig().catch(() => null);

  // Resolve baseUrl: --base-url flag > config file > env var > hardcoded default.
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

  // API key prompt
  let apiKey = "";

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

  // Enforce HTTPS on baseUrl (localhost exception for local dev)
  if (
    !baseUrl.startsWith("https://") &&
    !baseUrl.startsWith("http://localhost") &&
    !baseUrl.startsWith("http://127.0.0.1")
  ) {
    process.stderr.write(
      style.red(`\u2717 Shield API base URL must use HTTPS. Got: ${baseUrl}`) + "\n",
    );
    rl.close();
    return null;
  }

  // Agent configuration loop (append to `agents`, no silent duplicate platforms)
  const configuredAgents: ConfiguredAgent[] = [];
  let currentAgents: AgentEntry[] = collectAgentsFromConfig(existing);
  let lastConfig: ProxyConfig = {
    apiKey,
    baseUrl,
    ...(currentAgents.length > 0
      ? {
          agents: currentAgents,
          defaultAgent:
            existing !== null &&
            typeof existing.defaultAgent === "string" &&
            existing.defaultAgent.length > 0
              ? existing.defaultAgent
              : (currentAgents[currentAgents.length - 1]?.name ?? ""),
        }
      : {}),
  };

  let configuring = true;
  while (configuring) {
    const selection = await promptPlatformSelection(ask);
    const selectedPlatform = PLATFORM_BY_SELECTION[selection] ?? "cursor";
    const selectedLabel = PLATFORM_LABELS[selection - 1] ?? "Cursor";

    const existingForPlatform = currentAgents.find((a) => a.platform === selectedPlatform);
    if (existingForPlatform !== undefined) {
      process.stderr.write(
        `\nAn agent for ${selectedLabel} already exists: ${style.cyan(existingForPlatform.name)}\n`,
      );
      const replace = await ask("Replace it? (Y/n) ");
      if (replace.trim().toLowerCase() === "n") {
        const another = await ask("\nConnect another agent? (Y/n) ");
        if (another.trim().toLowerCase() === "n") {
          configuring = false;
        }
        continue;
      }
    }

    const agentName = await promptAgentName(ask, selectedPlatform);

    let setupSucceeded = false;

    if (selection === 1) {
      printOpenClawInstructions();
      configuredAgents.push({ platformLabel: selectedLabel, agentName });
      setupSucceeded = true;
    } else if (selection === 2) {
      printClaudeCodeInstructions();
      configuredAgents.push({ platformLabel: selectedLabel, agentName });
      setupSucceeded = true;
    } else {
      const { targetUrl, shortName } = await promptProxyConfig(ask, agentName);

      let proxyUrl = "";
      let created = false;
      while (!created) {
        const spinner = withSpinner("Creating proxy config...");
        try {
          proxyUrl = await createProxyConfig(
            baseUrl,
            apiKey,
            agentName,
            targetUrl,
            shortName,
            selectedPlatform,
          );
          spinner.stop(true, "Proxy config created!");
          created = true;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          spinner.stop(false, detail);
          const retry = await ask("Try again? (Y/n) ");
          if (retry.trim().toLowerCase() === "n") {
            break;
          }
        }
      }

      if (created && proxyUrl.length > 0) {
        process.stderr.write("\n" + style.bold("Your Shield proxy URL:") + "\n");
        process.stderr.write("  " + style.cyan(proxyUrl) + "\n");
        printPlatformSnippet(selectedPlatform, proxyUrl, shortName);
        configuredAgents.push({
          platformLabel: selectedLabel,
          agentName,
          shortName,
          proxyUrl,
        });
        setupSucceeded = true;
      }
    }

    if (setupSucceeded) {
      currentAgents = currentAgents.filter((a) => a.platform !== selectedPlatform);
      currentAgents.push({ name: agentName, platform: selectedPlatform });
      const raw =
        existing !== null
          ? { ...(existing as unknown as Record<string, unknown>) }
          : ({} as Record<string, unknown>);
      raw["apiKey"] = apiKey;
      raw["baseUrl"] = baseUrl;
      raw["agents"] = currentAgents;
      raw["defaultAgent"] = agentName;
      delete raw["agentName"];
      delete raw["platform"];
      lastConfig = raw as unknown as ProxyConfig;
      try {
        await saveConfig(lastConfig);
        process.stderr.write(
          style.green("\u2713") + ` Config saved to ${style.cyan(CONFIG_PATH)}\n`,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(style.red(`Failed to save config: ${detail}`) + "\n");
      }
    }

    // Connect another?
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
