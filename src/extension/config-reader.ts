/**
 * Claude Desktop MCP config paths, parsing, and Shield extension backup.
 *
 * @module extension/config-reader
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getClaudeDesktopConfigPath } from "../proxy/config.js";

export const EXTENSION_BACKUP_FILENAME = "extension-backup.json";

export function getExtensionBackupPath(): string {
  return join(homedir(), ".multicorn", EXTENSION_BACKUP_FILENAME);
}

export interface McpServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface ClaudeDesktopMcpConfig {
  readonly configPath: string;
  readonly mcpServers: Readonly<Record<string, McpServerEntry>>;
}

export interface ExtensionBackupV1 {
  readonly version: 1;
  readonly createdAt: string;
  readonly claudeDesktopConfigPath: string;
  readonly mcpServers: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpServerEntry(value: unknown): value is McpServerEntry {
  if (!isRecord(value)) return false;
  const command = value["command"];
  const args = value["args"];
  if (typeof command !== "string" || command.length === 0) return false;
  if (!Array.isArray(args)) return false;
  for (const a of args) {
    if (typeof a !== "string") return false;
  }
  const env = value["env"];
  if (env !== undefined) {
    if (!isRecord(env)) return false;
    for (const v of Object.values(env)) {
      if (typeof v !== "string") return false;
    }
  }
  return true;
}

/**
 * Returns true when this config entry is the Shield Desktop Extension server
 * (must not be spawned as a child).
 */
export function isShieldExtensionEntry(serverKey: string, entry: McpServerEntry): boolean {
  const key = serverKey.trim().toLowerCase();
  if (key === "multicorn-shield") {
    return true;
  }

  const argBlob = entry.args.join(" ").toLowerCase();
  if (argBlob.includes("shield-extension")) {
    return true;
  }

  if (entry.command.toLowerCase().includes("shield-extension")) {
    return true;
  }

  if (entry.env?.["MULTICORN_SHIELD_EXTENSION"] === "1") {
    return true;
  }

  return false;
}

/**
 * Reads Claude Desktop config and returns parsed MCP server entries.
 */
export async function readClaudeDesktopMcpConfig(): Promise<ClaudeDesktopMcpConfig | null> {
  const configPath = getClaudeDesktopConfigPath();
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const mcpServersRaw = parsed["mcpServers"];
  if (!isRecord(mcpServersRaw)) {
    return { configPath, mcpServers: {} };
  }

  const mcpServers: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(mcpServersRaw)) {
    if (isMcpServerEntry(entry)) {
      mcpServers[name] = {
        command: entry.command,
        args: [...entry.args],
        ...(entry.env !== undefined ? { env: { ...entry.env } } : {}),
      };
    }
  }

  return { configPath, mcpServers };
}

/**
 * Writes a backup of the current `mcpServers` block for uninstall or disable recovery.
 */
export async function writeExtensionBackup(
  claudeDesktopConfigPath: string,
  mcpServers: Readonly<Record<string, McpServerEntry>>,
): Promise<void> {
  const dir = join(homedir(), ".multicorn");
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const serializable: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mcpServers)) {
    serializable[k] = {
      command: v.command,
      args: [...v.args],
      ...(v.env !== undefined ? { env: { ...v.env } } : {}),
    };
  }

  const payload: ExtensionBackupV1 = {
    version: 1,
    createdAt: new Date().toISOString(),
    claudeDesktopConfigPath,
    mcpServers: serializable,
  };

  await writeFile(getExtensionBackupPath(), JSON.stringify(payload, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readExtensionBackup(): Promise<ExtensionBackupV1 | null> {
  try {
    const raw = await readFile(getExtensionBackupPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed["version"] !== 1) return null;
    if (typeof parsed["createdAt"] !== "string") return null;
    if (typeof parsed["claudeDesktopConfigPath"] !== "string") return null;
    const mcpServers = parsed["mcpServers"];
    if (!isRecord(mcpServers)) return null;

    return {
      version: 1,
      createdAt: parsed["createdAt"],
      claudeDesktopConfigPath: parsed["claudeDesktopConfigPath"],
      mcpServers,
    };
  } catch {
    return null;
  }
}
