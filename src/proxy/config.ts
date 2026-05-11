/**
 * Config management for the MCP proxy.
 *
 * Reads and writes `~/.multicorn/config.json`. The interactive `init` command
 * prompts for an API key, validates it against the service, then saves it.
 *
 * @module proxy/config
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

import { fetchRemoteAgentsSummaries, deriveDashboardUrl } from "./consent.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Options for JSON files we write that may hold API keys or tokens. */
const SECRET_JSON_FILE_OPTIONS = { encoding: "utf8" as const, mode: 0o600 };

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

// ---------------------------------------------------------------------------
// Native plugin prerequisites (CLI hooks install)
// ---------------------------------------------------------------------------

/** Thrown when native hook install is skipped because the host app is not installed yet. */
export class NativePluginPrerequisiteMissingError extends Error {
  constructor() {
    super("Native plugin prerequisites not met");
    this.name = "NativePluginPrerequisiteMissingError";
  }
}

function isExistingDirectory(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function jsonValueMentionsMulticornShield(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("multicorn-shield");
  }
  if (Array.isArray(value)) {
    return value.some(jsonValueMentionsMulticornShield);
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.includes("multicorn-shield")) return true;
      if (jsonValueMentionsMulticornShield(v)) return true;
    }
  }
  return false;
}

/** True when ~/.claude/plugins/installed_plugins.json lists the Shield plugin. */
function claudeInstalledPluginsListsMulticornShield(): boolean {
  const path = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return jsonValueMentionsMulticornShield(parsed);
  } catch {
    return false;
  }
}

function nativePluginSkippedSaveNote(wizardCommand: string, productName: string): string {
  return (
    "\n" +
    style.dim("Your agent config has been saved. Run ") +
    style.cyan(wizardCommand) +
    style.dim(` again after installing ${productName} to complete hook setup.`) +
    "\n"
  );
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
  /** Directory where `init` was run; used to pick the right agent when multiple share a platform. */
  readonly workspacePath?: string;
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
  /** Menu index: 1..INIT_WIZARD_SELECTION_MAX (matches `promptPlatformSelection`). */
  readonly selection: number;
  /** Agent platform slug sent to the Shield API (e.g. `cursor`, `github-copilot`). */
  readonly platform: string;
  readonly platformLabel: string;
  readonly agentName: string;
  /** Set when `platform` is `windsurf` to drive Next steps copy. */
  readonly windsurfIntegration?: "native" | "hosted";
  /** Set when `platform` is `cline` to drive Next steps copy. */
  readonly clineIntegration?: "native" | "hosted";
  /** Set when `platform` is `gemini-cli` to drive Next steps copy. */
  readonly geminiCliIntegration?: "native" | "hosted";
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

/** Known `Authorization` scheme prefixes forwarded unchanged when followed by credential data. */
const UPSTREAM_AUTH_KNOWN_SCHEME_WITH_PAYLOAD = /^(Bearer|Basic|Token|ApiKey)(\s+)(.+)$/is;

/**
 * Builds the upstream MCP `Authorization` header value from init/dashboard input.
 *
 * - Empty or whitespace-only input returns `undefined` (omit header).
 * - If the trimmed value starts with Bearer, Basic, Token, or ApiKey, followed by
 *   whitespace and a non-empty credential payload, it is forwarded unchanged (only
 *   outer whitespace is trimmed). Use this for Token, Basic, ApiKey schemes or when
 *   pasting a full `Bearer <token>` value.
 * - A trimmed value that is only one of those scheme keywords (with no credential)
 *   returns `undefined`.
 * - Any other trimmed value gets `Bearer ` prepended (common token-only paste).
 */
export function formatUpstreamAuthorizationBearerHeader(raw: string): string | undefined {
  const t = raw.trim();
  if (t.length === 0) return undefined;
  if (UPSTREAM_AUTH_KNOWN_SCHEME_WITH_PAYLOAD.test(t)) {
    return t;
  }
  if (/^(Bearer|Basic|Token|ApiKey)$/i.test(t)) {
    return undefined;
  }
  return `Bearer ${t}`;
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
  if (typeof o["name"] !== "string" || typeof o["platform"] !== "string") return false;
  if (o["workspacePath"] !== undefined && typeof o["workspacePath"] !== "string") return false;
  return true;
}

/**
 * True when `cwdResolved` (already `resolve()`d by the caller) equals `workspacePath` resolved,
 * or lies under it as a subdirectory. `workspacePath` is normalized here.
 */
export function cwdUnderWorkspacePath(cwdResolved: string, workspacePath: string): boolean {
  const w = resolve(workspacePath);
  if (cwdResolved === w) return true;
  const prefix = w.endsWith(sep) ? w : w + sep;
  return cwdResolved.startsWith(prefix);
}

/**
 * Returns an agent for the platform. When `cwd` is set, prefers entries whose `workspacePath`
 * contains the current working directory (longest match wins). Falls back to the first platform match
 * when no `workspacePath` fits (backwards compatible).
 */
export function getAgentByPlatform(
  config: ProxyConfig,
  platform: string,
  cwd?: string,
): AgentEntry | undefined {
  const list = config.agents;
  if (list === undefined || list.length === 0) return undefined;
  const matches = list.filter((a) => a.platform === platform);
  if (matches.length === 0) return undefined;
  if (cwd === undefined || cwd.length === 0) return matches[0];

  const resolvedCwd = resolve(cwd);
  const withPath = matches.filter(
    (a) => typeof a.workspacePath === "string" && a.workspacePath.length > 0,
  );
  if (withPath.length === 0) return matches[0];

  let best: AgentEntry | undefined;
  let bestLen = -1;
  for (const a of withPath) {
    const ws = a.workspacePath;
    if (typeof ws !== "string" || ws.length === 0) continue;
    if (!cwdUnderWorkspacePath(resolvedCwd, ws)) continue;
    const len = resolve(ws).length;
    if (len > bestLen) {
      bestLen = len;
      best = a;
    }
  }
  if (best !== undefined) return best;
  return matches[0];
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
    return cfg.agents.map((a) => {
      const e: AgentEntry = { name: a.name, platform: a.platform };
      if (typeof a.workspacePath === "string" && a.workspacePath.length > 0) {
        return { ...e, workspacePath: a.workspacePath };
      }
      return e;
    });
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

  await writeFile(
    OPENCLAW_CONFIG_PATH,
    JSON.stringify(obj, null, 2) + "\n",
    SECRET_JSON_FILE_OPTIONS,
  );
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
// Windsurf Cascade Hooks (native plugin)
// ---------------------------------------------------------------------------

function multicornShieldPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Prefer npm package root via `require.resolve` when running from `node_modules`. */
function multicornShieldInstallRoot(): string {
  try {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve("multicorn-shield/package.json"));
  } catch {
    return multicornShieldPackageRoot();
  }
}

function shieldInstalledVersionOlderThan(latest: string, installed: string): boolean {
  return latest.localeCompare(installed, undefined, { numeric: true }) > 0;
}

async function warnIfInstalledShieldIsOutdated(): Promise<void> {
  try {
    const res = await fetch("https://registry.npmjs.org/multicorn-shield/latest");
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    const latest = typeof data.version === "string" ? data.version : "";
    if (latest.length === 0) return;
    let installed = "";
    try {
      const req = createRequire(import.meta.url);
      const pkgPath = req.resolve("multicorn-shield/package.json");
      const raw = readFileSync(pkgPath, "utf8");
      const pkg = JSON.parse(raw) as { version?: string };
      installed = typeof pkg.version === "string" ? pkg.version : "";
    } catch {
      return;
    }
    if (installed.length === 0 || !shieldInstalledVersionOlderThan(latest, installed)) {
      return;
    }
    process.stderr.write(
      style.yellow("\u26A0") +
        ` multicorn-shield v${installed} is installed but v${latest} is available. Run npm update multicorn-shield to update.\n\n`,
    );
  } catch {
    /* skip */
  }
}

/** Installed copy of hook scripts (written by `init`, referenced from hooks.json). */
export function getWindsurfHooksInstallDir(): string {
  return join(homedir(), ".multicorn", "windsurf-hooks");
}

/** User-level Windsurf hooks file (merged by `init`). */
export function getWindsurfCascadeHooksJsonPath(): string {
  return join(homedir(), ".codeium", "windsurf", "hooks.json");
}

interface WindsurfHookEntry {
  command: string;
  powershell?: string;
  show_output?: boolean;
}

function isShieldWindsurfHookCommand(cmd: string): boolean {
  return (
    cmd.includes("windsurf-hooks/pre-action.cjs") ||
    cmd.includes("windsurf-hooks\\pre-action.cjs") ||
    cmd.includes("windsurf-hooks/post-action.cjs") ||
    cmd.includes("windsurf-hooks\\post-action.cjs")
  );
}

function filterOutShieldWindsurfHooks(entries: unknown): WindsurfHookEntry[] {
  if (!Array.isArray(entries)) return [];
  const out: WindsurfHookEntry[] = [];
  for (const e of entries) {
    if (typeof e !== "object" || e === null) continue;
    const rec = e as Record<string, unknown>;
    const cmd = rec["command"];
    if (typeof cmd !== "string" || isShieldWindsurfHookCommand(cmd)) continue;
    const powershell = rec["powershell"];
    const show_output = rec["show_output"];
    out.push({
      command: cmd,
      ...(typeof powershell === "string" ? { powershell } : {}),
      ...(show_output === true ? { show_output: true } : {}),
    });
  }
  return out;
}

export async function installWindsurfNativeHooks(): Promise<void> {
  const root = multicornShieldPackageRoot();
  const srcPre = join(root, "plugins", "windsurf", "hooks", "scripts", "pre-action.cjs");
  const srcPost = join(root, "plugins", "windsurf", "hooks", "scripts", "post-action.cjs");
  if (!existsSync(srcPre) || !existsSync(srcPost)) {
    throw new Error(
      `Could not find Shield Windsurf hook scripts at ${srcPre}. If you use npm, install the latest multicorn-shield package.`,
    );
  }
  const windsurfConfigDir = join(homedir(), ".codeium", "windsurf");
  if (!isExistingDirectory(windsurfConfigDir)) {
    process.stderr.write(
      style.yellow("\u26A0") +
        "  Windsurf does not appear to be installed (~/.codeium/windsurf/ not found).\n\n",
    );
    process.stderr.write(
      "Open Windsurf at least once so this folder exists, or install from:\n" +
        "  " +
        style.cyan("https://windsurf.com/download") +
        "\n\n",
    );
    process.stderr.write("Then run this wizard again:\n");
    process.stderr.write("  " + style.cyan("npx multicorn-shield init") + "\n");
    throw new NativePluginPrerequisiteMissingError();
  }
  const installDir = getWindsurfHooksInstallDir();
  await mkdir(installDir, { recursive: true });
  const destPre = join(installDir, "pre-action.cjs");
  const destPost = join(installDir, "post-action.cjs");
  await copyFile(srcPre, destPre);
  await copyFile(srcPost, destPost);

  const preCmd = `node ${JSON.stringify(destPre)}`;
  const postCmd = `node ${JSON.stringify(destPost)}`;
  const preEntry: WindsurfHookEntry = { command: preCmd, powershell: preCmd, show_output: true };
  const postEntry: WindsurfHookEntry = { command: postCmd, powershell: postCmd };

  const hooksPath = getWindsurfCascadeHooksJsonPath();
  let base: Record<string, unknown> = { hooks: {} };
  try {
    const raw = await readFile(hooksPath, "utf8");
    base = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "ENOENT") {
      throw err;
    }
  }
  const hooks = (base["hooks"] as Record<string, unknown> | undefined) ?? {};
  const preKeys = [
    "pre_read_code",
    "pre_write_code",
    "pre_run_command",
    "pre_mcp_tool_use",
  ] as const;
  const postKeys = [
    "post_read_code",
    "post_write_code",
    "post_run_command",
    "post_mcp_tool_use",
  ] as const;
  const nextHooks: Record<string, unknown> = { ...hooks };
  for (const k of preKeys) {
    const merged = filterOutShieldWindsurfHooks(nextHooks[k]);
    nextHooks[k] = [...merged, preEntry];
  }
  for (const k of postKeys) {
    const merged = filterOutShieldWindsurfHooks(nextHooks[k]);
    nextHooks[k] = [...merged, postEntry];
  }
  base["hooks"] = nextHooks;
  const hooksDir = dirname(hooksPath);
  await mkdir(hooksDir, { recursive: true });
  await writeFile(hooksPath, JSON.stringify(base, null, 2) + "\n", SECRET_JSON_FILE_OPTIONS);
}

// ---------------------------------------------------------------------------
// Cline Hooks (native plugin)
// ---------------------------------------------------------------------------

/** Installed copy of Cline hook scripts (written by `init`). */
export function getClineHooksInstallDir(): string {
  return join(homedir(), ".multicorn", "cline-hooks");
}

/** Global Cline hooks directory. */
export function getClineGlobalHooksDir(): string {
  return join(homedir(), "Documents", "Cline", "Hooks");
}

export async function installClineNativeHooks(): Promise<void> {
  const root = multicornShieldPackageRoot();
  const srcPre = join(root, "plugins", "cline", "hooks", "scripts", "pre-tool-use.cjs");
  const srcPost = join(root, "plugins", "cline", "hooks", "scripts", "post-tool-use.cjs");
  const srcShared = join(root, "plugins", "cline", "hooks", "scripts", "shared.cjs");
  if (!existsSync(srcPre) || !existsSync(srcPost) || !existsSync(srcShared)) {
    throw new Error(
      `Could not find Shield Cline hook scripts at ${srcPre}. If you use npm, install the latest multicorn-shield package.`,
    );
  }

  const clineDocsDir = join(homedir(), "Documents", "Cline");
  if (!isExistingDirectory(clineDocsDir)) {
    process.stderr.write(
      style.yellow("\u26A0") +
        "  Cline does not appear to be installed (~/Documents/Cline/ not found).\n\n",
    );
    process.stderr.write("Install the Cline VS Code extension first. See:\n");
    process.stderr.write(
      "  " + style.cyan("https://docs.cline.bot/getting-started/installing-cline") + "\n\n",
    );
    process.stderr.write("Then run this wizard again:\n");
    process.stderr.write("  " + style.cyan("npx multicorn-shield init") + "\n");
    throw new NativePluginPrerequisiteMissingError();
  }

  // Copy scripts to ~/.multicorn/cline-hooks/
  const installDir = getClineHooksInstallDir();
  await mkdir(installDir, { recursive: true });
  const destPre = join(installDir, "pre-tool-use.cjs");
  const destPost = join(installDir, "post-tool-use.cjs");
  const destShared = join(installDir, "shared.cjs");
  await copyFile(srcPre, destPre);
  await copyFile(srcPost, destPost);
  await copyFile(srcShared, destShared);
  const hookScriptMode = 0o755;
  await chmod(destPre, hookScriptMode);
  await chmod(destPost, hookScriptMode);
  await chmod(destShared, hookScriptMode);

  // Install wrapper scripts to ~/Documents/Cline/Hooks/
  const hooksDir = getClineGlobalHooksDir();
  await mkdir(hooksDir, { recursive: true });

  const preWrapper = join(hooksDir, "PreToolUse");
  const postWrapper = join(hooksDir, "PostToolUse");

  const preContent = `#!/usr/bin/env node\nrequire(${JSON.stringify(destPre)});\n`;
  const postContent = `#!/usr/bin/env node\nrequire(${JSON.stringify(destPost)});\n`;

  await writeFile(preWrapper, preContent, { encoding: "utf8", mode: 0o755 });
  await writeFile(postWrapper, postContent, { encoding: "utf8", mode: 0o755 });
}

async function promptClineIntegrationMode(ask: AskFn): Promise<"native" | "hosted"> {
  process.stderr.write("\n" + style.bold("Cline integration") + "\n");
  process.stderr.write(
    "  " +
      style.violet("1") +
      ". Native plugin (recommended) - Cline Hooks see every file, terminal, browser, and MCP action\n",
  );
  process.stderr.write(
    "  " +
      style.violet("2") +
      ". Hosted proxy - govern MCP traffic only (paste proxy URL into Cline MCP settings)\n",
  );
  let choice = 0;
  while (choice === 0) {
    const input = await ask("Choose integration (1-2): ");
    const num = parseInt(input.trim(), 10);
    if (num === 1) choice = 1;
    if (num === 2) choice = 2;
  }
  return choice === 1 ? "native" : "hosted";
}

export function getGeminiCliHooksInstallDir(): string {
  return join(homedir(), ".multicorn", "gemini-cli-hooks");
}

function getGeminiCliSettingsPath(): string {
  return join(homedir(), ".gemini", "settings.json");
}

/**
 * Merges hosted Shield MCP proxy config into ~/.gemini/settings.json (preserves hooks and other keys).
 */
async function mergeGeminiHostedMcpServersIntoSettings(
  shortName: string,
  proxyUrl: string,
  apiKey: string,
): Promise<void> {
  const settingsPath = getGeminiCliSettingsPath();
  let existing: Record<string, unknown> = {};
  try {
    const rawText = await readFile(settingsPath, "utf8");
    const parsed: unknown = JSON.parse(rawText);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      existing = {};
    } else {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read or parse Gemini CLI settings at ${settingsPath}: ${detail}`);
    }
  }

  const mcpRaw = existing["mcpServers"];
  const mcpServers: Record<string, unknown> =
    typeof mcpRaw === "object" && mcpRaw !== null && !Array.isArray(mcpRaw)
      ? { ...(mcpRaw as Record<string, unknown>) }
      : {};

  mcpServers[shortName] = {
    httpUrl: proxyUrl,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };

  const out = { ...existing, mcpServers };
  await mkdir(dirname(settingsPath), { recursive: true });
  const serialized = JSON.stringify(out, null, 2) + "\n";
  await writeFile(settingsPath, serialized, SECRET_JSON_FILE_OPTIONS);

  writeMcpAddedLine(shortName, settingsPath);
}

function geminiInnerHooksReferenceShield(inner: unknown, multicornName: string): boolean {
  if (!Array.isArray(inner)) return false;
  for (const h of inner) {
    if (typeof h !== "object" || h === null) continue;
    const rec = h as Record<string, unknown>;
    if (rec["name"] === multicornName) return true;
    const cmd = rec["command"];
    if (typeof cmd === "string" && cmd.includes("gemini-cli-hooks")) return true;
  }
  return false;
}

function geminiHookEventsReferenceShield(arr: unknown): boolean {
  if (!Array.isArray(arr)) return false;
  for (const entry of arr) {
    if (typeof entry !== "object" || entry === null) continue;
    const hooks = (entry as Record<string, unknown>)["hooks"];
    if (
      geminiInnerHooksReferenceShield(hooks, "multicorn-shield") ||
      geminiInnerHooksReferenceShield(hooks, "multicorn-shield-log")
    ) {
      return true;
    }
  }
  return false;
}

function geminiSettingsHasMulticornHooks(hooks: unknown): boolean {
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const h = hooks as Record<string, unknown>;
  return (
    geminiHookEventsReferenceShield(h["BeforeTool"]) ||
    geminiHookEventsReferenceShield(h["AfterTool"])
  );
}

function geminiFilterInnerHooks(inner: unknown): unknown[] {
  if (!Array.isArray(inner)) return [];
  return inner.filter((h) => {
    if (typeof h !== "object" || h === null) return true;
    const rec = h as Record<string, unknown>;
    if (rec["name"] === "multicorn-shield" || rec["name"] === "multicorn-shield-log") return false;
    const cmd = rec["command"];
    if (typeof cmd === "string" && cmd.includes("gemini-cli-hooks")) return false;
    return true;
  });
}

function geminiStripMatcherGroups(arr: unknown): unknown[] {
  if (!Array.isArray(arr)) return [];
  const out: unknown[] = [];
  for (const entry of arr) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const filtered = geminiFilterInnerHooks(e["hooks"]);
    if (filtered.length > 0) {
      out.push({ ...e, hooks: filtered });
    }
  }
  return out;
}

function geminiStripMulticornHookEntries(hooks: Record<string, unknown>): Record<string, unknown> {
  const out = { ...hooks };
  out["BeforeTool"] = geminiStripMatcherGroups(out["BeforeTool"]);
  out["AfterTool"] = geminiStripMatcherGroups(out["AfterTool"]);
  return out;
}

function getClaudeCodeUserSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function commandLooksLikeMulticornClaudePre(cmd: unknown): boolean {
  return (
    typeof cmd === "string" && cmd.includes("pre-tool-use.cjs") && cmd.includes("multicorn-shield")
  );
}

function commandLooksLikeMulticornClaudePost(cmd: unknown): boolean {
  return (
    typeof cmd === "string" && cmd.includes("post-tool-use.cjs") && cmd.includes("multicorn-shield")
  );
}

function claudeSettingsMatcherGroupReferencesShield(
  group: Record<string, unknown>,
  kind: "pre" | "post",
): boolean {
  const inner = group["hooks"];
  if (!Array.isArray(inner)) return false;
  const pred =
    kind === "pre" ? commandLooksLikeMulticornClaudePre : commandLooksLikeMulticornClaudePost;
  for (const h of inner) {
    if (typeof h !== "object" || h === null) continue;
    const rec = h as Record<string, unknown>;
    if (pred(rec["command"])) return true;
  }
  return false;
}

function claudeHooksHaveShieldEntries(hooks: Record<string, unknown>): boolean {
  for (const key of ["PreToolUse", "PostToolUse"] as const) {
    const arr = hooks[key];
    if (!Array.isArray(arr)) continue;
    const kind = key === "PreToolUse" ? ("pre" as const) : ("post" as const);
    for (const g of arr) {
      if (typeof g === "object" && g !== null) {
        if (claudeSettingsMatcherGroupReferencesShield(g as Record<string, unknown>, kind)) {
          return true;
        }
      }
    }
  }
  return false;
}

function stripClaudeShieldHookGroups(arr: unknown[], kind: "pre" | "post"): unknown[] {
  return arr.filter((g) => {
    if (typeof g !== "object" || g === null) return true;
    return !claudeSettingsMatcherGroupReferencesShield(g as Record<string, unknown>, kind);
  });
}

async function installClaudeCodeUserSettingsHooks(ask: AskFn): Promise<boolean> {
  const root = multicornShieldInstallRoot();
  const prePath = join(root, "plugins", "multicorn-shield", "hooks", "scripts", "pre-tool-use.cjs");
  const postPath = join(
    root,
    "plugins",
    "multicorn-shield",
    "hooks",
    "scripts",
    "post-tool-use.cjs",
  );
  if (!existsSync(prePath) || !existsSync(postPath)) {
    process.stderr.write(
      style.red(
        "Could not find Shield Claude Code hook scripts next to the multicorn-shield package.\n",
      ),
    );
    process.stderr.write(style.dim(`  Expected: ${prePath}`) + "\n");
    return false;
  }

  const settingsPath = getClaudeCodeUserSettingsPath();
  await mkdir(dirname(settingsPath), { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const rawText = await readFile(settingsPath, "utf8");
    const parsed: unknown = JSON.parse(rawText);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      existing = {};
    } else {
      process.stderr.write(
        style.yellow("\u26A0") +
          ` Could not parse ${settingsPath}. Fix or remove the file, then run init again.\n`,
      );
      return false;
    }
  }

  const hooksRaw = existing["hooks"];
  const hooksObj: Record<string, unknown> =
    typeof hooksRaw === "object" && hooksRaw !== null && !Array.isArray(hooksRaw)
      ? { ...(hooksRaw as Record<string, unknown>) }
      : {};

  if (claudeHooksHaveShieldEntries(hooksObj)) {
    const answer = await ask(
      "Existing Multicorn Shield hooks were found in ~/.claude/settings.json. Overwrite? (Y/n) ",
    );
    if (answer.trim().toLowerCase() === "n") {
      return false;
    }
  }

  const preCmd = `node ${JSON.stringify(prePath)}`;
  const postCmd = `node ${JSON.stringify(postPath)}`;

  const preArr = stripClaudeShieldHookGroups(
    Array.isArray(hooksObj["PreToolUse"]) ? [...(hooksObj["PreToolUse"] as unknown[])] : [],
    "pre",
  );
  const postArr = stripClaudeShieldHookGroups(
    Array.isArray(hooksObj["PostToolUse"]) ? [...(hooksObj["PostToolUse"] as unknown[])] : [],
    "post",
  );

  preArr.push({
    matcher: "*",
    hooks: [
      {
        type: "command",
        name: "multicorn-shield-pre",
        command: preCmd,
        timeout: 600,
      },
    ],
  });
  postArr.push({
    matcher: "*",
    hooks: [
      {
        type: "command",
        name: "multicorn-shield-post",
        command: postCmd,
        timeout: 120,
      },
    ],
  });

  hooksObj["PreToolUse"] = preArr;
  hooksObj["PostToolUse"] = postArr;

  const out = { ...existing, hooks: hooksObj };
  const serialized = JSON.stringify(out, null, 2) + "\n";
  await writeFile(settingsPath, serialized, SECRET_JSON_FILE_OPTIONS);

  process.stderr.write(
    "\n" + style.dim("Wrote ") + style.cyan(settingsPath) + style.dim(":") + "\n",
  );
  process.stderr.write(style.dim(JSON.stringify({ hooks: hooksObj }, null, 2)) + "\n");

  return true;
}

export async function installGeminiCliNativeHooks(ask: AskFn): Promise<void> {
  const root = multicornShieldPackageRoot();
  const srcBefore = join(root, "plugins", "gemini-cli", "hooks", "scripts", "before-tool.cjs");
  const srcAfter = join(root, "plugins", "gemini-cli", "hooks", "scripts", "after-tool.cjs");
  const srcShared = join(root, "plugins", "gemini-cli", "hooks", "scripts", "shared.cjs");
  if (!existsSync(srcBefore) || !existsSync(srcAfter) || !existsSync(srcShared)) {
    throw new Error(
      `Could not find Shield Gemini CLI hook scripts at ${srcBefore}. If you use npm, install the latest multicorn-shield package.`,
    );
  }

  const geminiConfigDir = join(homedir(), ".gemini");
  if (!isExistingDirectory(geminiConfigDir)) {
    process.stderr.write(
      style.yellow("\u26A0") +
        "  Gemini CLI does not appear to be installed (~/.gemini/ not found).\n\n",
    );
    process.stderr.write("Install Gemini CLI first:\n");
    process.stderr.write("  " + style.cyan("npm install -g @google/gemini-cli") + "\n\n");
    process.stderr.write("Then run this wizard again:\n");
    process.stderr.write("  " + style.cyan("npx multicorn-shield init") + "\n");
    throw new NativePluginPrerequisiteMissingError();
  }

  const installDir = getGeminiCliHooksInstallDir();
  await mkdir(installDir, { recursive: true });
  const destBefore = join(installDir, "before-tool.cjs");
  const destAfter = join(installDir, "after-tool.cjs");
  const destShared = join(installDir, "shared.cjs");
  await copyFile(srcBefore, destBefore);
  await copyFile(srcAfter, destAfter);
  await copyFile(srcShared, destShared);
  const mode = 0o755;
  await chmod(destBefore, mode);
  await chmod(destAfter, mode);
  await chmod(destShared, mode);

  const settingsPath = getGeminiCliSettingsPath();
  let existing: Record<string, unknown> = {};
  try {
    const rawText = await readFile(settingsPath, "utf8");
    const parsed: unknown = JSON.parse(rawText);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      existing = {};
    } else {
      process.stderr.write(
        style.yellow("\u26A0") +
          ` Could not parse ${settingsPath}. Create valid JSON or remove the file, then run init again.\n`,
      );
      throw new Error(`Invalid Gemini CLI settings at ${settingsPath}`);
    }
  }

  const hooksRaw = existing["hooks"];
  const hooksObj =
    typeof hooksRaw === "object" && hooksRaw !== null && !Array.isArray(hooksRaw)
      ? (hooksRaw as Record<string, unknown>)
      : {};

  if (geminiSettingsHasMulticornHooks(hooksObj)) {
    const answer = await ask(
      "Existing Multicorn Shield hooks were found in ~/.gemini/settings.json. Overwrite? (Y/n) ",
    );
    if (answer.trim().toLowerCase() === "n") {
      throw new Error("Installation cancelled: existing Shield hooks left unchanged.");
    }
  }

  const cleaned = geminiStripMulticornHookEntries({ ...hooksObj });
  const beforeArr = Array.isArray(cleaned["BeforeTool"])
    ? [...(cleaned["BeforeTool"] as unknown[])]
    : [];
  const afterArr = Array.isArray(cleaned["AfterTool"])
    ? [...(cleaned["AfterTool"] as unknown[])]
    : [];

  const beforeCmd = `node ${destBefore}`;
  const afterCmd = `node ${destAfter}`;

  beforeArr.push({
    matcher: ".*",
    hooks: [
      {
        type: "command",
        name: "multicorn-shield",
        command: beforeCmd,
        timeout: 60000,
      },
    ],
  });
  afterArr.push({
    matcher: ".*",
    hooks: [
      {
        type: "command",
        name: "multicorn-shield-log",
        command: afterCmd,
        timeout: 10000,
      },
    ],
  });

  existing["hooks"] = {
    ...cleaned,
    BeforeTool: beforeArr,
    AfterTool: afterArr,
  };

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(existing, null, 2) + "\n", SECRET_JSON_FILE_OPTIONS);
}

async function promptGeminiCliIntegrationMode(ask: AskFn): Promise<"native" | "hosted"> {
  process.stderr.write("\n" + style.bold("Gemini CLI integration") + "\n");
  process.stderr.write(
    "  " +
      style.violet("1") +
      ". Native plugin (recommended) - Gemini CLI Hooks see every file, terminal, web, and MCP action\n",
  );
  process.stderr.write(
    "  " +
      style.violet("2") +
      ". Hosted proxy - govern MCP traffic only (paste proxy URL into Gemini CLI settings)\n",
  );
  let choice = 0;
  while (choice === 0) {
    const input = await ask("Choose integration (1-2): ");
    const num = parseInt(input.trim(), 10);
    if (num === 1) choice = 1;
    if (num === 2) choice = 2;
  }
  return choice === 1 ? "native" : "hosted";
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

/** Cursor MCP config (`mcpServers` object). */
export function getCursorMcpJsonPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

/** Windsurf MCP config (`mcpServers` with `serverUrl`). */
export function getWindsurfMcpConfigPath(): string {
  return join(homedir(), ".codeium", "windsurf", "mcp_config.json");
}

/** Cline MCP settings (VS Code globalStorage). */
export function getClineMcpSettingsPath(): string {
  switch (process.platform) {
    case "win32":
      return join(
        process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"),
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      );
    case "linux":
      return join(
        homedir(),
        ".config",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      );
    default:
      return join(
        homedir(),
        "Library",
        "Application Support",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      );
  }
}

/** Continue `config.json` in the home directory (when used). */
export function getContinueConfigJsonPath(): string {
  return join(homedir(), ".continue", "config.json");
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
    args: ["multicorn-shield", "--wrap", ...commandParts, "--agent-name", agentName],
  };

  const configDir = join(configPath, "..");
  if (!fileExists) {
    await mkdir(configDir, { recursive: true });
  }
  await writeFile(configPath, JSON.stringify(obj, null, 2) + "\n", SECRET_JSON_FILE_OPTIONS);
  return fileExists ? "updated" : "created";
}

// ---------------------------------------------------------------------------
// Init flow - extracted helpers
// ---------------------------------------------------------------------------

export type InitWizardPlatformSection = "native" | "hosted";

/** Single source of truth for `npx multicorn-shield init` platform menu and prereqs. */
export interface InitWizardPlatformEntry {
  readonly slug: string;
  readonly displayName: string;
  readonly section: InitWizardPlatformSection;
  /** Install doc URL; omit when no prereq step before the agent name prompt. */
  readonly prereqUrl?: string;
}

export const INIT_WIZARD_PLATFORM_REGISTRY: readonly InitWizardPlatformEntry[] = [
  { slug: "openclaw", displayName: "OpenClaw", section: "native" },
  { slug: "claude-code", displayName: "Claude Code", section: "native" },
  { slug: "windsurf", displayName: "Windsurf", section: "native" },
  { slug: "cline", displayName: "Cline", section: "native" },
  { slug: "gemini-cli", displayName: "Gemini CLI", section: "native" },
  {
    slug: "cursor",
    displayName: "Cursor",
    section: "hosted",
    prereqUrl: "https://www.cursor.com/downloads",
  },
  {
    slug: "claude-desktop",
    displayName: "Claude Desktop",
    section: "hosted",
    prereqUrl: "https://claude.ai/download",
  },
  {
    slug: "github-copilot",
    displayName: "GitHub Copilot",
    section: "hosted",
    prereqUrl: "https://docs.github.com/en/copilot/get-started",
  },
  {
    slug: "kilo-code",
    displayName: "Kilo Code",
    section: "hosted",
    prereqUrl: "https://kilocode.ai/docs/getting-started",
  },
  {
    slug: "continue-dev",
    displayName: "Continue",
    section: "hosted",
    prereqUrl: "https://docs.continue.dev/ide-extensions/install",
  },
  {
    slug: "goose",
    displayName: "Goose",
    section: "hosted",
    prereqUrl: "https://goose-docs.ai/docs/quickstart/",
  },
  { slug: "other-mcp", displayName: "Local MCP / Other", section: "hosted" },
];

const INIT_WIZARD_MENU_SECTIONS: readonly {
  readonly title: string;
  readonly items: readonly { readonly platform: string; readonly label: string }[];
}[] = (() => {
  const itemsFor = (
    section: InitWizardPlatformSection,
  ): readonly { readonly platform: string; readonly label: string }[] =>
    INIT_WIZARD_PLATFORM_REGISTRY.filter((e) => e.section === section).map((e) => ({
      platform: e.slug,
      label: e.displayName,
    }));
  return [
    { title: "Recommended (native plugin)", items: itemsFor("native") },
    { title: "Hosted proxy (MCP only)", items: itemsFor("hosted") },
  ];
})();

const INIT_WIZARD_SELECTION_MAX: number = INIT_WIZARD_PLATFORM_REGISTRY.length;

const PLATFORM_BY_SELECTION: Record<number, string> = Object.fromEntries(
  INIT_WIZARD_PLATFORM_REGISTRY.map((e, i) => [i + 1, e.slug]),
) as Record<number, string>;

/** 1-based menu index for tests and tooling (matches `promptPlatformSelection`). */
export function initWizardSelectionNumberForSlug(slug: string): number {
  const i = INIT_WIZARD_PLATFORM_REGISTRY.findIndex((e) => e.slug === slug);
  if (i === -1) {
    throw new Error(`Unknown init wizard platform slug: ${slug}`);
  }
  return i + 1;
}

function platformMenuLabelForSelection(sel: number): string {
  const slug = PLATFORM_BY_SELECTION[sel];
  if (slug === undefined) return "Unknown";
  const entry = INIT_WIZARD_PLATFORM_REGISTRY.find((e) => e.slug === slug);
  return entry?.displayName ?? slug;
}

async function promptHostedProxyInstallPrereq(
  ask: AskFn,
  platformLabel: string,
  prereqUrl: string,
): Promise<boolean> {
  process.stderr.write("\n");
  process.stderr.write(
    style.bold("Before continuing, make sure you have ") +
      platformLabel +
      style.bold(" installed.") +
      "\n",
  );
  process.stderr.write("  → " + style.cyan(prereqUrl) + "\n\n");
  const answer = await ask("Ready to continue? (Y/n) ");
  return answer.trim().toLowerCase() !== "n";
}

async function promptPlatformSelection(ask: AskFn): Promise<number> {
  process.stderr.write(
    "\n" + style.bold(style.violet("Which platform are you connecting?")) + "\n\n",
  );

  let optionNum = 1;
  for (const section of INIT_WIZARD_MENU_SECTIONS) {
    process.stderr.write("  " + style.dim(section.title) + "\n");
    for (const item of section.items) {
      const indent = optionNum >= 10 ? "   " : "    ";
      process.stderr.write(`${indent}${style.violet(String(optionNum))}. ${item.label}\n`);
      optionNum++;
    }
  }

  process.stderr.write(
    "\n" +
      style.dim(
        `  Pick ${String(INIT_WIZARD_SELECTION_MAX)} to wrap a local MCP server with multicorn-shield --wrap.`,
      ) +
      "\n",
  );

  let selection = 0;
  while (selection === 0) {
    const input = await ask(`Select (1-${String(INIT_WIZARD_SELECTION_MAX)}): `);
    const num = parseInt(input.trim(), 10);
    if (num >= 1 && num <= INIT_WIZARD_SELECTION_MAX) {
      selection = num;
    }
  }
  return selection;
}

async function promptWindsurfIntegrationMode(ask: AskFn): Promise<"native" | "hosted"> {
  process.stderr.write("\n" + style.bold("Windsurf integration") + "\n");
  process.stderr.write(
    "  " +
      style.violet("1") +
      ". Native plugin (recommended) - Cascade Hooks see every file, terminal, and MCP action\n",
  );
  process.stderr.write(
    "  " +
      style.violet("2") +
      ". Hosted proxy - govern MCP traffic only (paste proxy URL into mcp_config)\n",
  );
  let choice = 0;
  while (choice === 0) {
    const input = await ask("Choose integration (1-2): ");
    const num = parseInt(input.trim(), 10);
    if (num === 1) choice = 1;
    if (num === 2) choice = 2;
  }
  return choice === 1 ? "native" : "hosted";
}

/**
 * Arrow-key single-select prompt rendered to stderr. Returns the 0-based index of the selected option.
 * Falls back to a numbered text prompt when stdin is not a TTY (piped input / tests).
 */
async function arrowSelect(
  options: readonly string[],
  ask: AskFn,
  fallbackLabel?: string,
): Promise<number> {
  if (options.length === 1) {
    const only = options[0] ?? "";
    process.stderr.write(`${style.violet("❯")} ${style.cyan(only)}\n`);
    return 0;
  }

  const canRaw = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  if (!canRaw) {
    for (let i = 0; i < options.length; i++) {
      const optLine = options.at(i) ?? "";
      process.stderr.write(`  ${style.violet(String(i + 1))}. ${optLine}\n`);
    }
    const label = fallbackLabel ?? "Choose";
    let sel = -1;
    while (sel < 0) {
      const input = await ask(`${label} (1-${String(options.length)}): `);
      const n = parseInt(input.trim(), 10);
      if (n >= 1 && n <= options.length) sel = n - 1;
    }
    return sel;
  }

  let idx = 0;

  function render(): void {
    for (let i = 0; i < options.length; i++) {
      const opt = options.at(i);
      if (opt === undefined) continue;
      const prefix = i === idx ? style.violet("❯") : " ";
      const label = i === idx ? style.cyan(opt) : opt;
      process.stderr.write(`${prefix} ${label}\n`);
    }
  }

  function clearLines(): void {
    for (let n = options.length; n > 0; n -= 1) {
      process.stderr.write("\x1b[1A\x1b[2K");
    }
  }

  process.stderr.write("\n");
  render();

  return new Promise<number>((resolvePromise) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    function onData(buf: Buffer): void {
      const s = buf.toString("utf8");
      if (s === "\x1b[A" || s === "k") {
        idx = (idx - 1 + options.length) % options.length;
        clearLines();
        render();
      } else if (s === "\x1b[B" || s === "j") {
        idx = (idx + 1) % options.length;
        clearLines();
        render();
      } else if (s === "\r" || s === "\n") {
        cleanup();
        clearLines();
        const chosen = options.at(idx);
        if (chosen !== undefined && options.length > 1) {
          process.stderr.write(`${style.violet("❯")} ${style.cyan(chosen)}\n`);
        }
        resolvePromise(idx);
      } else if (s === "\x03") {
        cleanup();
        process.exit(130);
      }
    }

    function cleanup(): void {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(wasRaw);
    }

    process.stdin.on("data", onData);
  });
}

async function promptAgentName(
  ask: AskFn,
  platform: string,
  defaultNameOverride?: string,
): Promise<string> {
  /** `platform` is the API slug (e.g. cursor, github-copilot), not a human label. */
  const dirPart = normalizeAgentName(basename(process.cwd()));
  const computedDefault =
    dirPart.length > 0
      ? normalizeAgentName(`${dirPart}-${platform}`) || platform
      : normalizeAgentName(platform) || platform;
  const fromOverride =
    defaultNameOverride !== undefined && defaultNameOverride.trim().length > 0
      ? normalizeAgentName(defaultNameOverride.trim())
      : "";
  const defaultAgentName = fromOverride.length > 0 ? fromOverride : computedDefault;

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
): Promise<{ targetUrl: string; shortName: string; upstreamHeaders?: Record<string, string> }> {
  let targetUrl = "";
  while (targetUrl.length === 0) {
    process.stderr.write(
      "\n" +
        style.bold("Target MCP server URL:") +
        "\n" +
        style.dim(
          "This is the URL of the MCP server you want Shield to control. Common examples:",
        ) +
        "\n" +
        style.dim("  GitHub:     https://api.githubcopilot.com/mcp/") +
        "\n" +
        style.dim("  Supabase:   https://mcp.supabase.com/sse") +
        "\n" +
        style.dim("  Atlassian:  https://mcp.atlassian.com/v1/sse") +
        "\n" +
        style.dim("  Stripe:     https://mcp.stripe.com/v1/sse") +
        "\n" +
        style.dim("Check your MCP server's documentation for the correct URL.") +
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

  const shortName = normalizeAgentName(agentName) || "shield-mcp";

  process.stderr.write(
    "\n" +
      style.bold("Does this MCP server require authentication?") +
      "\n" +
      style.dim(
        "Most MCP servers need a token or API key. Check the server's docs for how to get one:",
      ) +
      "\n" +
      style.dim("  GitHub:     Settings > Developer Settings > Personal Access Tokens") +
      "\n" +
      style.dim(
        "  Supabase:   Project Settings > API > anon or scoped key (service role bypasses RLS; avoid for most MCP)",
      ) +
      "\n" +
      style.dim("  Atlassian:  id.atlassian.com > API Tokens") +
      "\n" +
      style.dim("  Stripe:     Dashboard > Developers > API Keys") +
      "\n",
  );
  const authReply = await ask("(y/N): ");
  const authNorm = authReply.trim().toLowerCase();
  const wantsAuth = authNorm === "y" || authNorm === "yes";
  let upstreamHeaders: Record<string, string> | undefined;
  if (wantsAuth) {
    process.stderr.write(
      "\n" +
        style.bold("Enter your API token or full Authorization header value.") +
        "\n" +
        style.dim("  Bearer tokens: ghp_xxxxxxxxxxxx (Bearer is added automatically)") +
        "\n" +
        style.dim("  Other schemes:  Basic dXNlcjpwYXNz (passed as-is)") +
        "\n",
    );
    const headerVal = await ask("Value: ");
    const authHeader = formatUpstreamAuthorizationBearerHeader(headerVal);
    if (authHeader !== undefined) {
      upstreamHeaders = { Authorization: authHeader };
    }
  }

  return {
    targetUrl,
    shortName,
    ...(upstreamHeaders !== undefined ? { upstreamHeaders } : {}),
  };
}

async function createProxyConfig(
  baseUrl: string,
  apiKey: string,
  _agentName: string,
  targetUrl: string,
  serverName: string,
  platform: string,
  upstreamHeaders?: Record<string, string>,
): Promise<string> {
  let response: Response;
  const body: Record<string, unknown> = {
    server_name: serverName,
    target_url: targetUrl,
    platform,
    agent_name: serverName,
  };
  if (upstreamHeaders !== undefined && Object.keys(upstreamHeaders).length > 0) {
    body["upstream_headers"] = upstreamHeaders;
  }
  try {
    response = await fetch(`${baseUrl}/api/v1/proxy/config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Multicorn-Key": apiKey,
      },
      body: JSON.stringify(body),
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

/**
 * Platforms where we embed the API key in the proxy URL (Cursor, Claude Desktop, Copilot, etc. omit static headers).
 * Windsurf, Cline, and Gemini CLI are headers-only; they send Authorization reliably.
 */
const HOSTED_PROXY_PLATFORMS_WITH_URL_KEY = new Set([
  "cursor",
  "claude-desktop",
  "github-copilot",
  "kilo-code",
  "continue-dev",
  "goose",
]);

export function shouldEmbedKeyInHostedProxyUrl(platform: string): boolean {
  return HOSTED_PROXY_PLATFORMS_WITH_URL_KEY.has(platform);
}

/**
 * Appends `key=<apiKey>` to the hosted proxy URL for clients that omit `Authorization`.
 * Logs a warning and returns the original URL when parsing fails or the key is empty.
 */
export function hostedProxyUrlWithKeyParam(proxyUrl: string, apiKey: string): string {
  if (apiKey.length === 0) {
    process.stderr.write(
      style.yellow("\u26A0") +
        " Could not add key to proxy URL: API key is empty; using URL without key query parameter.\n",
    );
    return proxyUrl;
  }
  try {
    const u = new URL(proxyUrl);
    u.searchParams.set("key", apiKey);
    return u.toString();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      style.yellow("\u26A0") +
        " Could not parse proxy URL to append key query parameter; using URL unchanged. " +
        style.dim(detail) +
        "\n",
    );
    return proxyUrl;
  }
}

/**
 * Hosted proxy URL line for stderr: key-in-URL platforms show a redacted key (`mcs_...` + last 4 chars only).
 * Other platforms show the base URL (no query key).
 */
export function formatHostedProxyUrlForStderr(
  platform: string,
  proxyUrl: string,
  apiKey: string,
): string {
  if (!shouldEmbedKeyInHostedProxyUrl(platform) || apiKey.length === 0) {
    return proxyUrl;
  }
  try {
    const u = new URL(proxyUrl);
    const redactedLabel = apiKey.length <= 4 ? "****" : `mcs_...${apiKey.slice(-4)}`;
    u.searchParams.set("key", redactedLabel);
    return u.toString();
  } catch {
    return proxyUrl;
  }
}

function writeMcpAddedLine(shortName: string, filePath: string): void {
  process.stderr.write(
    style.green("\u2713") +
      ' MCP server "' +
      shortName +
      '" added to ' +
      style.cyan(filePath) +
      "\n",
  );
}

/**
 * Merge `{ mcpServers: { [shortName]: entry } }` into a JSON object root file.
 */
async function mergeMcpServersObjectStyle(
  filePath: string,
  shortName: string,
  entry: Record<string, unknown>,
): Promise<"ok" | "parse-error"> {
  let root: Record<string, unknown> = {};
  try {
    const raw = await readFile(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return "parse-error";
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    } else {
      return "parse-error";
    }
  } catch (e) {
    if (isErrnoException(e) && e.code === "ENOENT") {
      root = {};
    } else {
      throw e;
    }
  }

  const mcpRaw = root["mcpServers"];
  const mcpServers: Record<string, unknown> =
    typeof mcpRaw === "object" && mcpRaw !== null && !Array.isArray(mcpRaw)
      ? { ...(mcpRaw as Record<string, unknown>) }
      : {};

  mcpServers[shortName] = entry;
  root["mcpServers"] = mcpServers;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(root, null, 2) + "\n", SECRET_JSON_FILE_OPTIONS);
  writeMcpAddedLine(shortName, filePath);
  return "ok";
}

/**
 * Claude Desktop hosted proxy: `mcp-remote` bridge (no url+headers in desktop config).
 */
async function mergeClaudeDesktopHostedMcpRemote(
  shortName: string,
  proxyUrl: string,
  apiKey: string,
): Promise<"ok" | "parse-error"> {
  const entry: Record<string, unknown> = {
    command: "npx",
    args: ["-y", "mcp-remote", proxyUrl, "--header", `Authorization: Bearer ${apiKey}`],
  };
  return mergeMcpServersObjectStyle(getClaudeDesktopConfigPath(), shortName, entry);
}

/**
 * Continue: `.continue/mcpServers/<name>.yaml` in the workspace root.
 */
async function mergeContinueHostedMcp(
  workspacePath: string,
  shortName: string,
  proxyUrl: string,
  apiKey: string,
): Promise<"ok" | "parse-error"> {
  const dir = join(workspacePath, ".continue", "mcpServers");
  const filePath = join(dir, `${shortName}.yaml`);
  const yaml =
    `name: ${shortName}\n` +
    `version: 0.0.1\n` +
    `schema: v1\n` +
    `mcpServers:\n` +
    `  - name: ${shortName}\n` +
    `    type: streamable-http\n` +
    `    url: ${proxyUrl}\n` +
    `    headers:\n` +
    `      Authorization: Bearer ${apiKey}\n`;

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, yaml, SECRET_JSON_FILE_OPTIONS);
  writeMcpAddedLine(shortName, filePath);
  return "ok";
}

/**
 * GitHub Copilot: `.vscode/mcp.json` uses `servers` (not `mcpServers`) as the top-level key.
 */
async function mergeCopilotVscodeMcp(
  workspacePath: string,
  shortName: string,
  proxyUrl: string,
  apiKey: string,
): Promise<"ok" | "parse-error"> {
  const filePath = join(workspacePath, ".vscode", "mcp.json");
  let root: Record<string, unknown> = {};
  try {
    const raw = await readFile(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return "parse-error";
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    } else {
      return "parse-error";
    }
  } catch (e) {
    if (isErrnoException(e) && e.code === "ENOENT") {
      root = {};
    } else {
      throw e;
    }
  }

  const serversRaw = root["servers"];
  const servers: Record<string, unknown> =
    typeof serversRaw === "object" && serversRaw !== null && !Array.isArray(serversRaw)
      ? { ...(serversRaw as Record<string, unknown>) }
      : {};

  if (servers[shortName] !== undefined) {
    return "ok";
  }

  servers[shortName] = {
    type: "http",
    url: proxyUrl,
    headers: { Authorization: `Bearer ${apiKey}` },
  };
  root["servers"] = servers;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(root, null, 2) + "\n", SECRET_JSON_FILE_OPTIONS);
  writeMcpAddedLine(shortName, filePath);
  return "ok";
}

async function mergeKiloCodeProjectMcp(
  workspacePath: string,
  shortName: string,
  proxyUrl: string,
  apiKey: string,
): Promise<"ok" | "parse-error"> {
  const filePath = join(workspacePath, ".kilo", "kilo.jsonc");
  let root: Record<string, unknown> = {};
  try {
    const raw = await readFile(filePath, "utf8");
    const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return "parse-error";
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    } else {
      return "parse-error";
    }
  } catch (e) {
    if (isErrnoException(e) && e.code === "ENOENT") {
      root = {};
    } else {
      throw e;
    }
  }

  const mcpRaw = root["mcp"];
  const mcp: Record<string, unknown> =
    typeof mcpRaw === "object" && mcpRaw !== null && !Array.isArray(mcpRaw)
      ? { ...(mcpRaw as Record<string, unknown>) }
      : {};

  if (mcp[shortName] !== undefined) {
    return "ok";
  }

  mcp[shortName] = {
    type: "remote",
    url: proxyUrl,
    headers: { Authorization: `Bearer ${apiKey}` },
    enabled: true,
  };
  root["mcp"] = mcp;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(root, null, 2) + "\n", SECRET_JSON_FILE_OPTIONS);
  writeMcpAddedLine(shortName, filePath);
  return "ok";
}

function printHostedProxyJsonParseWarning(filePath: string): void {
  process.stderr.write(
    style.yellow("\u26A0") +
      " Could not parse JSON at " +
      style.cyan(filePath) +
      style.dim(" - showing paste snippet instead.") +
      "\n",
  );
}

/** After a successful MCP file write, print restart / verification hints (no snippet). */
function printHostedProxyPostWriteHints(platform: string, shortName: string): void {
  if (platform === "cursor") {
    process.stderr.write(
      style.dim("Restart Cursor and check Settings > Tools & MCPs for a green status indicator. ") +
        style.dim(`Ask Cursor to use your MCP server by its short name (e.g. ${shortName}).`) +
        "\n",
    );
  }
  if (platform === "claude-desktop") {
    process.stderr.write(style.dim("Restart Claude Desktop to load the MCP server.") + "\n");
  }
  if (platform === "cline") {
    process.stderr.write(
      style.dim(
        "Restart Cline or reload the VS Code window. Cline will discover the Shield tools automatically.",
      ) + "\n",
    );
  }
  if (platform === "windsurf") {
    process.stderr.write(style.dim("Restart Windsurf (Cmd/Ctrl+Q, then reopen).") + "\n");
    process.stderr.write(
      style.dim(
        "Open the Cascade panel and verify the server appears with a green status indicator.",
      ) + "\n",
    );
  }
  if (platform === "github-copilot" || platform === "continue-dev") {
    process.stderr.write(
      style.dim("Reload the editor window if the MCP server does not appear immediately.") + "\n",
    );
  }
  if (platform === "goose") {
    process.stderr.write(style.dim("Start a new Goose session after updating config.") + "\n");
  }
  if (platform === "kilo-code") {
    process.stderr.write(
      style.dim("Restart Kilo Code or reload the window so it picks up .kilocode/mcp.json.") + "\n",
    );
  }
}

/**
 * Writes hosted MCP config to the platform file when possible; otherwise prints the snippet.
 */
async function applyHostedProxyMcpConfig(
  platform: string,
  proxyUrl: string,
  shortName: string,
  apiKey: string,
  workspacePath: string,
): Promise<void> {
  const authHeader = `Bearer ${apiKey}`;
  const proxyUrlWithKeyWhenNeeded = shouldEmbedKeyInHostedProxyUrl(platform)
    ? hostedProxyUrlWithKeyParam(proxyUrl, apiKey)
    : proxyUrl;

  if (platform === "gemini-cli") {
    await mergeGeminiHostedMcpServersIntoSettings(shortName, proxyUrlWithKeyWhenNeeded, apiKey);
    process.stderr.write(
      style.dim(
        "For project-specific config, copy the mcpServers entry into .gemini/settings.json in your project root. Restart Gemini CLI if it is already running.",
      ) + "\n",
    );
    return;
  }

  if (platform === "github-copilot") {
    try {
      const result = await mergeCopilotVscodeMcp(
        workspacePath,
        shortName,
        proxyUrlWithKeyWhenNeeded,
        apiKey,
      );
      if (result === "ok") {
        printHostedProxyPostWriteHints(platform, shortName);
        return;
      }
      printHostedProxyJsonParseWarning(join(workspacePath, ".vscode", "mcp.json"));
    } catch {
      // fall through to snippet
    }
    printPlatformSnippet(platform, proxyUrl, shortName, apiKey);
    return;
  }

  if (platform === "goose") {
    try {
      const result = await mergeGooseConfig(shortName, proxyUrlWithKeyWhenNeeded, apiKey);
      if (result === "ok") {
        printHostedProxyPostWriteHints(platform, shortName);
        return;
      }
    } catch {
      // fall through to snippet
    }
    printPlatformSnippet(platform, proxyUrl, shortName, apiKey);
    return;
  }

  try {
    let result: "ok" | "parse-error" = "parse-error";
    if (platform === "cursor") {
      result = await mergeMcpServersObjectStyle(getCursorMcpJsonPath(), shortName, {
        url: proxyUrlWithKeyWhenNeeded,
        headers: { Authorization: authHeader },
      });
      if (result === "parse-error") {
        printHostedProxyJsonParseWarning(getCursorMcpJsonPath());
      }
    } else if (platform === "claude-desktop") {
      result = await mergeClaudeDesktopHostedMcpRemote(
        shortName,
        proxyUrlWithKeyWhenNeeded,
        apiKey,
      );
      if (result === "parse-error") {
        printHostedProxyJsonParseWarning(getClaudeDesktopConfigPath());
      }
    } else if (platform === "windsurf") {
      result = await mergeMcpServersObjectStyle(getWindsurfMcpConfigPath(), shortName, {
        serverUrl: proxyUrlWithKeyWhenNeeded,
        headers: { Authorization: authHeader },
      });
      if (result === "parse-error") {
        printHostedProxyJsonParseWarning(getWindsurfMcpConfigPath());
      }
    } else if (platform === "cline") {
      result = await mergeMcpServersObjectStyle(getClineMcpSettingsPath(), shortName, {
        url: proxyUrlWithKeyWhenNeeded,
        headers: { Authorization: authHeader },
      });
      if (result === "parse-error") {
        printHostedProxyJsonParseWarning(getClineMcpSettingsPath());
      }
    } else if (platform === "kilo-code") {
      result = await mergeKiloCodeProjectMcp(
        workspacePath,
        shortName,
        proxyUrlWithKeyWhenNeeded,
        apiKey,
      );
      if (result === "parse-error") {
        printHostedProxyJsonParseWarning(join(workspacePath, ".kilo", "kilo.jsonc"));
      }
    } else if (platform === "continue-dev") {
      result = await mergeContinueHostedMcp(
        workspacePath,
        shortName,
        proxyUrlWithKeyWhenNeeded,
        apiKey,
      );
      if (result === "parse-error") {
        printHostedProxyJsonParseWarning(
          join(workspacePath, ".continue", "mcpServers", `${shortName}.yaml`),
        );
      }
    } else {
      result = await mergeMcpServersObjectStyle(getCursorMcpJsonPath(), shortName, {
        url: proxyUrlWithKeyWhenNeeded,
        headers: { Authorization: authHeader },
      });
      if (result === "parse-error") {
        printHostedProxyJsonParseWarning(getCursorMcpJsonPath());
      }
    }

    if (result === "ok") {
      printHostedProxyPostWriteHints(platform, shortName);
      return;
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      style.yellow("\u26A0") + ` Could not write MCP config automatically (${detail}).` + "\n",
    );
  }

  printPlatformSnippet(platform, proxyUrl, shortName, apiKey);
}

function gooseExtensionYaml(shortName: string, proxyUrl: string, bearerHeader: string): string {
  return (
    `  ${shortName}:\n` +
    `    enabled: true\n` +
    `    type: streamable_http\n` +
    `    name: ${shortName}\n` +
    `    description: ''\n` +
    `    uri: ${proxyUrl}\n` +
    `    envs: {}\n` +
    `    env_keys: []\n` +
    `    headers:\n` +
    `      Authorization: ${bearerHeader}\n` +
    `    timeout: 300\n` +
    `    socket: null\n` +
    `    bundled: null\n` +
    `    available_tools: []\n`
  );
}

function gooseHostedProxyYaml(shortName: string, proxyUrl: string, bearerHeader: string): string {
  return `extensions:\n` + gooseExtensionYaml(shortName, proxyUrl, bearerHeader);
}

async function mergeGooseConfig(
  shortName: string,
  proxyUrl: string,
  apiKey: string,
): Promise<"ok" | "parse-error"> {
  const filePath = join(homedir(), ".config", "goose", "config.yaml");
  const bearerHeader = `Bearer ${apiKey}`;
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch (e) {
    if (isErrnoException(e) && e.code === "ENOENT") {
      content = "";
    } else {
      throw e;
    }
  }

  const extensionBlock = gooseExtensionYaml(shortName, proxyUrl, bearerHeader);

  if (content.includes(`  ${shortName}:`)) {
    return "ok";
  }

  let updated: string;
  if (content.includes("extensions:")) {
    const idx = content.indexOf("extensions:");
    const afterExtensions = idx + "extensions:".length;
    updated =
      content.slice(0, afterExtensions) + "\n" + extensionBlock + content.slice(afterExtensions);
  } else {
    updated =
      content +
      (content.length > 0 && !content.endsWith("\n") ? "\n" : "") +
      "extensions:\n" +
      extensionBlock;
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, updated, SECRET_JSON_FILE_OPTIONS);
  writeMcpAddedLine(shortName, filePath);
  return "ok";
}

function printPlatformSnippet(
  platform: string,
  routingToken: string,
  shortName: string,
  apiKey: string,
): void {
  const hostedInlinePlatforms = new Set([
    "cursor",
    "claude-desktop",
    "windsurf",
    "cline",
    "gemini-cli",
    "kilo-code",
    "github-copilot",
    "continue-dev",
    "goose",
  ]);
  const usesInlineKey = hostedInlinePlatforms.has(platform);
  const authHeader = usesInlineKey ? `Bearer ${apiKey}` : "Bearer YOUR_SHIELD_API_KEY";

  const urlInSnippet =
    usesInlineKey && shouldEmbedKeyInHostedProxyUrl(platform)
      ? hostedProxyUrlWithKeyParam(routingToken, apiKey)
      : routingToken;

  let snippetText: string;
  if (platform === "github-copilot") {
    snippetText = JSON.stringify(
      {
        servers: {
          [shortName]: {
            type: "http",
            url: urlInSnippet,
            headers: {
              Authorization: authHeader,
            },
          },
        },
      },
      null,
      2,
    );
  } else if (platform === "goose") {
    snippetText = gooseHostedProxyYaml(shortName, urlInSnippet, authHeader);
  } else if (platform === "gemini-cli") {
    snippetText = JSON.stringify(
      {
        mcpServers: {
          [shortName]: {
            httpUrl: urlInSnippet,
            headers: {
              Authorization: authHeader,
            },
          },
        },
      },
      null,
      2,
    );
  } else if (platform === "claude-desktop") {
    snippetText = JSON.stringify(
      {
        mcpServers: {
          [shortName]: {
            command: "npx",
            args: ["-y", "mcp-remote", urlInSnippet, "--header", `Authorization: ${authHeader}`],
          },
        },
      },
      null,
      2,
    );
  } else if (platform === "continue-dev") {
    snippetText =
      `name: ${shortName}\n` +
      `version: 0.0.1\n` +
      `schema: v1\n` +
      `mcpServers:\n` +
      `  - name: ${shortName}\n` +
      `    type: streamable-http\n` +
      `    url: ${urlInSnippet}\n` +
      `    headers:\n` +
      `      Authorization: ${authHeader}\n`;
  } else if (platform === "kilo-code") {
    snippetText = JSON.stringify(
      {
        mcp: {
          [shortName]: {
            type: "remote",
            url: urlInSnippet,
            headers: {
              Authorization: authHeader,
            },
            enabled: true,
          },
        },
      },
      null,
      2,
    );
  } else {
    const urlKey = platform === "windsurf" ? "serverUrl" : "url";
    snippetText = JSON.stringify(
      {
        mcpServers: {
          [shortName]: {
            [urlKey]: urlInSnippet,
            headers: {
              Authorization: authHeader,
            },
          },
        },
      },
      null,
      2,
    );
  }

  if (platform === "openclaw") {
    process.stderr.write("\n" + style.dim("Add this to your OpenClaw agent config:") + "\n\n");
  } else if (platform === "claude-code") {
    process.stderr.write("\n" + style.dim("Add this to your Claude Code MCP config:") + "\n\n");
  } else if (platform === "claude-desktop") {
    process.stderr.write("\n" + style.dim(`Add this to ${getClaudeDesktopConfigPath()}:`) + "\n\n");
  } else if (platform === "windsurf") {
    process.stderr.write("\n" + style.dim(`Add this to ${getWindsurfMcpConfigPath()}:`) + "\n\n");
  } else if (platform === "cline") {
    process.stderr.write("\n" + style.dim(`Add this to ${getClineMcpSettingsPath()}:`) + "\n\n");
  } else if (platform === "gemini-cli") {
    process.stderr.write(
      "\n" +
        style.dim(
          `Merge the snippet below into ${getGeminiCliSettingsPath()} (keep existing hooks and other keys). Restart Gemini CLI if it is already running.`,
        ) +
        "\n\n",
    );
  } else if (platform === "kilo-code") {
    process.stderr.write(
      "\n" +
        style.dim(`Add this to ${join(resolve(process.cwd()), ".kilo", "kilo.jsonc")}:`) +
        "\n\n",
    );
  } else if (platform === "github-copilot") {
    process.stderr.write(
      "\n" +
        style.dim(
          "Create .vscode/mcp.json in your workspace root (create the .vscode folder if it does not exist). After saving, reload VS Code and confirm the server appears in Copilot Agent mode under Tools.",
        ) +
        "\n\n",
    );
  } else if (platform === "continue-dev") {
    process.stderr.write(
      "\n" +
        style.dim(`Save this as .continue/mcpServers/${shortName}.yaml in your workspace root.`) +
        "\n\n",
    );
  } else if (platform === "goose") {
    process.stderr.write(
      "\n" +
        style.dim("Add this to ~/.config/goose/config.yaml under the extensions key.") +
        "\n\n",
    );
  } else {
    process.stderr.write("\n" + style.dim(`Add this to ${getCursorMcpJsonPath()}:`) + "\n\n");
  }

  process.stderr.write(style.cyan(snippetText) + "\n\n");
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

  if (platform === "claude-desktop") {
    process.stderr.write(style.dim("Then restart Claude Desktop to load the MCP server.") + "\n");
  }

  if (platform === "cline") {
    process.stderr.write(
      style.dim(
        "After pasting, restart Cline or reload the VS Code window. Cline will discover the Shield tools automatically.",
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

  if (platform === "github-copilot" || platform === "continue-dev") {
    process.stderr.write(
      style.dim("Reload the editor window if the MCP server does not appear immediately.") + "\n",
    );
  }

  if (platform === "goose") {
    process.stderr.write(style.dim("Start a new Goose session after updating config.") + "\n");
  }
}

function agentDisplayNameDedupeKey(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

function normalizeAgentEntryForMerge(a: AgentEntry): AgentEntry {
  const name = a.name.trim();
  const ws =
    typeof a.workspacePath === "string" && a.workspacePath.length > 0 ? a.workspacePath : undefined;
  return ws !== undefined
    ? { name, platform: a.platform, workspacePath: ws }
    : { name, platform: a.platform };
}

function mergeAgentEntryDupPair(first: AgentEntry, second: AgentEntry): AgentEntry {
  const name = first.name.trim();
  const platform = first.platform;
  const ws =
    typeof first.workspacePath === "string" && first.workspacePath.length > 0
      ? first.workspacePath
      : typeof second.workspacePath === "string" && second.workspacePath.length > 0
        ? second.workspacePath
        : undefined;
  return ws !== undefined ? { name, platform, workspacePath: ws } : { name, platform };
}

/**
 * Combines overlapping agent rows with the same logical name (trim + case-insensitive match).
 * The first row retains its original name capitalization (local agents are processed before API agents).
 */
function mergeAgentsForUniqueNames(agents: readonly AgentEntry[]): AgentEntry[] {
  const byKey = new Map<string, AgentEntry>();
  for (const raw of agents) {
    const key = agentDisplayNameDedupeKey(raw.name);
    const candidate = normalizeAgentEntryForMerge(raw);
    const prev = byKey.get(key);
    byKey.set(key, prev === undefined ? candidate : mergeAgentEntryDupPair(prev, candidate));
  }
  return [...byKey.values()];
}

/**
 * Merges on-disk agents with account API rows for one platform into one row per logical name
 * (trim + case-insensitive). Exported for unit tests covering the replace prompt behaviour.
 */
export function mergeAgentsForPlatform(
  localAgents: readonly AgentEntry[],
  remoteAgents: readonly { name: string; platform: string | null }[],
  selectedPlatform: string,
): AgentEntry[] {
  const merged: AgentEntry[] = [];
  for (const a of localAgents) {
    if (a.platform !== selectedPlatform) continue;
    merged.push(a);
  }
  for (const r of remoteAgents) {
    if (r.platform !== selectedPlatform) continue;
    merged.push({ name: r.name, platform: selectedPlatform });
  }
  return mergeAgentsForUniqueNames(merged);
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
 * @param options - When `verbose` is true, prints extra init diagnostics (e.g. menu selection and agent counts). Use `npx multicorn-shield init --verbose` or `init --debug`.
 * @returns The last saved config, or null if the user exited early.
 */
export async function runInit(
  explicitBaseUrl?: string,
  options?: { readonly verbose?: boolean },
): Promise<ProxyConfig | null> {
  const verbose = options?.verbose === true;

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

  if (apiKey.length === 0) {
    const signupDashboardUrl = deriveDashboardUrl(resolvedBaseUrl).replace(/\/+$/, "");
    console.log("");
    console.log("  Multicorn Shield controls what your AI agents can do.");
    console.log("  You need a free account to get an API key.");
    console.log("");
    console.log(`  1. Sign up or log in → ${signupDashboardUrl}`);
    console.log("  2. Go to Settings → API Keys to create a key");
    console.log("");
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

  await warnIfInstalledShieldIsOutdated();

  // Agent configuration loop (append to `agents`, no silent duplicate platforms)
  const configuredAgents: ConfiguredAgent[] = [];
  let currentAgents: AgentEntry[] = mergeAgentsForUniqueNames(collectAgentsFromConfig(existing));
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
    let postSaveNativeSkipNote: string | null = null;
    let removeAgentNameBeforeSave: string | undefined = undefined;
    const initWorkspacePath = resolve(process.cwd());
    const selection = await promptPlatformSelection(ask);
    const selectedPlatform = PLATFORM_BY_SELECTION[selection] ?? "cursor";
    const selectedLabel = platformMenuLabelForSelection(selection);

    // Local MCP / Other - minimal config, no agent name, no target URL.
    if (selectedPlatform === "other-mcp") {
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
            " make a request in your coding agent - Shield will intercept the first tool call and ask for your consent.\n" +
            style.dim("Example wrap command: ") +
            style.cyan(
              "npx multicorn-shield --wrap npx @modelcontextprotocol/server-filesystem /tmp",
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

    const remoteAccountAgents = await fetchRemoteAgentsSummaries(apiKey, resolvedBaseUrl);

    const agentsForPlatform = mergeAgentsForPlatform(
      currentAgents,
      remoteAccountAgents,
      selectedPlatform,
    );

    const localForPlatformCount = currentAgents.filter(
      (a) => a.platform === selectedPlatform,
    ).length;
    const accountForPlatformCount = remoteAccountAgents.filter(
      (r) => r.platform === selectedPlatform,
    ).length;
    const savedSummary =
      currentAgents.length === 0
        ? "none on disk"
        : currentAgents.map((a) => `${a.name} (${a.platform})`).join(", ");
    if (verbose) {
      process.stderr.write(
        style.dim(
          `[shield init] Menu option ${String(selection)} -> platform slug "${selectedPlatform}". ` +
            `${String(agentsForPlatform.length)} agent(s) for this platform ` +
            `(local file: ${String(localForPlatformCount)}, account API: ${String(accountForPlatformCount)}). ` +
            `On-disk entries: ${savedSummary}.`,
        ) + "\n",
      );
    }

    if (agentsForPlatform.length > 0) {
      process.stderr.write(
        `\nYou have ${String(agentsForPlatform.length)} agent(s) connected for ${selectedLabel}:\n`,
      );
      for (const a of agentsForPlatform) {
        const isThisWorkspace =
          typeof a.workspacePath === "string" &&
          a.workspacePath.length > 0 &&
          resolve(a.workspacePath) === initWorkspacePath;
        const wsHint =
          typeof a.workspacePath === "string" && a.workspacePath.length > 0
            ? `  ${style.dim(a.workspacePath)}`
            : "";
        const marker = isThisWorkspace ? `  ${style.yellow("(this workspace)")}` : "";
        process.stderr.write(`  ${style.dim("•")} ${style.cyan(a.name)}${wsHint}${marker}\n`);
      }

      process.stderr.write("\n" + style.bold("What would you like to do?") + "\n");
      const actionIdx = await arrowSelect(
        [
          "Add a new agent alongside these",
          "Replace an existing agent",
          "Skip - choose a different platform",
        ],
        ask,
        "Action",
      );
      if (actionIdx === 2) {
        continue;
      }
      if (actionIdx === 1) {
        process.stderr.write("\n" + style.bold("Which agent to replace?") + "\n");
        const replaceIdx = await arrowSelect(
          agentsForPlatform.map((a) => a.name),
          ask,
          "Agent",
        );
        const victim = agentsForPlatform[replaceIdx];
        if (victim !== undefined) {
          removeAgentNameBeforeSave = victim.name;
          process.stderr.write(
            "\n" +
              style.dim("Replacing agent ") +
              style.cyan(victim.name) +
              style.dim("...") +
              "\n",
          );
        }
      }
    }

    if (selectedPlatform === "cursor" || selectedPlatform === "github-copilot") {
      const where = selectedPlatform === "cursor" ? "Cursor" : "GitHub Copilot";
      process.stderr.write(
        "\n" +
          style.dim(
            `Using Claude models (Sonnet, Opus, Haiku) in ${where}? The Claude Code native plugin is recommended - it governs all tool calls, not just MCP traffic. Run init again and select Claude Code.`,
          ) +
          "\n\n",
      );
    }

    const prereqEntry = INIT_WIZARD_PLATFORM_REGISTRY.find((e) => e.slug === selectedPlatform);
    if (prereqEntry?.prereqUrl !== undefined) {
      const proceed = await promptHostedProxyInstallPrereq(
        ask,
        prereqEntry.displayName,
        prereqEntry.prereqUrl,
      );
      if (!proceed) {
        const another = await ask("\nConnect another agent? (Y/n) ");
        if (another.trim().toLowerCase() === "n") {
          configuring = false;
        }
        continue;
      }
    }

    const agentName = await promptAgentName(ask, selectedPlatform, removeAgentNameBeforeSave);

    let setupSucceeded = false;

    if (selectedPlatform === "openclaw") {
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
            " OpenClaw is not installed. Install OpenClaw first, then run npx multicorn-shield init again.\n",
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
    } else if (selectedPlatform === "claude-code") {
      process.stderr.write(
        "\n" + style.dim("Configuring Shield hooks in Claude Code user settings...") + "\n",
      );
      const hooksOk = await installClaudeCodeUserSettingsHooks(ask);
      if (!hooksOk) {
        process.stderr.write(style.dim("Skipped Claude Code hook installation.\n"));
        continue;
      }
      process.stderr.write(
        style.green("\u2713") +
          " Shield hooks added to " +
          style.cyan("~/.claude/settings.json") +
          "\n",
      );
      if (claudeInstalledPluginsListsMulticornShield()) {
        process.stderr.write(
          style.dim(
            "Note: You have the multicorn-shield Claude Code plugin installed. The plugin is no longer needed - hooks are now written directly to settings.json. You can uninstall it with: ",
          ) +
            style.cyan("claude plugin uninstall multicorn-shield@multicorn-shield") +
            "\n",
        );
      }
      configuredAgents.push({
        selection,
        platform: selectedPlatform,
        platformLabel: selectedLabel,
        agentName,
      });
      setupSucceeded = true;
    } else if (selectedPlatform === "windsurf") {
      const windsurfMode = await promptWindsurfIntegrationMode(ask);
      if (windsurfMode === "native") {
        try {
          await installWindsurfNativeHooks();
          process.stderr.write("\n" + style.bold("Shield Windsurf hooks installed") + "\n");
          process.stderr.write(
            style.dim("Scripts: ") + style.cyan(getWindsurfHooksInstallDir()) + "\n",
          );
          process.stderr.write(
            style.dim("Hooks config: ") + style.cyan(getWindsurfCascadeHooksJsonPath()) + "\n",
          );
          process.stderr.write(
            "\n" +
              style.dim(
                "The Shield hook runs with your user permissions. It intercepts Cascade actions to check permissions and log activity. Review the scripts under ",
              ) +
              style.cyan("~/.multicorn/windsurf-hooks") +
              style.dim(" if that is a concern.") +
              "\n\n",
          );
          process.stderr.write(
            style.dim(
              "Try it: make a request in Windsurf - Shield will intercept the first tool call and ask for your consent.",
            ) + "\n",
          );
          configuredAgents.push({
            selection,
            platform: selectedPlatform,
            platformLabel: selectedLabel,
            agentName,
            windsurfIntegration: "native",
          });
          setupSucceeded = true;
        } catch (error) {
          if (error instanceof NativePluginPrerequisiteMissingError) {
            postSaveNativeSkipNote = nativePluginSkippedSaveNote(
              "npx multicorn-shield init",
              "Windsurf",
            );
            configuredAgents.push({
              selection,
              platform: selectedPlatform,
              platformLabel: selectedLabel,
              agentName,
            });
            setupSucceeded = true;
          } else {
            const detail = error instanceof Error ? error.message : String(error);
            process.stderr.write(style.red("\u2717 ") + detail + "\n");
          }
        }
      } else {
        const { targetUrl, shortName, upstreamHeaders } = await promptProxyConfig(ask, agentName);

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
              upstreamHeaders,
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
          process.stderr.write(
            "  " +
              style.cyan(formatHostedProxyUrlForStderr(selectedPlatform, proxyUrl, apiKey)) +
              "\n",
          );
          await applyHostedProxyMcpConfig(
            selectedPlatform,
            proxyUrl,
            shortName,
            apiKey,
            initWorkspacePath,
          );
          configuredAgents.push({
            selection,
            platform: selectedPlatform,
            platformLabel: selectedLabel,
            agentName,
            shortName,
            proxyUrl,
            windsurfIntegration: "hosted",
          });
          setupSucceeded = true;
        }
      }
    } else if (selectedPlatform === "gemini-cli") {
      const geminiMode = await promptGeminiCliIntegrationMode(ask);
      if (geminiMode === "native") {
        try {
          await installGeminiCliNativeHooks(ask);
          process.stderr.write("\n" + style.bold("Shield Gemini CLI hooks installed") + "\n\n");
          process.stderr.write(
            style.dim("Hook scripts: ") + style.cyan(getGeminiCliHooksInstallDir()) + "\n",
          );
          process.stderr.write(
            style.dim("Settings updated at ") + style.cyan("~/.gemini/settings.json") + "\n",
          );
          process.stderr.write(
            style.dim(
              "The Shield hook runs with your user permissions. It intercepts Gemini CLI tool calls to check permissions and log activity. Review the scripts if that is a concern.",
            ) + "\n",
          );
          configuredAgents.push({
            selection,
            platform: selectedPlatform,
            platformLabel: selectedLabel,
            agentName,
            geminiCliIntegration: "native",
          });
          setupSucceeded = true;
        } catch (error) {
          if (error instanceof NativePluginPrerequisiteMissingError) {
            postSaveNativeSkipNote = nativePluginSkippedSaveNote(
              "npx multicorn-shield init",
              "Gemini CLI",
            );
            configuredAgents.push({
              selection,
              platform: selectedPlatform,
              platformLabel: selectedLabel,
              agentName,
            });
            setupSucceeded = true;
          } else {
            const detail = error instanceof Error ? error.message : String(error);
            process.stderr.write(style.red("\u2717 ") + detail + "\n");
          }
        }
      } else {
        const { targetUrl, shortName, upstreamHeaders } = await promptProxyConfig(ask, agentName);

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
              upstreamHeaders,
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
          process.stderr.write(
            "  " +
              style.cyan(formatHostedProxyUrlForStderr(selectedPlatform, proxyUrl, apiKey)) +
              "\n",
          );
          await applyHostedProxyMcpConfig(
            selectedPlatform,
            proxyUrl,
            shortName,
            apiKey,
            initWorkspacePath,
          );
          configuredAgents.push({
            selection,
            platform: selectedPlatform,
            platformLabel: selectedLabel,
            agentName,
            shortName,
            proxyUrl,
            geminiCliIntegration: "hosted",
          });
          setupSucceeded = true;
        }
      }
    } else if (selectedPlatform === "cline") {
      const clineMode = await promptClineIntegrationMode(ask);
      if (clineMode === "native") {
        try {
          await installClineNativeHooks();
          process.stderr.write("\n" + style.bold("Shield Cline hooks installed") + "\n\n");
          process.stderr.write(
            style.dim(
              "The Shield hook runs with your user permissions. It intercepts Cline tool calls to check permissions and log activity. Review the scripts under ",
            ) +
              style.cyan("~/.multicorn/cline-hooks") +
              style.dim(" if that is a concern.") +
              "\n",
          );
          configuredAgents.push({
            selection,
            platform: selectedPlatform,
            platformLabel: selectedLabel,
            agentName,
            clineIntegration: "native",
          });
          setupSucceeded = true;
        } catch (error) {
          if (error instanceof NativePluginPrerequisiteMissingError) {
            postSaveNativeSkipNote = nativePluginSkippedSaveNote(
              "npx multicorn-shield init",
              "Cline",
            );
            configuredAgents.push({
              selection,
              platform: selectedPlatform,
              platformLabel: selectedLabel,
              agentName,
            });
            setupSucceeded = true;
          } else {
            const detail = error instanceof Error ? error.message : String(error);
            process.stderr.write(style.red("\u2717 ") + detail + "\n");
          }
        }
      } else {
        const { targetUrl, shortName, upstreamHeaders } = await promptProxyConfig(ask, agentName);

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
              upstreamHeaders,
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
          process.stderr.write(
            "  " +
              style.cyan(formatHostedProxyUrlForStderr(selectedPlatform, proxyUrl, apiKey)) +
              "\n",
          );
          await applyHostedProxyMcpConfig(
            selectedPlatform,
            proxyUrl,
            shortName,
            apiKey,
            initWorkspacePath,
          );
          configuredAgents.push({
            selection,
            platform: selectedPlatform,
            platformLabel: selectedLabel,
            agentName,
            shortName,
            proxyUrl,
            clineIntegration: "hosted",
          });
          setupSucceeded = true;
        }
      }
    } else {
      const { targetUrl, shortName, upstreamHeaders } = await promptProxyConfig(ask, agentName);

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
            upstreamHeaders,
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
        process.stderr.write(
          "  " +
            style.cyan(formatHostedProxyUrlForStderr(selectedPlatform, proxyUrl, apiKey)) +
            "\n",
        );
        await applyHostedProxyMcpConfig(
          selectedPlatform,
          proxyUrl,
          shortName,
          apiKey,
          initWorkspacePath,
        );
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
      if (removeAgentNameBeforeSave !== undefined) {
        const removeKey = agentDisplayNameDedupeKey(removeAgentNameBeforeSave);
        currentAgents = currentAgents.filter(
          (a) => agentDisplayNameDedupeKey(a.name) !== removeKey,
        );
      }
      currentAgents.push({
        name: agentName,
        platform: selectedPlatform,
        workspacePath: initWorkspacePath,
      });
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
        if (postSaveNativeSkipNote != null) {
          process.stderr.write(postSaveNativeSkipNote);
          postSaveNativeSkipNote = null;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(style.red(`Failed to save config: ${detail}`) + "\n");
        postSaveNativeSkipNote = null;
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

    function mcpPromptLabel(platformSlug: string): string {
      const rows = configuredAgents.filter((a) => a.platform === platformSlug);
      const last = rows[rows.length - 1];
      if (last === undefined) return "shield-mcp";
      const s = typeof last.shortName === "string" ? last.shortName.trim() : "";
      if (s.length > 0) return s;
      return last.agentName.trim().length > 0 ? last.agentName.trim() : "shield-mcp";
    }

    // Next steps grouped by platform.
    const blocks: string[] = [];

    if (configuredPlatforms.has("openclaw")) {
      blocks.push(
        "\n" +
          style.bold("OpenClaw") +
          "\n" +
          "  \u2192 Restart your gateway: " +
          style.cyan("openclaw gateway restart") +
          "\n" +
          "  \u2192 Start a session: " +
          style.cyan("openclaw tui") +
          "\n" +
          "  \u2192 Try it: make a request in OpenClaw - Shield will intercept the first tool call and ask for your consent\n",
      );
    }
    if (configuredPlatforms.has("claude-code")) {
      blocks.push(
        "\n" +
          style.bold("Claude Code") +
          "\n" +
          "  \u2192 Start coding: run " +
          style.cyan("claude") +
          " in the terminal, or use Cursor with a Claude model - Shield hooks apply to both\n" +
          "  \u2192 Try it: make a request in Claude Code - Shield will intercept the first tool call and ask for your consent\n",
      );
    }
    if (configuredPlatforms.has("claude-desktop")) {
      const cdLabel = mcpPromptLabel("claude-desktop");
      blocks.push(
        "\n" +
          style.bold("Claude Desktop") +
          "\n" +
          "  \u2192 Restart Claude Desktop to load the updated configuration\n" +
          "  \u2192 Confirm connection: click your profile (bottom-left) \u2192 Settings \u2192 Developer\n" +
          '    Check that "' +
          cdLabel +
          '" shows a green "running" status\n' +
          "  \u2192 Try it: paste this into Claude Desktop:\n" +
          '    "Use the ' +
          cdLabel +
          ' MCP server to list my GitHub repositories"\n',
      );
    }
    if (configuredPlatforms.has("cursor")) {
      const cursorLabel = mcpPromptLabel("cursor");
      blocks.push(
        "\n" +
          style.bold("Cursor") +
          "\n" +
          "  \u2192 If needed, download Cursor from " +
          style.cyan("https://www.cursor.com/downloads") +
          "\n" +
          "  \u2192 Restart Cursor so it loads the MCP server\n" +
          "  \u2192 Confirm connection: open Settings \u2192 Tools & MCPs\n" +
          '    Check that "' +
          cursorLabel +
          '" shows a green status indicator\n' +
          "  \u2192 Try it: paste this into Cursor:\n" +
          '    "Use the ' +
          cursorLabel +
          ' MCP server to list my GitHub repositories"\n',
      );
    }
    if (configuredPlatforms.has("kilo-code")) {
      const kiloLabel = mcpPromptLabel("kilo-code");
      blocks.push(
        "\n" +
          style.bold("Kilo Code") +
          "\n" +
          "  \u2192 Restart the editor or reload the window if the MCP server does not appear\n" +
          "  \u2192 Confirm connection: Settings \u2192 Agent Behaviour \u2192 MCP Servers\n" +
          "  \u2192 Try it: paste this into Kilo Code:\n" +
          '    "Use the ' +
          kiloLabel +
          ' MCP server to list my GitHub repositories"\n',
      );
    }
    if (configuredPlatforms.has("github-copilot")) {
      const copilotLabel = mcpPromptLabel("github-copilot");
      blocks.push(
        "\n" +
          style.bold("GitHub Copilot") +
          "\n" +
          "  \u2192 Reload the editor window if the MCP server does not appear\n" +
          "  \u2192 Confirm connection: open Copilot chat in Agent mode and confirm the server appears under Tools\n" +
          "  \u2192 Try it: paste this into GitHub Copilot:\n" +
          '    "Use the ' +
          copilotLabel +
          ' MCP server to list my GitHub repositories"\n',
      );
    }
    if (configuredPlatforms.has("continue-dev")) {
      const continueLabel = mcpPromptLabel("continue-dev");
      blocks.push(
        "\n" +
          style.bold("Continue") +
          "\n" +
          "  \u2192 If needed, install Continue from " +
          style.cyan("https://docs.continue.dev/ide-extensions/install") +
          "\n" +
          "  \u2192 Reload VS Code and open Continue agent mode\n" +
          "  \u2192 Confirm connection: Settings \u2192 Tools \u2192 MCP Servers\n" +
          "  \u2192 Try it: paste this into Continue:\n" +
          '    "Use the ' +
          continueLabel +
          ' MCP server to list my GitHub repositories"\n',
      );
    }
    if (configuredPlatforms.has("goose")) {
      const gooseLabel = mcpPromptLabel("goose");
      blocks.push(
        "\n" +
          style.bold("Goose") +
          "\n" +
          "  \u2192 Start a new Goose session after updating config\n" +
          "  \u2192 Confirm connection: check the Extensions page in the sidebar\n" +
          "  \u2192 Try it: paste this into Goose:\n" +
          '    "Use the ' +
          gooseLabel +
          ' MCP server to list my GitHub repositories"\n',
      );
    }
    const windsurfNativeConfigured = configuredAgents.some(
      (a) => a.platform === "windsurf" && a.windsurfIntegration === "native",
    );
    const windsurfHostedConfigured = configuredAgents.some(
      (a) => a.platform === "windsurf" && a.windsurfIntegration === "hosted",
    );

    if (windsurfNativeConfigured) {
      blocks.push(
        "\n" +
          style.bold("Windsurf (native)") +
          "\n" +
          "  \u2192 Open Windsurf (or restart if it is already running)\n" +
          "  \u2192 Try it: make a request in Windsurf - Shield will intercept the first tool call and ask for your consent\n",
      );
    }
    if (windsurfHostedConfigured) {
      blocks.push(
        "\n" +
          style.bold("Windsurf (hosted)") +
          "\n" +
          "  \u2192 If needed, install from " +
          style.cyan("https://windsurf.com/download") +
          "\n" +
          "  \u2192 Restart Windsurf so it loads the MCP server\n" +
          "  \u2192 In Windsurf, open the three-dot menu (top-right of Cascade panel), find your Shield server at the bottom of the list, and toggle it on\n" +
          "  \u2192 Try it: make a request in Windsurf - Shield will intercept the first tool call and ask for your consent\n",
      );
    }

    const clineNativeConfigured = configuredAgents.some(
      (a) => a.platform === "cline" && a.clineIntegration === "native",
    );
    const clineHostedConfigured = configuredAgents.some(
      (a) => a.platform === "cline" && a.clineIntegration === "hosted",
    );

    if (clineNativeConfigured) {
      blocks.push(
        "\n" +
          style.bold("Cline (native)") +
          "\n" +
          "  \u2192 In Cline, click the settings icon \u2192 Feature Settings \u2192 scroll down to Advanced \u2192 enable Hooks, then reload the VS Code window\n" +
          "  \u2192 Try it: make a request in Cline - Shield will intercept the first tool call and ask for your consent\n",
      );
    }
    if (clineHostedConfigured) {
      blocks.push(
        "\n" +
          style.bold("Cline (hosted)") +
          "\n" +
          "  \u2192 Restart Cline or reload the VS Code window\n" +
          "  \u2192 In Cline, open server settings using the plug icon, open the Configure tab, and confirm your Shield server is listed and toggled on\n" +
          "  \u2192 Try it: make a request in Cline - Shield will intercept the first tool call and ask for your consent\n",
      );
    }

    const geminiCliNativeConfigured = configuredAgents.some(
      (a) => a.platform === "gemini-cli" && a.geminiCliIntegration === "native",
    );
    const geminiCliHostedConfigured = configuredAgents.some(
      (a) => a.platform === "gemini-cli" && a.geminiCliIntegration === "hosted",
    );

    if (geminiCliNativeConfigured) {
      blocks.push(
        "\n" +
          style.bold("Gemini CLI (native)") +
          "\n" +
          "  \u2192 Start Gemini CLI: run " +
          style.cyan("gemini") +
          " in your terminal (exit any existing session first)\n" +
          "  \u2192 Try it: make a request in Gemini CLI - Shield will intercept the first tool call and ask for your consent\n",
      );
    }
    if (geminiCliHostedConfigured) {
      blocks.push(
        "\n" +
          style.bold("Gemini CLI (hosted)") +
          "\n" +
          "  \u2192 Try it: make a request in Gemini CLI - Shield will intercept the first tool call and ask for your consent\n",
      );
    }

    if (configuredPlatforms.has("other-mcp")) {
      blocks.push(
        "\n" +
          style.bold("Local MCP / Other") +
          "\n" +
          "  \u2192 Run your configured wrap command (for example " +
          style.cyan("npx multicorn-shield --wrap ...") +
          ")\n" +
          "  \u2192 Try it: make a request in your coding agent - Shield will intercept the first tool call and ask for your consent\n",
      );
    }

    if (blocks.length > 0) {
      process.stderr.write("\n" + style.bold(style.violet("Next steps")) + "\n");
      process.stderr.write(blocks.join("") + "\n");
    }

    const dashboardUrl = deriveDashboardUrl(resolvedBaseUrl).replace(/\/+$/, "");
    console.log("");
    console.log("  Your dashboard");
    console.log(`  → ${dashboardUrl}/agents`);
    console.log("");
    console.log("  Use any tool in your agent to see it appear.");
    console.log("");
  }

  return lastConfig;
}
