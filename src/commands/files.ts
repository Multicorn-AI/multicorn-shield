/**
 * `multicorn-shield files` subcommand.
 *
 * Stands up local filesystem governance for a coding agent in one command:
 * starts a local proxy (or reuses an existing one), starts a filesystem MCP
 * server scoped to <dir>, registers the agent, and prints a paste-ready
 * config block.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:net";

import {
  loadConfig,
  DEFAULT_SHIELD_API_BASE_URL,
  isAllowedShieldApiBaseUrl,
} from "../proxy/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilesCommandOptions {
  readonly dir: string;
  readonly agent: string;
  readonly port: number | undefined;
  readonly proxyPort: number | undefined;
  readonly apiKey: string | undefined;
  readonly baseUrl: string | undefined;
  readonly stop: boolean;
}

interface PidfileData {
  readonly agent: string;
  readonly fsServerPid: number | undefined;
  readonly proxyPid: number | undefined;
  readonly proxyPreExisting: boolean;
  readonly fsPort: number;
  readonly proxyPort: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FS_PORT = 3005;
const DEFAULT_PROXY_PORT = 3001;
const PIDFILE_DIR = join(homedir(), ".multicorn");

const style = {
  green: (s: string) => `\x1b[38;2;34;197;94m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[38;2;6;182;212m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pidfilePath(agent: string): string {
  return join(PIDFILE_DIR, `files-${agent}.pid`);
}

function writePidfile(data: PidfileData): void {
  mkdirSync(PIDFILE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(pidfilePath(data.agent), JSON.stringify(data), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function readPidfile(agent: string): PidfileData | null {
  const p = pidfilePath(agent);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PidfileData;
  } catch {
    return null;
  }
}

function removePidfile(agent: string): void {
  const p = pidfilePath(agent);
  try {
    unlinkSync(p);
  } catch {
    // Already gone
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createServer();
    sock.once("error", () => {
      sock.close();
      resolve(true);
    });
    sock.once("listening", () => {
      sock.close();
      resolve(false);
    });
    sock.listen(port, "127.0.0.1");
  });
}

async function probeProxyHealth(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Resolve config (api key + base URL)
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
}

async function resolveConfig(opts: FilesCommandOptions): Promise<ResolvedConfig> {
  // Priority: --api-key > env > config file
  const fromFlag = opts.apiKey;
  if (fromFlag && fromFlag.length > 0) {
    return {
      apiKey: fromFlag,
      baseUrl: opts.baseUrl ?? DEFAULT_SHIELD_API_BASE_URL,
    };
  }

  const envKey = process.env["MULTICORN_API_KEY"];
  if (typeof envKey === "string" && envKey.length > 0) {
    return {
      apiKey: envKey,
      baseUrl: opts.baseUrl ?? DEFAULT_SHIELD_API_BASE_URL,
    };
  }

  const config = await loadConfig();
  if (config !== null) {
    return {
      apiKey: config.apiKey,
      baseUrl: opts.baseUrl ?? config.baseUrl,
    };
  }

  process.stderr.write(
    "No API key found. Pass --api-key <key> or add it to ~/.multicorn/config.json.\n",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Start filesystem MCP server via supergateway
// ---------------------------------------------------------------------------

function startFsServer(dir: string, port: number): ChildProcess {
  const absDir = resolve(dir);
  const child = spawn(
    "npx",
    [
      "supergateway",
      "--stdio",
      `npx @modelcontextprotocol/server-filesystem ${absDir}`,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: { ...process.env },
    },
  );

  return child;
}

// ---------------------------------------------------------------------------
// Start local proxy (multicorn-proxy)
// ---------------------------------------------------------------------------

function startLocalProxy(port: number, apiBaseUrl: string): ChildProcess {
  const child = spawn("npx", ["multicorn-proxy"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SHIELD_API_BASE_URL: apiBaseUrl,
      // SAFETY: blanket-allow for private targets is acceptable ONLY because
      // this is a local single-user proxy. The only registered target is the
      // filesystem server on the same machine. Do NOT copy this pattern to a
      // multi-tenant or hosted proxy deployment.
      ALLOW_PRIVATE_TARGETS: "true",
    },
  });

  return child;
}

// ---------------------------------------------------------------------------
// Register agent + create proxy config
// ---------------------------------------------------------------------------

interface RegistrationResult {
  readonly proxyUrl: string;
}

async function registerAgentAndConfig(
  apiKey: string,
  baseUrl: string,
  agentName: string,
  fsPort: number,
): Promise<RegistrationResult> {
  const targetUrl = `http://127.0.0.1:${String(fsPort)}/mcp`;
  const serverName = `${agentName}-filesystem`;

  // Upsert proxy config (creates agent if needed, returns proxy_url with real token)
  const response = await fetch(`${baseUrl}/api/v1/proxy/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Multicorn-Key": apiKey,
    },
    body: JSON.stringify({
      server_name: serverName,
      target_url: targetUrl,
      platform: "other-mcp",
      agent_name: agentName,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    let detail = `HTTP ${String(response.status)}`;
    try {
      const body = (await response.json()) as Record<string, unknown>;
      const errObj = body["error"] as Record<string, unknown> | undefined;
      if (typeof errObj?.["message"] === "string") detail = errObj["message"];
      else if (typeof body["message"] === "string") detail = body["message"];
    } catch {
      // ignore
    }
    throw new Error(`Failed to register agent: ${detail}`);
  }

  const envelope = (await response.json()) as Record<string, unknown>;
  const data = envelope["data"] as Record<string, unknown> | undefined;
  const proxyUrl = typeof data?.["proxy_url"] === "string" ? data["proxy_url"] : "";

  if (proxyUrl.length === 0) {
    throw new Error("Registration succeeded but no proxy URL was returned.");
  }

  // Grant filesystem:read scope
  await grantScope(apiKey, baseUrl, agentName, "filesystem", "read");

  return { proxyUrl };
}

async function grantScope(
  apiKey: string,
  baseUrl: string,
  agentName: string,
  service: string,
  level: string,
): Promise<void> {
  // Find agent ID first
  const agentsResp = await fetch(`${baseUrl}/api/v1/agents`, {
    headers: { "X-Multicorn-Key": apiKey },
    signal: AbortSignal.timeout(8000),
  });

  if (!agentsResp.ok) return;

  const agentsBody = (await agentsResp.json()) as Record<string, unknown>;
  const agentsList = agentsBody["data"] as Record<string, unknown>[] | undefined;
  if (!Array.isArray(agentsList)) return;

  const agent = agentsList.find((a) => a["name"] === agentName);
  if (!agent || typeof agent["id"] !== "string") return;

  const agentId = agent["id"];

  // Grant scope
  await fetch(`${baseUrl}/api/v1/agents/${agentId}/scopes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Multicorn-Key": apiKey,
    },
    body: JSON.stringify({ service, permission_level: level }),
    signal: AbortSignal.timeout(8000),
  });
}

// ---------------------------------------------------------------------------
// Stop command
// ---------------------------------------------------------------------------

function runStop(agent: string): void {
  const data = readPidfile(agent);
  if (data === null) {
    process.stderr.write(`No running session found for agent "${agent}".\n`);
    process.exit(1);
  }

  let stopped = 0;

  if (data.fsServerPid && isProcessAlive(data.fsServerPid)) {
    process.kill(data.fsServerPid, "SIGTERM");
    stopped++;
  }

  // Only kill proxy if this session started it (not pre-existing)
  if (!data.proxyPreExisting && data.proxyPid && isProcessAlive(data.proxyPid)) {
    process.kill(data.proxyPid, "SIGTERM");
    stopped++;
  }

  removePidfile(agent);

  if (stopped === 0) {
    process.stderr.write("No processes to stop (they may have already exited).\n");
  } else {
    process.stderr.write(`Stopped ${String(stopped)} process${stopped > 1 ? "es" : ""}.\n`);
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runFilesCommand(opts: FilesCommandOptions): Promise<void> {
  // --stop: teardown only
  if (opts.stop) {
    runStop(opts.agent);
    return;
  }

  // Validate directory
  const absDir = resolve(opts.dir);
  if (!existsSync(absDir)) {
    process.stderr.write(`Directory not found: ${opts.dir}. Check the path and try again.\n`);
    process.exit(1);
  }

  // Validate base URL if provided
  if (opts.baseUrl && !isAllowedShieldApiBaseUrl(opts.baseUrl)) {
    process.stderr.write(
      "Error: --base-url must use HTTPS or http://localhost for local development.\n",
    );
    process.exit(1);
  }

  // Resolve config
  const config = await resolveConfig(opts);

  const fsPort = opts.port ?? DEFAULT_FS_PORT;
  const proxyPort = opts.proxyPort ?? DEFAULT_PROXY_PORT;

  // Clean up stale pidfile if processes are dead
  const existingPidfile = readPidfile(opts.agent);
  if (existingPidfile !== null) {
    const fsAlive = existingPidfile.fsServerPid && isProcessAlive(existingPidfile.fsServerPid);
    const proxyAlive = existingPidfile.proxyPid && isProcessAlive(existingPidfile.proxyPid);
    if (!fsAlive && !proxyAlive) {
      removePidfile(opts.agent);
    } else {
      process.stderr.write(
        `A session for agent "${opts.agent}" is already running. ` +
          `Run with --stop first, or use a different --agent name.\n`,
      );
      process.exit(1);
    }
  }

  // --- Local proxy ---
  let proxyPreExisting = false;
  let proxyChild: ChildProcess | null = null;

  const proxyHealthy = await probeProxyHealth(proxyPort);
  if (proxyHealthy) {
    proxyPreExisting = true;
  } else {
    const portBusy = await isPortListening(proxyPort);
    if (portBusy) {
      process.stderr.write(
        `A server is already running on port ${String(proxyPort)} but it's not a healthy Shield proxy. ` +
          `Stop the existing server or re-run with --proxy-port <n>.\n`,
      );
      process.exit(1);
    }

    proxyChild = startLocalProxy(proxyPort, config.baseUrl);

    // Wait for proxy to be ready
    let proxyReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await probeProxyHealth(proxyPort)) {
        proxyReady = true;
        break;
      }
    }
    if (!proxyReady) {
      proxyChild.kill("SIGTERM");
      process.stderr.write(
        `Could not start the local proxy on port ${String(proxyPort)}. Check if another process is using that port.\n`,
      );
      process.exit(1);
    }
  }

  // --- Filesystem MCP server ---
  const fsPortBusy = await isPortListening(fsPort);
  if (fsPortBusy) {
    if (proxyChild) proxyChild.kill("SIGTERM");
    process.stderr.write(
      `A server is already running on port ${String(fsPort)}. ` +
        `Re-run with --port <n> to use a different port, or stop the existing server.\n`,
    );
    process.exit(1);
  }

  const fsChild = startFsServer(absDir, fsPort);

  // Wait for fs server to be ready
  let fsReady = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isPortListening(fsPort)) {
      fsReady = true;
      break;
    }
  }
  if (!fsReady) {
    fsChild.kill("SIGTERM");
    if (proxyChild) proxyChild.kill("SIGTERM");
    process.stderr.write(
      `Filesystem server failed to start on port ${String(fsPort)}. Check the directory path and try again.\n`,
    );
    process.exit(1);
  }

  // --- Register agent ---
  let registration: RegistrationResult;
  try {
    registration = await registerAgentAndConfig(config.apiKey, config.baseUrl, opts.agent, fsPort);
  } catch (error) {
    fsChild.kill("SIGTERM");
    if (proxyChild) proxyChild.kill("SIGTERM");
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Registration failed: ${msg}\n`);
    process.exit(1);
  }

  // --- Write pidfile ---
  writePidfile({
    agent: opts.agent,
    fsServerPid: fsChild.pid,
    proxyPid: proxyChild?.pid,
    proxyPreExisting,
    fsPort,
    proxyPort,
  });

  // --- Ctrl-C / SIGTERM cleanup ---
  const cleanup = (): void => {
    fsChild.kill("SIGTERM");
    if (!proxyPreExisting && proxyChild) {
      proxyChild.kill("SIGTERM");
    }
    removePidfile(opts.agent);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Handle child exits (don't crash parent)
  fsChild.on("exit", () => {
    /* intentional no-op */
  });
  proxyChild?.on("exit", () => {
    /* intentional no-op */
  });

  // --- Output ---
  const dirLabel = `./${basename(absDir)}`;
  const proxyUrl = registration.proxyUrl;

  process.stderr.write("\n");
  process.stderr.write(`  ${style.green("\u2713")} Local proxy running (:${String(proxyPort)})\n`);
  process.stderr.write(
    `  ${style.green("\u2713")} Filesystem server on ${dirLabel} (:${String(fsPort)})\n`,
  );
  process.stderr.write(
    `  ${style.green("\u2713")} Agent '${opts.agent}' registered - filesystem read granted\n`,
  );
  process.stderr.write("\n");
  process.stderr.write("  Paste this into your coding agent's MCP config:\n\n");

  const configBlock = JSON.stringify(
    {
      mcpServers: {
        [opts.agent]: {
          url: proxyUrl,
        },
      },
    },
    null,
    2,
  );

  process.stderr.write(style.cyan(configBlock) + "\n\n");
  process.stderr.write(style.dim("  Write and delete will ask for approval the first time.\n"));
  process.stderr.write(
    style.dim(`  Stop with: npx multicorn-shield files ${opts.dir} --agent ${opts.agent} --stop\n`),
  );
  process.stderr.write("\n");
}
