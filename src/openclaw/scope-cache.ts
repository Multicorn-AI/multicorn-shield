/**
 * Local scope cache for the OpenClaw hook.
 *
 * Reads and writes granted permissions to `~/.multicorn/scopes.json` so the
 * hook can check permissions without hitting the API on every tool call.
 * The cache is refreshed periodically (controlled by the handler).
 *
 * Cache keys are account-aware: hash(agentName + apiKey) so different accounts
 * do not share cached scopes. When the API key changes, the cache is cleared.
 *
 * File permissions are set to 0o600 (owner read/write only) because the
 * cache contains agent metadata.
 *
 * @module openclaw/scope-cache
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Scope } from "../types/index.js";

const MULTICORN_DIR = join(homedir(), ".multicorn");
const SCOPES_PATH = join(MULTICORN_DIR, "scopes.json");
const CACHE_META_PATH = join(MULTICORN_DIR, "cache-meta.json");

interface ScopesCacheEntry {
  readonly agentId: string;
  readonly scopes: readonly Scope[];
  readonly fetchedAt: string;
}

interface CacheMeta {
  readonly apiKeyHash: string;
}

type ScopesCacheFile = Readonly<Record<string, ScopesCacheEntry>>;

/**
 * Compute a cache key from agent name and API key.
 * Uses SHA-256 so different accounts never share cached scopes.
 */
function cacheKey(agentName: string, apiKey: string): string {
  return createHash("sha256").update(`${agentName}:${apiKey}`).digest("hex").slice(0, 16);
}

/**
 * Ensure the cache is valid for the current API key.
 * If the API key has changed since the last run, clear the scopes cache.
 */
async function ensureCacheIdentity(apiKey: string): Promise<void> {
  const currentHash = createHash("sha256").update(apiKey).digest("hex");

  let storedHash: string | null = null;
  try {
    const raw = await readFile(CACHE_META_PATH, "utf8");
    const meta = JSON.parse(raw) as unknown;
    if (typeof meta === "object" && meta !== null && "apiKeyHash" in meta) {
      storedHash = (meta as CacheMeta).apiKeyHash;
    }
  } catch {
    // File missing or corrupt.
  }

  if (storedHash !== null && storedHash !== currentHash) {
    try {
      await unlink(SCOPES_PATH);
    } catch {
      // File may not exist. Ignore.
    }
  }

  if (storedHash !== currentHash) {
    await mkdir(MULTICORN_DIR, { recursive: true, mode: 0o700 });
    await writeFile(CACHE_META_PATH, JSON.stringify({ apiKeyHash: currentHash }, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

/**
 * Load cached scopes for a given agent name and API key.
 *
 * API key is used to key the cache by account (cachedMulticornConfig first, then
 * process.env, matching config priority). Empty API key still produces a stable key.
 *
 * @returns The cached scopes, or `null` if the cache is missing, corrupt,
 *          or doesn't contain an entry for this agent/account.
 */
export async function loadCachedScopes(
  agentName: string,
  apiKey: string,
): Promise<readonly Scope[] | null> {
  if (apiKey.length === 0) return null;

  await ensureCacheIdentity(apiKey);
  const key = cacheKey(agentName, apiKey);

  try {
    const raw = await readFile(SCOPES_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isScopesCacheFile(parsed)) return null;

    const entry = parsed[key];
    return entry?.scopes ?? null;
  } catch {
    return null;
  }
}

/**
 * Save scopes to the local cache file.
 *
 * Creates the `~/.multicorn/` directory if it doesn't exist. Merges with
 * any existing cache entries. Uses account-aware key (agentName + apiKey).
 */
export async function saveCachedScopes(
  agentName: string,
  agentId: string,
  scopes: readonly Scope[],
  apiKey: string,
): Promise<void> {
  if (apiKey.length === 0) return;

  await ensureCacheIdentity(apiKey);
  const key = cacheKey(agentName, apiKey);

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
    [key]: {
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
