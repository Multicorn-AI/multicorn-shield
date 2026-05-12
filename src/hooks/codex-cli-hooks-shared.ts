/**
 * MIT License
 *
 * Copyright (c) Multicorn AI Pty Ltd
 *
 * Shared helpers for Codex CLI PreToolUse / PostToolUse Shield hooks (HTTP client,
 * config load, audit serialization).
 *
 * @module hooks/codex-cli-hooks-shared
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

export const AUTH_HEADER = "X-Multicorn-Key";

const AUDIT_METADATA_MAX_CHARS = 10_000;

/**
 * Best-effort secret redaction on JSON-ish strings before they are sent as audit metadata.
 * Heuristic regex pass only (not a structured parser); assumes metadata is non-authoritative.
 */
export function redactSecretsForAudit(serialized: string): string {
  let out = serialized;
  out = out.replace(/\bsk-[a-zA-Z0-9]{20,}\b/g, "[REDACTED]");
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]");
  out = out.replace(/\bghp_[a-zA-Z0-9]{20,}\b/g, "[REDACTED]");
  out = out.replace(/\bgho_[a-zA-Z0-9]{20,}\b/g, "[REDACTED]");
  out = out.replace(/\bghu_[a-zA-Z0-9]{20,}\b/g, "[REDACTED]");
  out = out.replace(/\bghs_[a-zA-Z0-9]{20,}\b/g, "[REDACTED]");
  out = out.replace(
    /-----BEGIN[A-Z0-9 \n\r-]+-----[\s\S]*?-----END[A-Z0-9 \n\r-]+-----/g,
    "[REDACTED]",
  );
  out = out.replace(/token=[^\s"&]+/gi, "token=[REDACTED]");
  out = out.replace(/\bBearer\s+[a-zA-Z0-9._\-+/=]+\b/gi, "Bearer [REDACTED]");
  return out;
}

export function truncateForAudit(serialized: string, maxChars = AUDIT_METADATA_MAX_CHARS): string {
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, maxChars)}[truncated]`;
}

/** Serialize hook fragments for POST /actions metadata: redact, then cap size. */
export function serializeHookAuditFragment(value: unknown): string {
  try {
    const raw =
      typeof value === "string" ? value : JSON.stringify(value === undefined ? null : value);
    return truncateForAudit(redactSecretsForAudit(raw));
  } catch {
    return "[unserializable]";
  }
}

export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/**
 * Refuse cleartext API key outside localhost (dev only).
 * @throws Error with message prefix HTTP_API_KEY_REFUSED:<hostname>
 */
export function assertHttpsOrLocalhostForApiKey(u: URL): void {
  if (u.protocol === "http:" && !isLocalHostname(u.hostname)) {
    throw new Error(`HTTP_API_KEY_REFUSED:${u.hostname}`);
  }
}

export function cwdUnderWorkspacePath(cwdResolved: string, workspacePath: string): boolean {
  const w = path.resolve(workspacePath);
  if (cwdResolved === w) return true;
  const prefix = w.endsWith(path.sep) ? w : w + path.sep;
  return cwdResolved.startsWith(prefix);
}

export function resolveCodexCliAgentName(obj: Record<string, unknown>): string {
  const pwd = process.env["PWD"];
  const cwdRaw = pwd !== undefined && pwd.length > 0 ? pwd : process.cwd();
  const agents = obj["agents"];
  const defaultAgentRaw = obj["defaultAgent"];
  const defaultAgentName =
    typeof defaultAgentRaw === "string" && defaultAgentRaw.length > 0 ? defaultAgentRaw : "";

  if (!Array.isArray(agents)) {
    return typeof obj["agentName"] === "string" ? obj["agentName"] : "";
  }

  const matches: { name: string; workspacePath?: string }[] = [];
  for (const entry of agents) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e["platform"] !== "codex-cli") continue;
    const n = e["name"];
    if (typeof n !== "string") continue;
    const wp = e["workspacePath"];
    matches.push({
      name: n,
      ...(typeof wp === "string" && wp.length > 0 ? { workspacePath: wp } : {}),
    });
  }

  if (matches.length === 0) {
    return typeof obj["agentName"] === "string" ? obj["agentName"] : "";
  }

  const withWs = matches.filter(
    (m): m is { name: string; workspacePath: string } =>
      typeof m.workspacePath === "string" && m.workspacePath.length > 0,
  );
  const resolvedCwd = path.resolve(cwdRaw);
  let best: { name: string; workspacePath: string } | null = null;
  let bestLen = -1;
  for (const m of withWs) {
    const wp = m.workspacePath;
    if (!cwdUnderWorkspacePath(resolvedCwd, wp)) continue;
    const len = path.resolve(wp).length;
    if (len > bestLen) {
      bestLen = len;
      best = { name: m.name, workspacePath: wp };
    }
  }
  if (best !== null) return best.name;

  if (defaultAgentName.length > 0) {
    const d = matches.find((m) => m.name === defaultAgentName);
    if (d !== undefined) return d.name;
  }

  const first = matches[0];
  return first !== undefined ? first.name : "";
}

export function warnIfConfigWorldReadable(configPath: string): void {
  try {
    const st = fs.statSync(configPath);
    const mode777 = st.mode & 0o777;
    if ((st.mode & 0o077) !== 0) {
      process.stderr.write(
        `[Shield] Warning: ~/.multicorn/config.json is readable by other users (current: 0${mode777.toString(8)}). Run: chmod 600 ~/.multicorn/config.json\n`,
      );
    }
  } catch {
    /* ignore */
  }
}

export function loadCodexCliConfig(): {
  apiKey: string;
  baseUrl: string;
  agentName: string;
} | null {
  try {
    const configPath = path.join(os.homedir(), ".multicorn", "config.json");
    const raw = fs.readFileSync(configPath, "utf8");
    warnIfConfigWorldReadable(configPath);
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const apiKey = typeof obj["apiKey"] === "string" ? obj["apiKey"] : "";
    const baseUrl =
      typeof obj["baseUrl"] === "string" && obj["baseUrl"].length > 0
        ? obj["baseUrl"].replace(/\/+$/, "")
        : "https://api.multicorn.ai";
    const agentName = resolveCodexCliAgentName(obj);
    return { apiKey, baseUrl, agentName };
  } catch {
    return null;
  }
}

export function formatShieldNetworkError(err: unknown): string {
  const debugEnv = process.env["MULTICORN_DEBUG"];
  const debug = debugEnv === "1" || debugEnv === "true" || debugEnv === "yes";
  let line =
    "[Shield] Error: failed to connect to Shield API. Check your network and baseUrl configuration.\n";
  if (debug && err instanceof Error && err.message.length > 0) {
    line += `  Debug: ${err.message}\n`;
  }
  return line;
}

export function formatHttpApiKeyRefusal(hostname: string): string {
  return `[Shield] Error: refusing to send API key over unencrypted HTTP to ${hostname}. Use HTTPS or localhost.\n`;
}

/** Non-null hostname when `err` was thrown by {@link assertHttpsOrLocalhostForApiKey}. */
export function readHttpApiKeyRefusalHostname(err: unknown): string | null {
  if (!(err instanceof Error) || !err.message.startsWith("HTTP_API_KEY_REFUSED:")) {
    return null;
  }
  return err.message.slice("HTTP_API_KEY_REFUSED:".length);
}

export async function shieldGetJson(
  baseUrl: string,
  apiKey: string,
  reqPath: string,
): Promise<{ statusCode: number; bodyText: string }> {
  const root = baseUrl.replace(/\/+$/, "");
  const p = reqPath.startsWith("/") ? reqPath : `/${reqPath}`;
  const u = new URL(`${root}${p}`);
  assertHttpsOrLocalhostForApiKey(u);

  const isHttps = u.protocol === "https:";
  const lib = isHttps ? https : http;
  const port = u.port !== "" ? Number(u.port) : isHttps ? 443 : 80;
  return await new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: u.hostname,
      port,
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        [AUTH_HEADER]: apiKey,
      },
    };
    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          bodyText: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

export async function shieldPostJson(
  baseUrl: string,
  apiKey: string,
  bodyObj: Record<string, unknown>,
): Promise<{ statusCode: number; bodyText: string }> {
  const root = baseUrl.replace(/\/+$/, "");
  const u = new URL(`${root}/api/v1/actions`);
  assertHttpsOrLocalhostForApiKey(u);

  const payload = JSON.stringify(bodyObj);
  const isHttps = u.protocol === "https:";
  const lib = isHttps ? https : http;
  const port = u.port !== "" ? Number(u.port) : isHttps ? 443 : 80;

  return await new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: u.hostname,
      port,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload, "utf8"),
        [AUTH_HEADER]: apiKey,
      },
    };
    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          bodyText: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** POST-only variant for fire-and-forget logging (still validates HTTPS). */
export async function shieldPostJsonFireAndForget(
  baseUrl: string,
  apiKey: string,
  bodyObj: Record<string, unknown>,
): Promise<void> {
  await shieldPostJson(baseUrl, apiKey, bodyObj);
}
