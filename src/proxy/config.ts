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
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
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

  process.stderr.write(`\nConfig saved to ${CONFIG_PATH}\n`);
  process.stderr.write("Run your agent with: npx multicorn-proxy --wrap <your-mcp-server>\n");

  return config;
}

function isProxyConfig(value: unknown): value is ProxyConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["apiKey"] === "string" && typeof obj["baseUrl"] === "string";
}
