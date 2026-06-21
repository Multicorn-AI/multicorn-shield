/**
 * Spawn helpers for the local HTTP proxy used by `multicorn-shield files`.
 *
 * @module commands/local-proxy-start
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Poll interval while waiting for the proxy to accept connections. */
export const LOCAL_PROXY_READY_POLL_MS = 500;

/** Max polls before giving up (~15s at 500ms). */
export const LOCAL_PROXY_READY_MAX_POLLS = 30;

function multicornShieldPackageRoot(): string {
  try {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve("multicorn-shield/package.json"));
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  }
}

/**
 * Resolves the built proxy server entry (`dist/server.js`) shipped with multicorn-shield,
 * or from a linked `multicorn-proxy` install during monorepo development.
 */
export function resolveLocalProxyServerEntry(): string {
  const candidates: string[] = [join(multicornShieldPackageRoot(), "dist", "server.js")];

  try {
    const req = createRequire(import.meta.url);
    const proxyRoot = dirname(req.resolve("multicorn-proxy/package.json"));
    candidates.unshift(join(proxyRoot, "dist", "server.js"));
  } catch {
    // multicorn-proxy not installed; rely on bundled dist/server.js.
  }

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  throw new Error(
    "Local proxy server entry (dist/server.js) not found. Reinstall multicorn-shield or run pnpm build.",
  );
}

export interface LocalProxySpawnEnv {
  readonly PORT: string;
  readonly HOST: string;
  readonly SHIELD_API_BASE_URL: string;
  readonly ALLOW_PRIVATE_TARGETS: string;
}

/** Environment passed to the detached local proxy server process. */
export function buildLocalProxySpawnEnv(port: number, apiBaseUrl: string): LocalProxySpawnEnv {
  return {
    PORT: String(port),
    HOST: "127.0.0.1",
    SHIELD_API_BASE_URL: apiBaseUrl,
    ALLOW_PRIVATE_TARGETS: "true",
  };
}

export interface LocalProxySpawnCommand {
  /** Node executable (`process.execPath`). */
  readonly executable: string;
  /** Args: single entry is the resolved `dist/server.js` path. */
  readonly args: readonly [string];
  readonly env: LocalProxySpawnEnv;
  /** Absolute path to the server entry file (same as args[0]). */
  readonly serverEntryPath: string;
}

/**
 * Builds the spawn command for the local proxy server. Uses `process.execPath` against
 * `dist/server.js` directly; never the CLI bin or deprecated multicorn-proxy alias.
 */
export function buildLocalProxySpawnCommand(
  port: number,
  apiBaseUrl: string,
  execPath: string = process.execPath,
  serverEntryPath: string = resolveLocalProxyServerEntry(),
): LocalProxySpawnCommand {
  const env = buildLocalProxySpawnEnv(port, apiBaseUrl);
  return {
    executable: execPath,
    args: [serverEntryPath],
    env,
    serverEntryPath,
  };
}

/** Reads the tail of the proxy log for surfacing spawn failures. */
export function readProxyLogTail(logPath: string, maxBytes = 8000): string {
  try {
    const content = readFileSync(logPath, "utf8");
    if (content.length <= maxBytes) return content;
    return content.slice(-maxBytes);
  } catch {
    return "";
  }
}

/** Formats a fail-closed error when the local proxy did not become ready. */
export function formatLocalProxyStartError(
  port: number,
  logPath: string,
  childExited: boolean,
  exitCode: number | null,
): string {
  const logTail = readProxyLogTail(logPath);
  const reason = childExited
    ? `Proxy process exited early${exitCode === null ? "" : ` (code ${String(exitCode)})`}.`
    : `Proxy did not become ready on port ${String(port)} within the timeout.`;

  let message = `Could not start the local proxy on port ${String(port)}. ${reason}`;

  message +=
    logTail.length > 0
      ? `\n\nOutput from ${logPath}:\n${logTail.trimEnd()}`
      : `\n\nSee ${logPath} for details.`;

  return message;
}
