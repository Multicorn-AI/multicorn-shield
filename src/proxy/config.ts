/**
 * Config management for the MCP proxy.
 *
 * Reads and writes `~/.multicorn/config.json`. The interactive `init` command
 * prompts for an API key, validates it against the service, then saves it.
 *
 * @module proxy/config
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const CONFIG_DIR = join(homedir(), ".multicorn");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

const OPENCLAW_ENOENT_MESSAGE =
  "OpenClaw config not found at ~/.openclaw/openclaw.json. If you're using OpenClaw, install it and then re-run 'npx multicorn-proxy init' to automatically configure your API key.\n";
const OPENCLAW_PARSE_WARNING =
  "Multicorn Shield: Could not update ~/.openclaw/openclaw.json - please set MULTICORN_API_KEY manually.\n";
const OPENCLAW_UPDATED_MESSAGE = "OpenClaw config updated at ~/.openclaw/openclaw.json\n";

export interface ProxyConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
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
 * If ~/.openclaw/openclaw.json exists, set MULTICORN_API_KEY and MULTICORN_BASE_URL
 * under hooks.internal.entries["multicorn-shield"].env. Creates that path if missing.
 * If the file does not exist, logs a one-line message and returns. If the file is
 * malformed JSON, logs a warning and returns without throwing.
 */
export async function updateOpenClawConfigIfPresent(
  apiKey: string,
  baseUrl: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(OPENCLAW_CONFIG_PATH, "utf8");
  } catch (e) {
    if (isErrnoException(e) && e.code === "ENOENT") {
      process.stderr.write(OPENCLAW_ENOENT_MESSAGE);
      return;
    }
    throw e;
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    process.stderr.write(OPENCLAW_PARSE_WARNING);
    return;
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

  await writeFile(OPENCLAW_CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n", {
    encoding: "utf8",
  });
  process.stderr.write(OPENCLAW_UPDATED_MESSAGE);
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

export async function runInit(baseUrl = "https://api.multicorn.ai"): Promise<ProxyConfig> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  function ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        resolve(answer);
      });
    });
  }

  process.stderr.write("Multicorn Shield proxy setup\n\n");
  process.stderr.write("Get your API key at https://app.multicorn.ai/settings/api-keys\n\n");

  let config: ProxyConfig | null = null;

  while (config === null) {
    const input = await ask("API key (starts with mcs_): ");
    const apiKey = input.trim();

    if (apiKey.length === 0) {
      process.stderr.write("API key is required.\n");
      continue;
    }

    process.stderr.write("Validating key...\n");
    const result = await validateApiKey(apiKey, baseUrl);

    if (!result.valid) {
      process.stderr.write(`${result.error ?? "Validation failed. Try again."}\n`);
      continue;
    }

    config = { apiKey, baseUrl };
  }

  rl.close();
  await saveConfig(config);

  try {
    await updateOpenClawConfigIfPresent(config.apiKey, config.baseUrl);
  } catch {
    process.stderr.write(
      "Could not update OpenClaw config. Set MULTICORN_API_KEY in ~/.openclaw/openclaw.json if you use OpenClaw.\n",
    );
  }

  process.stderr.write(`\nConfig saved to ${CONFIG_PATH}\n`);
  process.stderr.write("Run your agent with: npx multicorn-proxy --wrap <your-mcp-server>\n");

  return config;
}

function isProxyConfig(value: unknown): value is ProxyConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["apiKey"] === "string" && typeof obj["baseUrl"] === "string";
}
