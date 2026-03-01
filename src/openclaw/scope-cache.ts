/**
 * Local scope cache for the OpenClaw hook.
 *
 * Reads and writes granted permissions to `~/.multicorn/scopes.json` so the
 * hook can check permissions without hitting the API on every tool call.
 * The cache is refreshed periodically (controlled by the handler).
 *
 * File permissions are set to 0o600 (owner read/write only) because the
 * cache contains agent metadata.
 *
 * @module openclaw/scope-cache
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Scope } from "../types/index.js";

const MULTICORN_DIR = join(homedir(), ".multicorn");
const SCOPES_PATH = join(MULTICORN_DIR, "scopes.json");

interface ScopesCacheEntry {
  readonly agentId: string;
  readonly scopes: readonly Scope[];
  readonly fetchedAt: string;
}

type ScopesCacheFile = Readonly<Record<string, ScopesCacheEntry>>;

/**
 * Load cached scopes for a given agent name.
 *
 * @returns The cached scopes, or `null` if the cache is missing, corrupt,
 *          or doesn't contain an entry for this agent.
 */
export async function loadCachedScopes(agentName: string): Promise<readonly Scope[] | null> {
  try {
    const raw = await readFile(SCOPES_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isScopesCacheFile(parsed)) return null;

    const entry = parsed[agentName];
    return entry?.scopes ?? null;
  } catch {
    return null;
  }
}

/**
 * Save scopes to the local cache file.
 *
 * Creates the `~/.multicorn/` directory if it doesn't exist. Merges with
 * any existing cache entries for other agents.
 */
export async function saveCachedScopes(
  agentName: string,
  agentId: string,
  scopes: readonly Scope[],
): Promise<void> {
  await mkdir(MULTICORN_DIR, { recursive: true, mode: 0o700 });

  let existing: ScopesCacheFile = {};
  try {
    const raw = await readFile(SCOPES_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isScopesCacheFile(parsed)) existing = parsed;
  } catch {
    // File missing or corrupt. Start fresh.
  }

  const updated: ScopesCacheFile = {
    ...existing,
    [agentName]: {
      agentId,
      scopes,
      fetchedAt: new Date().toISOString(),
    },
  };

  await writeFile(SCOPES_PATH, JSON.stringify(updated, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function isScopesCacheFile(value: unknown): value is ScopesCacheFile {
  return typeof value === "object" && value !== null;
}
