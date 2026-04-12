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
  /** Menu index: 1 OpenClaw, 2 Claude Code, 3 Cursor, 4 Windsurf, 5 Local MCP / Other (matches `promptPlatformSelection`). */
  readonly selection: number;
  /** `openclaw`, `claude-code`, `cursor`, `windsurf`, or `other-mcp`. */
  readonly platform: string;
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

type ParseConfigFileResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "missing" }
  | { readonly kind: "readError"; readonly message: string }
  | { readonly kind: "parseError" };

/**
 * Reads {@link CONFIG_PATH} and parses JSON. Single place for file read + parse used by
 * {@link loadConfig} and {@link readBaseUrlFromConfig}.
 */
async function parseConfigFile(): Promise<ParseConfigFileResult> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    try {
      return { kind: "ok", value: JSON.parse(raw) as unknown };
    } catch {
      return { kind: "parseError" };
    }
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { kind: "missing" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "readError", message };
  }
}

/** Whether the URL uses HTTPS or http://localhost / http://127.0.0.1 (local dev). */
export function isAllowedShieldApiBaseUrl(url: string): boolean {
  return (
    url.startsWith("https://") ||
    url.startsWith("http://localhost") ||
    url.startsWith("http://127.0.0.1")
  );
}

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
  const result = await parseConfigFile();
  if (result.kind !== "ok") return null;
  const parsed = result.value;
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
    typeof obj["platform"] === "string" && obj["platform"].length > 0 ? obj["platform"] : "unknown";
  const next: Record<string, unknown> = { ...obj };
  delete next["agentName"];
  delete next["platform"];
  next["agents"] = [{ name: agentNameRaw, platform }];
  next["defaultAgent"] = agentNameRaw;
  const migrated = next as unknown as ProxyConfig;
  await saveConfig(migrated);
  return migrated;
}

/**
 * Reads `baseUrl` from ~/.multicorn/config.json without requiring a full valid {@link ProxyConfig}.
 * Used when {@link loadConfig} returns null (e.g. missing or invalid `apiKey`) but `baseUrl` may still be set.
 *
 * @returns The stored base URL, or `undefined` if the file is missing, unreadable, not JSON, or has no non-empty `baseUrl`.
 */
export async function readBaseUrlFromConfig(): Promise<string | undefined> {
  const result = await parseConfigFile();
  if (result.kind === "missing") return undefined;
  if (result.kind === "readError") {
    process.stderr.write(
      style.yellow(`Warning: could not read base URL from config file: ${result.message}`) + "\n",
    );
    return undefined;
  }
  if (result.kind === "parseError") {
    process.stderr.write(
      style.yellow("Warning: could not parse ~/.multicorn/config.json as JSON.") + "\n",
    );
    return undefined;
  }
  const parsed = result.value;
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const u = (parsed as Record<string, unknown>)["baseUrl"];
  if (typeof u !== "string" || u.length === 0) return undefined;
  return u;
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

const OPENCLAW_MIN_VERSION = "2026.2.26";

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
 * Returns the path to the Windsurf MCP config file.
 * @returns Absolute path to ~/.codeium/windsurf/mcp_config.json.
 */
export function getWindsurfConfigPath(): string {
  return join(homedir(), ".codeium", "windsurf", "mcp_config.json");
}

/**
 * Checks whether a Multicorn proxy entry exists in the Windsurf MCP config.
 * @returns True if an existing Multicorn entry was found.
 */
export async function isWindsurfConnected(): Promise<boolean> {
  try {
    const raw = await readFile(getWindsurfConfigPath(), "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const mcpServers = obj["mcpServers"] as Record<string, unknown> | undefined;
    if (mcpServers === undefined || typeof mcpServers !== "object") return false;
    for (const entry of Object.values(mcpServers)) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const url = rec["serverUrl"];
      if (typeof url === "string" && url.includes("multicorn")) return true;
    }
    return false;
  } catch {
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

// ---------------------------------------------------------------------------
// Init flow - extracted helpers
// ---------------------------------------------------------------------------

const PLATFORM_LABELS = ["OpenClaw", "Claude Code", "Cursor", "Windsurf", "Local MCP / Other"];
const PLATFORM_BY_SELECTION: Record<number, string> = {
  1: "openclaw",
  2: "claude-code",
  3: "cursor",
  4: "windsurf",
  5: "other-mcp",
};
const DEFAULT_AGENT_NAMES: Record<string, string> = {
  openclaw: "my-openclaw-agent",
  "claude-code": "my-claude-code-agent",
  cursor: "my-cursor-agent",
  windsurf: "my-windsurf-agent",
};

async function promptPlatformSelection(ask: AskFn): Promise<number> {
  process.stderr.write(
    "\n" + style.bold(style.violet("Which platform are you connecting?")) + "\n",
  );

  const connectedFlags = [
    await isOpenClawConnected(),
    isClaudeCodeConnected(),
    await isCursorConnected(),
    await isWindsurfConnected(),
  ];

  for (let i = 0; i < PLATFORM_LABELS.length; i++) {
    // Last option (Local MCP / Other) has no detection logic, so skip the marker.
    const marker =
      i < connectedFlags.length && connectedFlags[i]
        ? " " + style.dim("\u25CF detected locally")
        : "";
    process.stderr.write(
      `  ${style.violet(String(i + 1))}. ${PLATFORM_LABELS[i] ?? ""}${marker}\n`,
    );
  }
  process.stderr.write(
    style.dim("     Pick 5 if you want to wrap a local MCP server with multicorn-proxy --wrap.") +
      "\n",
  );

  let selection = 0;
  while (selection === 0) {
    const input = await ask("Select (1-5): ");
    const num = parseInt(input.trim(), 10);
    if (num >= 1 && num <= 5) {
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

function printPlatformSnippet(
  platform: string,
  routingToken: string,
  shortName: string,
  apiKey: string,
): void {
  const usesInlineKey = platform === "cursor" || platform === "windsurf";
  const authHeader = usesInlineKey ? `Bearer ${apiKey}` : "Bearer YOUR_SHIELD_API_KEY";

  const urlKey = platform === "windsurf" ? "serverUrl" : "url";
  const mcpSnippet = JSON.stringify(
    {
      mcpServers: {
        [shortName]: {
          [urlKey]: routingToken,
          headers: {
            Authorization: authHeader,
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
  } else if (platform === "windsurf") {
    process.stderr.write(
      "\n" + style.dim("Add this to ~/.codeium/windsurf/mcp_config.json:") + "\n\n",
    );
  } else {
    process.stderr.write("\n" + style.dim("Add this to ~/.cursor/mcp.json:") + "\n\n");
  }

  process.stderr.write(style.cyan(mcpSnippet) + "\n\n");
  if (!usesInlineKey) {
    process.stderr.write(
      style.dim(
        "Replace YOUR_SHIELD_API_KEY with your API key. Find it in Settings > API keys at https://app.multicorn.ai/settings#api-keys",
      ) + "\n",
    );
  }

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

  if (platform === "windsurf") {
    process.stderr.write(style.dim("Then restart Windsurf (Cmd/Ctrl+Q, then reopen).") + "\n");
    process.stderr.write(
      style.dim(
        "Open the Cascade panel and verify the server appears with a green status indicator.",
      ) + "\n",
    );
  }
}

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------

export const DEFAULT_SHIELD_API_BASE_URL = "https://api.multicorn.ai";

/**
 * Runs the interactive init flow: validates an API key, selects a platform,
 * and configures one or more agents.
 * @param explicitBaseUrl - Optional Shield API base URL from `--base-url`. When omitted, resolution uses
 *   full config, then partial config file, then `MULTICORN_BASE_URL`, then the production default.
 * @returns The last saved config, or null if the user exited early.
 */
export async function runInit(explicitBaseUrl?: string): Promise<ProxyConfig | null> {
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
    style.dim("Get your API key at https://app.multicorn.ai/settings#api-keys") + "\n\n",
  );

  // Load existing config
  const existing = await loadConfig().catch(() => null);

  // Resolve baseUrl: explicit CLI arg > full config > partial config file > env var > hardcoded default.
  let resolvedBaseUrl: string;
  if (explicitBaseUrl !== undefined && explicitBaseUrl.trim().length > 0) {
    resolvedBaseUrl = explicitBaseUrl.trim();
  } else if (existing !== null && existing.baseUrl.length > 0) {
    resolvedBaseUrl = existing.baseUrl;
  } else {
    const fromFile = await readBaseUrlFromConfig();
    if (fromFile !== undefined && fromFile.length > 0) {
      resolvedBaseUrl = fromFile;
    } else {
      const envBaseUrl = process.env["MULTICORN_BASE_URL"];
      resolvedBaseUrl =
        envBaseUrl !== undefined && envBaseUrl.trim().length > 0
          ? envBaseUrl.trim()
          : DEFAULT_SHIELD_API_BASE_URL;
    }
  }

  if (!isAllowedShieldApiBaseUrl(resolvedBaseUrl)) {
    process.stderr.write(
      style.red(
        "Base URL must use HTTPS (or http://localhost for local development). Received a non-HTTPS URL from config. Use --base-url to override.",
      ) + "\n",
    );
    rl.close();
    return null;
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
      result = await validateApiKey(key, resolvedBaseUrl);
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

  // Agent configuration loop (append to `agents`, no silent duplicate platforms)
  const configuredAgents: ConfiguredAgent[] = [];
  let currentAgents: AgentEntry[] = collectAgentsFromConfig(existing);
  let lastConfig: ProxyConfig = {
    apiKey,
    baseUrl: resolvedBaseUrl,
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

    // Option 5: Local MCP / Other - minimal config, no agent name, no target URL.
    if (selection === 5) {
      const raw =
        existing !== null
          ? { ...(existing as unknown as Record<string, unknown>) }
          : ({} as Record<string, unknown>);
      raw["apiKey"] = apiKey;
      raw["baseUrl"] = resolvedBaseUrl;
      delete raw["agentName"];
      delete raw["platform"];
      lastConfig = raw as unknown as ProxyConfig;
      try {
        await saveConfig(lastConfig);
        process.stderr.write(
          style.green("\u2713") + ` Config saved to ${style.cyan(CONFIG_PATH)}\n`,
        );
        process.stderr.write(
          "\n" +
            style.bold("Try it:") +
            " " +
            style.cyan(
              "npx multicorn-proxy --wrap npx @modelcontextprotocol/server-filesystem /tmp",
            ) +
            "\n",
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(style.red(`Failed to save config: ${detail}`) + "\n");
      }
      configuredAgents.push({
        selection,
        platform: selectedPlatform,
        platformLabel: selectedLabel,
        agentName: "",
      });
      const another = await ask("\nConnect another agent? (Y/n) ");
      if (another.trim().toLowerCase() === "n") {
        configuring = false;
      }
      continue;
    }

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
          const result = await updateOpenClawConfigIfPresent(apiKey, resolvedBaseUrl, agentName);
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
      configuredAgents.push({
        selection,
        platform: selectedPlatform,
        platformLabel: selectedLabel,
        agentName,
      });
      setupSucceeded = true;
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
        style.dim("Requires Claude Code to be installed. Get it at https://code.claude.com") + "\n",
      );
      configuredAgents.push({
        selection,
        platform: selectedPlatform,
        platformLabel: selectedLabel,
        agentName,
      });
      setupSucceeded = true;
    } else {
      const { targetUrl, shortName } = await promptProxyConfig(ask, agentName);

      let proxyUrl = "";
      let created = false;
      while (!created) {
        const spinner = withSpinner("Creating proxy config...");
        try {
          proxyUrl = await createProxyConfig(
            resolvedBaseUrl,
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
        printPlatformSnippet(selectedPlatform, proxyUrl, shortName, apiKey);
        configuredAgents.push({
          selection,
          platform: selectedPlatform,
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
      raw["baseUrl"] = resolvedBaseUrl;
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
      const namePart = agent.agentName.length > 0 ? ` - ${style.cyan(agent.agentName)}` : "";
      const urlPart = agent.proxyUrl != null ? ` ${style.dim(`(${agent.proxyUrl})`)}` : "";
      process.stderr.write(
        `  ${style.green("\u2713")} ${agent.platformLabel}${namePart}${urlPart}\n`,
      );
    }
    process.stderr.write("\n");

    const configuredPlatforms = new Set(configuredAgents.map((a) => a.platform));

    // Next steps grouped by platform.
    // No block for other-mcp: the option 4 branch already prints a "Try it"
    // message with the correct --wrap command inside the configuring loop.
    const blocks: string[] = [];

    if (configuredPlatforms.has("openclaw")) {
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
    if (configuredPlatforms.has("claude-code")) {
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
    if (configuredPlatforms.has("claude-desktop")) {
      blocks.push(
        "\n" +
          style.bold("To complete your Claude Desktop setup:") +
          "\n" +
          "  \u2192 Restart Claude Desktop to pick up config changes\n",
      );
    }
    if (configuredPlatforms.has("cursor")) {
      blocks.push(
        "\n" +
          style.bold("To complete your Cursor setup:") +
          "\n" +
          "  \u2192 Restart Cursor to pick up MCP config changes\n",
      );
    }
    if (configuredPlatforms.has("windsurf")) {
      blocks.push(
        "\n" +
          style.bold("To complete your Windsurf setup:") +
          "\n" +
          "  Config file: " +
          style.cyan("~/.codeium/windsurf/mcp_config.json") +
          "\n" +
          "  Restart Windsurf to load the new MCP server.\n",
      );
    }

    if (blocks.length > 0) {
      process.stderr.write("\n" + style.bold(style.violet("Next steps")) + "\n");
      process.stderr.write(blocks.join("") + "\n");
    }
  }

  return lastConfig;
}
