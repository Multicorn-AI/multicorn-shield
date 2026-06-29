/**
 * `multicorn-shield files` subcommand.
 *
 * Stands up local filesystem governance for a coding agent in one command:
 * starts a local proxy (or reuses an existing one), starts a filesystem MCP
 * server scoped to <dir>, registers the agent, and prints a paste-ready
 * config block.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

import {
  loadConfig,
  readBaseUrlFromConfig,
  DEFAULT_SHIELD_API_BASE_URL,
  isAllowedShieldApiBaseUrl,
  detectInstalledClients,
  writeLocalMcpEntry,
  hostedProxyUrlWithKeyParam,
  clientDisplayName,
  clientReloadInstruction,
  CODING_CLIENTS,
  type CodingClient,
} from "../proxy/config.js";
import {
  buildLocalProxySpawnCommand,
  formatLocalProxyStartError,
  LOCAL_PROXY_READY_MAX_POLLS,
  LOCAL_PROXY_READY_POLL_MS,
} from "./local-proxy-start.js";

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
  readonly client: string | undefined;
  readonly foreground: boolean;
  readonly status: boolean;
  // Stop (if running) then start again. Start re-derives the agent's MCP config
  // entry every run, so restart is the universal remedy for a stale on-disk entry.
  readonly restart: boolean;
  /** When true, kill and respawn the shared proxy even if one is already healthy. */
  readonly respawnProxy: boolean;
}

interface PidfileData {
  readonly agent: string;
  // Realpath'd governed folder. This is the canonical folder identity used to
  // dedup filesystem servers, so it must always be the resolved real path.
  readonly dir: string;
  // The per-agent supervisor: the long-lived `--foreground` process that sends
  // the liveness heartbeat. It no longer owns the proxy or fs server (those are
  // independent, refcounted shared resources). Agent liveness == this pid alive.
  readonly supervisorPid: number;
  readonly fsPort: number;
  readonly proxyPort: number;
}

/** Legacy pidfiles stored the supervisor pid under `pid` before supervisorPid existed. */
type PidfileDataOnDisk = PidfileData & { readonly pid?: number };

// One shared proxy across all local agents.
interface ProxyRegistry {
  readonly pid: number;
  readonly port: number;
}

// One filesystem server per distinct (realpath'd) folder, shared by every agent
// that governs that folder.
interface FsServerEntry {
  readonly pid: number;
  readonly port: number;
}
type FsRegistry = Record<string, FsServerEntry>;

interface LockData {
  readonly pid: number;
  readonly ts: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FS_PORT = 3005;
const DEFAULT_PROXY_PORT = 3001;
// Overridable for tests so they never touch the real ~/.multicorn.
const PIDFILE_DIR = process.env["MULTICORN_HOME"] ?? join(homedir(), ".multicorn");

// Shared-resource registries (resource -> PID) so teardown can find and kill them.
const PROXY_REGISTRY = join(PIDFILE_DIR, "proxy.json");
const FS_REGISTRY = join(PIDFILE_DIR, "fs-servers.json");

// Serialises resource start AND teardown so concurrent `files` runs/stops never
// double-spawn or double-kill.
const LOCK_PATH = join(PIDFILE_DIR, ".resources.lock");
// How long to wait for another holder before giving up. Generous because a legit
// start holds the lock through proxy/fs readiness (~15s, longer on first npx fetch).
const LOCK_WAIT_MS = 60_000;
// A lock whose holder is dead is reclaimed immediately; this ts backstop covers the
// rare case where the holder PID was reused by an unrelated process.
const LOCK_STALE_MS = 120_000;
const FS_PORT_SCAN_RANGE = 200;

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
    return JSON.parse(readFileSync(p, "utf8")) as PidfileDataOnDisk;
  } catch {
    return null;
  }
}

function supervisorPidFromSession(data: PidfileDataOnDisk): number | undefined {
  if (typeof data.supervisorPid === "number") return data.supervisorPid;
  if (typeof data.pid === "number") return data.pid;
  return undefined;
}

/** True only when the pidfile's supervisor process is still alive. */
export function isAgentSessionRunning(data: PidfileData | null): boolean {
  if (data === null) return false;
  const pid = supervisorPidFromSession(data as PidfileDataOnDisk);
  return typeof pid === "number" && isProcessAlive(pid);
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

function listAllPidfiles(): PidfileData[] {
  if (!existsSync(PIDFILE_DIR)) return [];
  const files = readdirSync(PIDFILE_DIR).filter(
    (f) => f.startsWith("files-") && f.endsWith(".pid"),
  );
  const results: PidfileData[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(PIDFILE_DIR, f), "utf8")) as PidfileData;
      results.push(data);
    } catch {
      // Skip corrupt pidfiles
    }
  }
  return results;
}

function runStatus(): void {
  const sessions = listAllPidfiles();
  if (sessions.length === 0) {
    process.stderr.write("No active file-sharing sessions.\n");
    return;
  }

  const proxyReg = readProxyRegistry();
  const fsReg = readFsRegistry();

  process.stderr.write("Active sessions:\n\n");
  for (const s of sessions) {
    const supervisorAlive = isAgentSessionRunning(s);
    const fsEntry = fsReg[s.dir];
    const fsAlive = fsEntry !== undefined && isProcessAlive(fsEntry.pid);
    const proxyAlive =
      proxyReg !== null && proxyReg.port === s.proxyPort && isProcessAlive(proxyReg.pid);
    const agentStatus = supervisorAlive ? style.green("running") : style.dim("stopped");

    process.stderr.write(`  ${style.bold(s.agent)} ${agentStatus}\n`);
    process.stderr.write(`    Folder: ${s.dir || "(unknown)"}\n`);
    process.stderr.write(
      `    FS server: :${String(s.fsPort)} ${fsAlive ? style.green("running") : style.dim("stopped")}\n`,
    );
    process.stderr.write(
      `    Proxy: :${String(s.proxyPort)} ${proxyAlive ? style.green("running") : style.dim("stopped")}\n`,
    );
    process.stderr.write("\n");

    // A dead supervisor means this agent session is gone. Clean its stale pidfile;
    // any shared resources it referenced are reclaimed by refcount when the last
    // live agent stops (or here, if nothing else references them).
    if (!supervisorAlive) {
      removePidfile(s.agent);
      process.stderr.write(style.dim(`    (cleaned up stale pidfile)\n\n`));
    }
  }
}

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
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

/**
 * Reads the proxy's reported version from its /health endpoint. Returns null if the
 * proxy is unreachable or doesn't report one (older proxy). The supervisor forwards
 * this on the heartbeat so the backend learns the running version even when no editor
 * is actively connected through the proxy.
 */
async function readProxyVersion(port: number): Promise<string | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version.length > 0 ? body.version : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Shared-resource registries (proxy + per-folder fs servers)
// ---------------------------------------------------------------------------

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(PIDFILE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
}

function readProxyRegistry(): ProxyRegistry | null {
  return readJsonFile(PROXY_REGISTRY) as ProxyRegistry | null;
}

function readFsRegistry(): FsRegistry {
  return (readJsonFile(FS_REGISTRY) as FsRegistry | null) ?? {};
}

/**
 * Canonical folder identity for fs-server dedup. realpath resolves symlinks and
 * relative paths so `./repo`, `repo/`, and a symlink to repo collapse to one
 * identity - while two genuinely different folders can never collide (which would
 * be a cross-folder file-exposure bug). Falls back to resolve() if the path can't
 * be realpath'd yet (caller validates existence separately).
 */
export function canonicalFolder(dir: string): string {
  const abs = resolve(dir);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

// ---------------------------------------------------------------------------
// Start lock (race-safe resource start + teardown)
// ---------------------------------------------------------------------------

function readLock(): LockData | null {
  return readJsonFile(LOCK_PATH) as LockData | null;
}

/**
 * A lock is stale (safe to steal) when its holder process is gone, or - as a
 * backstop against PID reuse - when it's far older than any legitimate hold.
 * This is what stops a process that crashed mid-start from wedging every future run.
 */
export function isLockStale(holder: LockData | null, now: number = Date.now()): boolean {
  if (holder === null) return true;
  if (!isProcessAlive(holder.pid)) return true;
  return now - holder.ts > LOCK_STALE_MS;
}

export async function acquireResourceLock(): Promise<void> {
  mkdirSync(PIDFILE_DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      // wx: atomic create-or-fail. Only one process wins the race.
      writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, ts: Date.now() }), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return;
    } catch {
      const holder = readLock();
      if (isLockStale(holder)) {
        // Holder crashed (or never finished). Reclaim and retry.
        try {
          unlinkSync(LOCK_PATH);
        } catch {
          // Someone else reclaimed it first; just retry.
        }
        continue;
      }
      if (Date.now() > deadline) {
        // Last resort: a live holder has been stuck past the wait window. Steal
        // rather than wedge forever, then retry.
        try {
          unlinkSync(LOCK_PATH);
        } catch {
          // ignore
        }
        continue;
      }
      await sleep(100);
    }
  }
}

export function releaseResourceLock(): void {
  // Only delete the lock if we still hold it - never clobber a lock another
  // process acquired after ours was (legitimately) stolen.
  const holder = readLock();
  if (holder !== null && holder.pid === process.pid) {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      // already gone
    }
  }
}

async function withResourceLock<T>(fn: () => T | Promise<T>): Promise<T> {
  await acquireResourceLock();
  try {
    return await fn();
  } finally {
    releaseResourceLock();
  }
}

// ---------------------------------------------------------------------------
// Refcount: derived from live agent pidfiles (no stored counter to drift)
// ---------------------------------------------------------------------------

/** Agents whose supervisor process is still alive. A dead supervisor pins nothing. */
function liveAgents(): PidfileData[] {
  return listAllPidfiles().filter((p) => isAgentSessionRunning(p));
}

export function agentsReferencingProxy(
  proxyPort: number,
  agents: readonly PidfileData[],
  excludeAgent?: string,
): PidfileData[] {
  return agents.filter((a) => a.agent !== excludeAgent && a.proxyPort === proxyPort);
}

export function agentsReferencingFolder(
  folder: string,
  agents: readonly PidfileData[],
  excludeAgent?: string,
): PidfileData[] {
  return agents.filter((a) => a.agent !== excludeAgent && a.dir === folder);
}

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

/**
 * Picks the first free port at/after `start`, skipping ports already claimed by
 * known fs servers and any port currently listening. `isBusy` is injected so the
 * pure scan logic is testable without real sockets.
 */
export async function nextFreePort(
  start: number,
  claimed: ReadonlySet<number>,
  isBusy: (port: number) => Promise<boolean>,
  range: number = FS_PORT_SCAN_RANGE,
): Promise<number> {
  for (let port = start; port < start + range; port++) {
    if (claimed.has(port)) continue;
    if (await isBusy(port)) continue;
    return port;
  }
  throw new Error(
    `No free port for the filesystem server in range ${String(start)}-${String(start + range)}.`,
  );
}

// ---------------------------------------------------------------------------
// Resolve config (api key + base URL)
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
}

/**
 * Shield API base URL for `files`: `--base-url` > `MULTICORN_BASE_URL` >
 * config.json `baseUrl` > production default.
 */
export async function resolveBaseUrl(explicitBaseUrl?: string): Promise<string> {
  if (explicitBaseUrl !== undefined && explicitBaseUrl.trim().length > 0) {
    return explicitBaseUrl.trim();
  }

  const envBaseUrl = process.env["MULTICORN_BASE_URL"];
  if (typeof envBaseUrl === "string" && envBaseUrl.trim().length > 0) {
    return envBaseUrl.trim();
  }

  const config = await loadConfig();
  if (config !== null && config.baseUrl.length > 0) {
    return config.baseUrl;
  }

  const fromFile = await readBaseUrlFromConfig();
  if (fromFile !== undefined && fromFile.length > 0) {
    return fromFile;
  }

  return DEFAULT_SHIELD_API_BASE_URL;
}

async function resolveConfig(opts: FilesCommandOptions): Promise<ResolvedConfig> {
  const baseUrl = await resolveBaseUrl(opts.baseUrl);

  // Priority: --api-key > env > config file
  const fromFlag = opts.apiKey;
  if (fromFlag && fromFlag.length > 0) {
    return { apiKey: fromFlag, baseUrl };
  }

  const envKey = process.env["MULTICORN_API_KEY"];
  if (typeof envKey === "string" && envKey.length > 0) {
    return { apiKey: envKey, baseUrl };
  }

  const config = await loadConfig();
  if (config !== null) {
    return { apiKey: config.apiKey, baseUrl };
  }

  process.stderr.write(
    "No API key found. Pass --api-key <key> or add it to ~/.multicorn/config.json.\n",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Start filesystem MCP server via supergateway
// ---------------------------------------------------------------------------

/**
 * Starts a filesystem MCP server as an INDEPENDENT detached process (its own
 * process group), so it survives the agent supervisor that started it and can be
 * shared by other agents on the same folder. Output goes to a per-port log file.
 */
function startFsServerDetached(realDir: string, port: number): ChildProcess {
  mkdirSync(PIDFILE_DIR, { recursive: true, mode: 0o700 });
  const logFile = join(PIDFILE_DIR, `fs-${String(port)}.log`);
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");
  const child = spawn(
    "npx",
    [
      "supergateway",
      // Serve the child over streamable HTTP at /mcp. Without this, supergateway
      // defaults to SSE (/sse + /message), but the proxy registers the target as
      // /mcp - the mismatch makes every request 404 with "Cannot POST /mcp".
      "--outputTransport",
      "streamableHttp",
      "--stdio",
      `npx @modelcontextprotocol/server-filesystem ${realDir}`,
      "--port",
      String(port),
    ],
    {
      stdio: ["ignore", out, err],
      detached: true,
      env: { ...process.env },
    },
  );
  child.unref();
  return child;
}

// ---------------------------------------------------------------------------
// Start local proxy (dist/server.js)
// ---------------------------------------------------------------------------

/**
 * Starts the shared local proxy as an INDEPENDENT detached process so it survives
 * the agent that happened to start it. Lifecycle is managed via the proxy registry
 * + refcount, not parent-child. Output goes to a log file.
 */
function startLocalProxyDetached(port: number, apiBaseUrl: string): ChildProcess {
  mkdirSync(PIDFILE_DIR, { recursive: true, mode: 0o700 });
  const logFile = join(PIDFILE_DIR, "proxy.log");
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");
  const { executable, args, env: proxyEnv } = buildLocalProxySpawnCommand(port, apiBaseUrl);
  const child = spawn(executable, [...args], {
    stdio: ["ignore", out, err],
    detached: true,
    env: {
      ...process.env,
      ...proxyEnv,
      // SAFETY: blanket-allow for private targets is acceptable ONLY because
      // this is a local single-user proxy. The only registered target is the
      // filesystem server on the same machine. Do NOT copy this pattern to a
      // multi-tenant or hosted proxy deployment.
    },
  });
  child.unref();
  return child;
}

// ---------------------------------------------------------------------------
// Ensure / release shared resources (run inside withResourceLock)
// ---------------------------------------------------------------------------

interface EnsureProxyResult {
  // True when this call did not start the proxy (reused an existing one).
  readonly reused: boolean;
  // True when the proxy is managed by us (present in the registry). An externally
  // run proxy (e.g. `pnpm local`) is reused but never killed by teardown.
  readonly managed: boolean;
}

interface EnsureProxyOptions {
  readonly forceRespawn?: boolean;
}

async function ensureProxy(
  proxyPort: number,
  apiBaseUrl: string,
  options?: EnsureProxyOptions,
): Promise<EnsureProxyResult> {
  const forceRespawn = options?.forceRespawn === true;

  if (forceRespawn) {
    const reg = readProxyRegistry();
    if (reg !== null && reg.port === proxyPort && isProcessAlive(reg.pid)) {
      killWithEscalation(reg.pid, true);
    }
    if (reg !== null && reg.port === proxyPort) {
      try {
        unlinkSync(PROXY_REGISTRY);
      } catch {
        // ignore
      }
    }
    for (let i = 0; i < 20; i++) {
      if (!(await isPortListening(proxyPort))) break;
      await sleep(100);
    }
  } else if (await probeProxyHealth(proxyPort)) {
    const reg = readProxyRegistry();
    const managed = reg !== null && reg.port === proxyPort && isProcessAlive(reg.pid);
    return { reused: true, managed };
  }

  // Not healthy. Clear a dead registry entry if present.
  const reg = readProxyRegistry();
  if (reg !== null && !isProcessAlive(reg.pid)) {
    try {
      unlinkSync(PROXY_REGISTRY);
    } catch {
      // ignore
    }
  }

  if (await isPortListening(proxyPort)) {
    throw new Error(
      `A server is already running on port ${String(proxyPort)} but it's not a healthy Shield proxy. ` +
        `Stop it or re-run with --proxy-port <n>.`,
    );
  }

  const logFile = join(PIDFILE_DIR, "proxy.log");
  const child = startLocalProxyDetached(proxyPort, apiBaseUrl);

  for (let i = 0; i < LOCAL_PROXY_READY_MAX_POLLS; i++) {
    await sleep(LOCAL_PROXY_READY_POLL_MS);
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (await probeProxyHealth(proxyPort)) {
      if (child.pid !== undefined) {
        writeJsonFile(PROXY_REGISTRY, { pid: child.pid, port: proxyPort });
      }
      return { reused: false, managed: true };
    }
  }

  try {
    if (child.pid !== undefined) killWithEscalation(child.pid, true);
  } catch {
    // ignore
  }
  const childExited = child.exitCode !== null || child.signalCode !== null;
  throw new Error(formatLocalProxyStartError(proxyPort, logFile, childExited, child.exitCode));
}

interface EnsureFsResult {
  readonly port: number;
  readonly reused: boolean;
}

async function ensureFsServer(
  realDir: string,
  requestedPort: number | undefined,
): Promise<EnsureFsResult> {
  const reg = readFsRegistry();
  const existing = reg[realDir];

  // Reuse a live fs server already serving this exact folder.
  if (
    existing !== undefined &&
    isProcessAlive(existing.pid) &&
    (await isPortListening(existing.port))
  ) {
    return { port: existing.port, reused: true };
  }

  // Drop a stale entry (process gone) before starting fresh.
  if (existing !== undefined) {
    const rest = Object.fromEntries(Object.entries(reg).filter(([k]) => k !== realDir));
    writeJsonFile(FS_REGISTRY, rest);
  }

  let port: number;
  if (requestedPort !== undefined) {
    if (await isPortListening(requestedPort)) {
      throw new Error(
        `A server is already running on port ${String(requestedPort)}. ` +
          `Re-run without --port to auto-pick a free port, or choose another.`,
      );
    }
    port = requestedPort;
  } else {
    const claimed = new Set(Object.values(readFsRegistry()).map((e) => e.port));
    port = await nextFreePort(DEFAULT_FS_PORT, claimed, isPortListening);
  }

  const child = startFsServerDetached(realDir, port);
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await isPortListening(port)) {
      ready = true;
      break;
    }
  }
  if (!ready) {
    try {
      if (child.pid !== undefined) killWithEscalation(child.pid, true);
    } catch {
      // ignore
    }
    throw new Error(
      `Filesystem server failed to start on port ${String(port)}. ` +
        `Check the directory path and the log at ${join(PIDFILE_DIR, `fs-${String(port)}.log`)}.`,
    );
  }

  if (child.pid !== undefined) {
    const next = readFsRegistry();
    next[realDir] = { pid: child.pid, port };
    writeJsonFile(FS_REGISTRY, next);
  }
  return { port, reused: false };
}

/** Kills the shared proxy only if no live agent still references it. Lock-held. */
function releaseProxyIfUnused(proxyPort: number, stoppingAgent: string): void {
  const remaining = agentsReferencingProxy(proxyPort, liveAgents(), stoppingAgent);
  if (remaining.length > 0) return;

  const reg = readProxyRegistry();
  if (reg !== null && reg.port === proxyPort && isProcessAlive(reg.pid)) {
    killWithEscalation(reg.pid, true);
  }
  if (reg !== null && reg.port === proxyPort) {
    try {
      unlinkSync(PROXY_REGISTRY);
    } catch {
      // ignore
    }
  }
}

/** Kills a folder's fs server only if no live agent still references it. Lock-held. */
function releaseFsServerIfUnused(folder: string, stoppingAgent: string): void {
  const remaining = agentsReferencingFolder(folder, liveAgents(), stoppingAgent);
  if (remaining.length > 0) return;

  const reg = readFsRegistry();
  const entry = reg[folder];
  if (entry === undefined) return;
  if (isProcessAlive(entry.pid)) {
    killWithEscalation(entry.pid, true);
  }
  const rest = Object.fromEntries(Object.entries(reg).filter(([k]) => k !== folder));
  writeJsonFile(FS_REGISTRY, rest);
}

// ---------------------------------------------------------------------------
// Register agent + create proxy config
// ---------------------------------------------------------------------------

interface RegistrationResult {
  readonly proxyUrl: string;
  readonly pathSegment: string;
}

/**
 * Logical MCP server name for a proxy row. MUST match the dashboard's
 * handoffProxyServerSlug so a `files` registration converges on the SAME backend row as a
 * hosted (gmail/calendar) setup for the same agent. That convergence is what lets one agent
 * hold both local files and hosted services instead of overwriting one with the other.
 */
export function proxyServerSlug(agentLabel: string): string {
  const t = agentLabel.trim().toLowerCase();
  const slug = t.replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (slug === "") return "shield-handoff-agent";
  if (!/^[a-z0-9]/i.test(slug)) return `a-${slug}`;
  return slug.slice(0, 180);
}

async function registerAgentAndConfig(
  apiKey: string,
  baseUrl: string,
  agentName: string,
  fsPort: number,
  localDir: string,
): Promise<RegistrationResult> {
  const targetUrl = `http://127.0.0.1:${String(fsPort)}/mcp`;
  // Same slug the dashboard uses, so this merges into the agent's existing row (if any)
  // rather than creating a separate one or clobbering a hosted gmail target.
  const serverName = proxyServerSlug(agentName);

  // Upsert proxy config (creates agent if needed, returns proxy_url with real token).
  // local_dir is the governed folder, persisted so the dashboard can build an exact
  // reconnect command if this service dies.
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
      local_dir: localDir,
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

  // Extract the path segment (e.g. "/r/abc123?key=xyz") from the hosted URL
  // so we can reconstruct it against the actual local proxy base.
  let pathSegment = "";
  try {
    const parsed = new URL(proxyUrl);
    pathSegment = parsed.pathname + parsed.search;
  } catch {
    pathSegment = proxyUrl;
  }

  // Grant filesystem:read scope
  await grantScope(apiKey, baseUrl, agentName, "filesystem", "read");

  return { proxyUrl, pathSegment };
}

// Heartbeat cadence. The dashboard marks an agent "not connected" after ~2 missed
// beats (see LIVENESS_STALE_MS in the dashboard); keep these in sync.
const HEARTBEAT_INTERVAL_MS = 30_000;

// Best-effort liveness ping. Only call this once both the proxy and fs server are
// confirmed healthy, so the signal reflects real health, not just "a process exists".
// Swallows all errors: a failed heartbeat must never crash the supervisor.
async function sendHeartbeat(
  apiKey: string,
  baseUrl: string,
  serverName: string,
  proxyVersion: string | null,
): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/v1/proxy/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Multicorn-Key": apiKey,
      },
      // proxy_version lets the backend stamp the agent's last-seen version + timestamp
      // from the heartbeat, so the dashboard can flag an out-of-date proxy that needs a
      // restart even if the editor never connects through it.
      body: JSON.stringify(
        proxyVersion !== null
          ? { server_name: serverName, proxy_version: proxyVersion }
          : { server_name: serverName },
      ),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Transient failure (network blip, backend restart). The dashboard's stale
    // threshold tolerates a couple of missed beats, so we just try again next tick.
  }
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

function killWithEscalation(pid: number, group = false): void {
  // Detached resources are process-group leaders; killing the group (-pid) takes
  // down npx -> supergateway -> server-filesystem grandchildren too, not just the
  // leader. Fall back to the plain pid if the group signal isn't deliverable.
  const signal = (sig: NodeJS.Signals): void => {
    if (group) {
      try {
        process.kill(-pid, sig);
        return;
      } catch {
        // group gone or not a leader; fall through to single-pid
      }
    }
    process.kill(pid, sig);
  };

  try {
    signal("SIGTERM");
  } catch {
    return;
  }

  // Wait up to 3s for process to exit, then SIGKILL
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    spawnSync("sleep", ["0.1"], { stdio: "ignore" });
  }

  try {
    signal("SIGKILL");
  } catch {
    // Already gone
  }
}

async function runStop(agent: string): Promise<void> {
  const data = readPidfile(agent);
  if (data === null) {
    process.stderr.write(`No running session found for agent "${agent}".\n`);
    process.exit(1);
  }

  // The whole stop is lock-held so two near-simultaneous stops can't both decide a
  // shared resource is "unused" and double-kill it, nor both defer and orphan it.
  // Each stop removes its own pidfile before the refcount scan, so the second stop
  // sees the first already gone.
  await withResourceLock(() => {
    // Stop this agent's supervisor (the heartbeat process).
    const supervisorPid = supervisorPidFromSession(data as PidfileDataOnDisk);
    if (typeof supervisorPid === "number" && isProcessAlive(supervisorPid)) {
      killWithEscalation(supervisorPid);
    }
    removePidfile(agent);

    // Refcounted teardown: only kill shared resources no live agent still needs.
    releaseFsServerIfUnused(data.dir, agent);
    releaseProxyIfUnused(data.proxyPort, agent);
  });

  process.stderr.write(`Stopped agent "${agent}".\n`);
}

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

/**
 * Stop (if running) then start the agent again. The point is repair: `start`
 * re-derives and rewrites the agent's MCP config entry from current logic on
 * every run, so a restart fixes a stale on-disk entry (e.g. one written before
 * the API-key fix) that a process bounce alone would leave untouched.
 *
 * Restart owns no config logic of its own - it just runs stop then start. We
 * recover the governed folder from the existing session so `files restart
 * --agent X` works without re-typing the path; only that single agent is touched.
 */
async function runRestart(opts: FilesCommandOptions): Promise<void> {
  if (opts.agent.length === 0) {
    process.stderr.write("Error: --agent <name> is required for restart.\n");
    process.exit(1);
  }

  const existing = readPidfile(opts.agent);
  // Prefer an explicit folder; otherwise reuse the one this agent last ran with.
  const dir = opts.dir.length > 0 ? opts.dir : (existing?.dir ?? "");
  if (dir.length === 0) {
    process.stderr.write(
      `Don't know which folder to restart agent "${opts.agent}" with.\n` +
        `Run it once with the folder: npx multicorn-shield files restart <dir> --agent ${opts.agent}\n`,
    );
    process.exit(1);
  }

  // Stop only if there's a session to stop (runStop exits if there isn't).
  if (existing !== null) {
    await runStop(opts.agent);
  }

  // Hand off to the normal start path, which re-derives the config entry.
  await runDetached({
    ...opts,
    dir,
    proxyPort: opts.proxyPort ?? existing?.proxyPort,
    stop: false,
    status: false,
    restart: false,
    respawnProxy: true,
    foreground: false,
  });
}

// ---------------------------------------------------------------------------
// Detached mode
// ---------------------------------------------------------------------------

async function runDetached(opts: FilesCommandOptions): Promise<void> {
  const absDir = resolve(opts.dir);
  if (!existsSync(absDir)) {
    process.stderr.write(`Directory not found: ${opts.dir}. Check the path and try again.\n`);
    process.exit(1);
  }

  // Check if already running (supervisor alive for this agent).
  const existing = readPidfile(opts.agent);
  if (existing !== null) {
    if (isAgentSessionRunning(existing)) {
      process.stderr.write(
        `Already running for agent "${opts.agent}" (fs :${String(existing.fsPort)}, proxy :${String(existing.proxyPort)}).\n` +
          `Stop with: npx multicorn-shield files stop --agent ${opts.agent}\n`,
      );
      return;
    }
    removePidfile(opts.agent);
  }

  // Build args for the child (foreground mode so it stays alive)
  const args: string[] = ["files", absDir, "--agent", opts.agent, "--foreground"];
  if (opts.port !== undefined) args.push("--port", String(opts.port));
  if (opts.proxyPort !== undefined) args.push("--proxy-port", String(opts.proxyPort));
  if (opts.apiKey !== undefined) args.push("--api-key", opts.apiKey);
  if (opts.baseUrl !== undefined) args.push("--base-url", opts.baseUrl);
  if (opts.respawnProxy) args.push("--respawn-proxy");
  if (opts.client !== undefined) args.push("--client", opts.client);

  // Use the same script that was invoked (process.argv[1])
  const scriptPath = process.argv[1] ?? resolve("dist/multicorn-shield.js");
  const logFile = join(PIDFILE_DIR, `files-${opts.agent}.log`);
  mkdirSync(PIDFILE_DIR, { recursive: true, mode: 0o700 });

  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");

  const child = spawn(process.execPath, [scriptPath, ...args], {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env },
  });

  child.unref();

  // The supervisor writes its pidfile only after the proxy and fs server are ready
  // (which can take a while on first run while npx fetches packages). Poll for it.
  let pidData: PidfileData | null = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    pidData = readPidfile(opts.agent);
    if (pidData !== null) break;
    // If the child died before writing its pidfile, stop waiting.
    if (child.pid !== undefined && !isProcessAlive(child.pid)) break;
  }
  if (pidData === null) {
    process.stderr.write(`Failed to start in background. Check logs: ${logFile}\n`);
    process.exit(1);
  }

  process.stderr.write("\n");
  process.stderr.write(
    `  ${style.green("\u2713")} Setup complete. Shield is running in the background.\n`,
  );
  process.stderr.write(`  ${style.green("\u2713")} Folder: ${absDir}\n`);
  process.stderr.write(
    `  ${style.green("\u2713")} FS server :${String(pidData.fsPort)}, Proxy :${String(pidData.proxyPort)}\n`,
  );
  process.stderr.write("\n");
  process.stderr.write(`  Stop it any time with:\n`);
  process.stderr.write(
    `    ${style.cyan(`npx multicorn-shield files stop --agent ${opts.agent}`)}\n`,
  );
  process.stderr.write("\n");
  process.stderr.write(style.dim(`  Status: npx multicorn-shield files status\n`));
  process.stderr.write(style.dim(`  Logs:   ${logFile}\n`));
  process.stderr.write("\n");
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runFilesCommand(opts: FilesCommandOptions): Promise<void> {
  // status: show what's running
  if (opts.status) {
    runStatus();
    return;
  }

  // restart: stop (if running) then start. Start rewrites the config entry, so
  // restart inherits that repair for free - it needs no config logic of its own.
  if (opts.restart) {
    await runRestart(opts);
    return;
  }

  // --stop: teardown only
  if (opts.stop) {
    await runStop(opts.agent);
    return;
  }

  // Default: detach and exit. --foreground keeps the terminal open (debugging).
  if (!opts.foreground) {
    await runDetached(opts);
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

  // Canonical folder identity for fs-server dedup (realpath: resolves symlinks and
  // relative paths so the same folder always maps to one fs server, and two
  // different folders can never collide).
  const realDir = canonicalFolder(absDir);
  const proxyPort = opts.proxyPort ?? DEFAULT_PROXY_PORT;

  // Already running for this agent?
  const existingPidfile = readPidfile(opts.agent);
  if (existingPidfile !== null) {
    if (isAgentSessionRunning(existingPidfile)) {
      process.stderr.write(
        `A session for agent "${opts.agent}" is already running. ` +
          `Run 'files stop --agent ${opts.agent}' first, or use a different --agent name.\n`,
      );
      process.exit(1);
    }
    removePidfile(opts.agent);
  }

  // Ensure the shared proxy and the per-folder fs server exist, then record this
  // agent - all under the resource lock so two concurrent starts can't both decide
  // to spawn a proxy/fs server for the same port/folder.
  let fsPort: number;
  let proxyReused: boolean;
  let fsReused: boolean;
  try {
    const ensured = await withResourceLock(async () => {
      const proxyRes = await ensureProxy(proxyPort, config.baseUrl, {
        forceRespawn: opts.respawnProxy,
      });
      const fsRes = await ensureFsServer(realDir, opts.port);
      writePidfile({
        agent: opts.agent,
        dir: realDir,
        supervisorPid: process.pid,
        fsPort: fsRes.port,
        proxyPort,
      });
      return { proxyRes, fsRes };
    });
    fsPort = ensured.fsRes.port;
    proxyReused = ensured.proxyRes.reused;
    fsReused = ensured.fsRes.reused;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }

  // --- Register agent ---
  let registration: RegistrationResult;
  try {
    registration = await registerAgentAndConfig(
      config.apiKey,
      config.baseUrl,
      opts.agent,
      fsPort,
      realDir,
    );
  } catch (error) {
    // Roll back: drop our pidfile and release any resource we just started that no
    // other live agent needs.
    await withResourceLock(() => {
      removePidfile(opts.agent);
      releaseFsServerIfUnused(realDir, opts.agent);
      releaseProxyIfUnused(proxyPort, opts.agent);
    });
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Registration failed: ${msg}\n`);
    process.exit(1);
  }

  // --- Liveness heartbeat ---
  // Per-agent: ping the backend every 30s, but only while both shared servers
  // actually respond, so the dashboard's connected/not-connected badge reflects
  // real health. The supervisor probes the shared resources; it does not own them.
  // Must match the server_name used at registration (proxyServerSlug) so the backend
  // finds this agent's row and stamps last_seen_at on it.
  const heartbeatServerName = proxyServerSlug(opts.agent);
  const heartbeatTick = async (): Promise<void> => {
    const proxyVersion = await readProxyVersion(proxyPort);
    const proxyOk = proxyVersion !== null || (await probeProxyHealth(proxyPort));
    const fsOk = await isPortListening(fsPort);
    if (proxyOk && fsOk) {
      await sendHeartbeat(config.apiKey, config.baseUrl, heartbeatServerName, proxyVersion);
    }
  };
  void heartbeatTick();
  const heartbeatTimer = setInterval(() => {
    void heartbeatTick();
  }, HEARTBEAT_INTERVAL_MS);

  // Ctrl-C (interactive foreground stop): tear down shared resources we no longer
  // need, refcounted like `files stop`.
  let cleaningUp = false;
  process.on("SIGINT", () => {
    if (cleaningUp) return;
    cleaningUp = true;
    void (async () => {
      clearInterval(heartbeatTimer);
      await withResourceLock(() => {
        removePidfile(opts.agent);
        releaseFsServerIfUnused(realDir, opts.agent);
        releaseProxyIfUnused(proxyPort, opts.agent);
      });
      process.exit(0);
    })();
  });
  // SIGTERM (from `files stop` or the system): exit fast and let `files stop` own
  // the refcounted teardown, so the two don't race over the lock.
  process.on("SIGTERM", () => {
    clearInterval(heartbeatTimer);
    removePidfile(opts.agent);
    process.exit(0);
  });

  // --- Output + auto-write config ---
  const dirLabel = `./${basename(absDir)}`;

  // Build the local proxy URL from the path segment returned by the API.
  // The API returns a hosted proxy URL (e.g. https://proxy.multicorn.ai/r/...)
  // but this command wires everything locally, so the coding agent must point
  // at the local proxy.
  const localProxyUrl = `http://127.0.0.1:${String(proxyPort)}${registration.pathSegment}`;

  process.stderr.write("\n");
  process.stderr.write(
    `  ${style.green("\u2713")} ${proxyReused ? "Reusing shared proxy" : "Local proxy running"} (:${String(proxyPort)})\n`,
  );
  process.stderr.write(
    `  ${style.green("\u2713")} ${fsReused ? "Reusing filesystem server for" : "Filesystem server on"} ${dirLabel} (:${String(fsPort)})\n`,
  );
  process.stderr.write(`  ${style.green("\u2713")} Agent '${opts.agent}' registered with Shield\n`);

  // Re-derive and rewrite the agent's MCP config entry on every start (not only
  // first setup). The writer overwrites this agent's own entry while preserving
  // other keys, so an entry written by older logic (e.g. missing the API key) is
  // repaired by a plain stop/start. Rewriting an already-correct entry is a no-op.
  const writeResult = await autoWriteClientConfig(
    opts.client,
    opts.agent,
    localProxyUrl,
    config.apiKey,
    absDir,
  );

  const firstWritten = writeResult.written[0];
  if (firstWritten !== undefined) {
    for (const w of writeResult.written) {
      process.stderr.write(`  ${style.green("\u2713")} Config written to ${style.cyan(w.path)}\n`);
    }
    process.stderr.write("\n");
    process.stderr.write(style.dim(`  ${firstWritten.reload}\n`));
  } else if (!writeResult.prompted) {
    // Paste fallback only when we didn't already tell the user what to do
    process.stderr.write("\n");
    process.stderr.write(
      "  Add this to your coding agent's MCP config so it routes through Shield:\n\n",
    );
    const configBlock = JSON.stringify(
      {
        mcpServers: {
          [opts.agent]: {
            url: hostedProxyUrlWithKeyParam(localProxyUrl, config.apiKey),
            headers: { Authorization: `Bearer ${config.apiKey}` },
          },
        },
      },
      null,
      2,
    );
    process.stderr.write(style.cyan(configBlock) + "\n\n");
  }

  process.stderr.write(style.dim("  Write and delete will ask for approval the first time.\n"));
  process.stderr.write("\n");
  process.stderr.write(
    `  ${style.green("\u2713")} Shield is running (foreground mode). Press Ctrl-C to stop.\n`,
  );
  process.stderr.write("\n");
}

// ---------------------------------------------------------------------------
// Auto-write client config
// ---------------------------------------------------------------------------

interface WriteResult {
  readonly client: CodingClient;
  readonly path: string;
  readonly reload: string;
}

interface AutoWriteResult {
  readonly written: WriteResult[];
  readonly prompted: boolean;
}

async function autoWriteClientConfig(
  clientFlag: string | undefined,
  agentName: string,
  localProxyUrl: string,
  apiKey: string,
  workspacePath: string,
): Promise<AutoWriteResult> {
  // Explicit --client flag
  if (clientFlag !== undefined && clientFlag.length > 0) {
    if (clientFlag === "all") {
      const detected = detectInstalledClients();
      if (detected.length === 0) return { written: [], prompted: false };
      const results: WriteResult[] = [];
      for (const c of detected) {
        const path = await writeLocalMcpEntry(c, agentName, localProxyUrl, apiKey, workspacePath);
        if (path !== null) {
          results.push({ client: c, path, reload: clientReloadInstruction(c) });
        }
      }
      return { written: results, prompted: false };
    }

    const client = clientFlag as CodingClient;
    if (!CODING_CLIENTS.includes(client)) {
      process.stderr.write(
        `\n  Unknown --client "${clientFlag}". Valid options: ${CODING_CLIENTS.join(", ")}, all\n`,
      );
      return { written: [], prompted: false };
    }
    const path = await writeLocalMcpEntry(client, agentName, localProxyUrl, apiKey, workspacePath);
    if (path !== null) {
      return {
        written: [{ client, path, reload: clientReloadInstruction(client) }],
        prompted: false,
      };
    }
    process.stderr.write(
      `\n  Could not write to ${clientDisplayName(client)} config (parse error or permissions).\n`,
    );
    return { written: [], prompted: false };
  }

  // Auto-detect
  const detected = detectInstalledClients();
  if (detected.length === 0) {
    return { written: [], prompted: false };
  }
  if (detected.length === 1) {
    const client = detected[0];
    if (client === undefined) {
      return { written: [], prompted: false };
    }
    const path = await writeLocalMcpEntry(client, agentName, localProxyUrl, apiKey, workspacePath);
    if (path !== null) {
      return {
        written: [{ client, path, reload: clientReloadInstruction(client) }],
        prompted: false,
      };
    }
    // Write was skipped (e.g. the existing config file couldn't be parsed). Fail closed:
    // the file was left untouched. Tell the user, then fall through to the paste fallback.
    process.stderr.write(
      `\n  Could not safely update ${clientDisplayName(client)} config (parse error or permissions). Left it unchanged.\n`,
    );
    return { written: [], prompted: false };
  }

  // Multiple detected - prompt if interactive, otherwise list and bail
  if (!process.stdin.isTTY) {
    process.stderr.write("\n");
    process.stderr.write("  Multiple coding agents detected:\n");
    for (const c of detected) {
      process.stderr.write(`    - ${clientDisplayName(c)} (--client ${c})\n`);
    }
    process.stderr.write(
      "\n  Re-run with --client <name> to write config, or --client all for all.\n",
    );
    return { written: [], prompted: true };
  }

  // Interactive prompt
  process.stderr.write("\n");
  process.stderr.write("  Multiple coding agents detected. Which should route through Shield?\n\n");
  for (const [i, c] of detected.entries()) {
    process.stderr.write(`    ${String(i + 1)}) ${clientDisplayName(c)}\n`);
  }
  process.stderr.write(`    a) All of them\n`);
  process.stderr.write("\n");

  const choice = await promptLine("  Enter number (or 'a' for all): ");
  const trimmed = choice.trim().toLowerCase();

  if (trimmed === "a" || trimmed === "all") {
    const results: WriteResult[] = [];
    for (const c of detected) {
      const path = await writeLocalMcpEntry(c, agentName, localProxyUrl, apiKey, workspacePath);
      if (path !== null) {
        results.push({ client: c, path, reload: clientReloadInstruction(c) });
      }
    }
    return { written: results, prompted: false };
  }

  const num = Number.parseInt(trimmed, 10);
  const client = num >= 1 && num <= detected.length ? detected[num - 1] : undefined;
  if (client !== undefined) {
    const path = await writeLocalMcpEntry(client, agentName, localProxyUrl, apiKey, workspacePath);
    if (path !== null) {
      return {
        written: [{ client, path, reload: clientReloadInstruction(client) }],
        prompted: false,
      };
    }
  }

  process.stderr.write(`  Invalid choice. Use --client <name> next time.\n`);
  return { written: [], prompted: true };
}

function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** @internal Exposed for unit tests only. */
export {
  ensureProxy as ensureProxyForTests,
  supervisorPidFromSession as supervisorPidFromSessionForTests,
};
