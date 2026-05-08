/**
 * Restores Claude Desktop `mcpServers` from Shield extension backup.
 *
 * @module extension/restore
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getClaudeDesktopConfigPath } from "../proxy/config.js";
import { readExtensionBackup } from "./config-reader.js";

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === "object" && e !== null && "code" in e;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Writes `mcpServers` from `~/.multicorn/extension-backup.json` into the current machine's
 * Claude Desktop config file. Preserves other top-level keys when the file already exists.
 */
export async function restoreClaudeDesktopMcpFromBackup(): Promise<void> {
  const backup = await readExtensionBackup();
  if (backup === null) {
    throw new Error(
      "No Shield extension backup found. Expected ~/.multicorn/extension-backup.json " +
        "from a previous Shield Desktop Extension session.",
    );
  }

  const configPath = getClaudeDesktopConfigPath();
  let root: Record<string, unknown> = {};

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      root = parsed;
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  root["mcpServers"] = backup.mcpServers;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(root, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}
