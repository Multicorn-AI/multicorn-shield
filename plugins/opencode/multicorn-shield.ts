// Copyright (c) Multicorn AI Pty Ltd. MIT License. See LICENSE file.

/**
 * Shield native plugin for OpenCode: permission checks via tool.execute.before,
 * audit logging via tool.execute.after.
 */

import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const MULTICORN_CONFIG = path.join(homedir(), ".multicorn", "config.json");
const HTTP_MS = 10_000;
const PLATFORM = "opencode";

interface ShieldConfigLoaded {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly agentName: string;
}

function cwdUnderWorkspacePath(cwdResolved: string, workspacePath: string): boolean {
  const w = path.resolve(workspacePath);
  if (cwdResolved === w) return true;
  const prefix = w.endsWith(path.sep) ? w : w + path.sep;
  return cwdResolved.startsWith(prefix);
}

function pickAgentName(obj: Record<string, unknown>, cwd: string): string {
  const agents = obj["agents"];
  if (!Array.isArray(agents)) {
    return typeof obj["agentName"] === "string" ? obj["agentName"] : "";
  }
  const matches = agents.filter((e) => {
    if (!e || typeof e !== "object") return false;
    const row = e as Record<string, unknown>;
    return row["platform"] === PLATFORM && typeof row["name"] === "string";
  }) as readonly { name: string; workspacePath?: string }[];
  if (matches.length === 0) {
    return typeof obj["agentName"] === "string" ? obj["agentName"] : "";
  }
  const withWs = matches.filter(
    (m) => typeof m.workspacePath === "string" && m.workspacePath.length > 0,
  );
  if (withWs.length === 0) {
    const fb = matches[0];
    return fb !== undefined ? fb.name : "";
  }
  const resolvedCwd = path.resolve(cwd);
  let best: { name: string; workspacePath: string } | null = null;
  let bestLen = -1;
  for (const m of withWs) {
    const wp = m.workspacePath;
    if (typeof wp !== "string" || !cwdUnderWorkspacePath(resolvedCwd, wp)) continue;
    const len = path.resolve(wp).length;
    if (len > bestLen) {
      bestLen = len;
      best = { name: m.name, workspacePath: wp };
    }
  }
  if (best !== null) {
    return best.name;
  }
  const fb2 = matches[0];
  return fb2 !== undefined ? fb2.name : "";
}

function loadShieldConfig(cwd: string): ShieldConfigLoaded | null {
  try {
    const raw = fs.readFileSync(MULTICORN_CONFIG, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const apiKey = typeof obj["apiKey"] === "string" ? obj["apiKey"] : "";
    const baseUrl =
      typeof obj["baseUrl"] === "string" && obj["baseUrl"].length > 0
        ? obj["baseUrl"].replace(/\/+$/, "")
        : "https://api.multicorn.ai";
    const baseLower = baseUrl.toLowerCase();
    const isHttps = baseLower.startsWith("https://");
    const isLocal = baseLower.includes("localhost") || baseLower.includes("127.0.0.1");
    if (!isHttps && !isLocal) {
      return null;
    }
    const agentName = pickAgentName(obj, cwd);
    return { apiKey, baseUrl, agentName };
  } catch {
    return null;
  }
}

type ToolTriple = readonly [service: string, actionType: string, skipShieldCheck: boolean];

/** Maps OpenCode tool names to Shield service/actionType. Third element skips pre-tool Shield check only. */
function mapTool(toolName: string): ToolTriple {
  const name = toolName.trim();
  if (name === "task") {
    return ["agent", "delegate", true] as const;
  }
  if (name.startsWith("mcp_") || name.includes(":")) {
    if (name.startsWith("mcp_")) {
      const rest = name.slice(4);
      const sanitized = rest.replace(/[^a-zA-Z0-9._-]+/g, "_");
      return [`mcp:${sanitized}`, "execute", false] as const;
    }
    const idx = name.indexOf(":");
    if (idx > 0) {
      const server = name.slice(0, idx).replace(/[^a-zA-Z0-9._-]+/g, "_");
      const tool = name.slice(idx + 1).replace(/[^a-zA-Z0-9._-]+/g, "_");
      return [`mcp:${server}.${tool}`, "execute", false] as const;
    }
  }
  const builtin: Record<string, readonly [string, string]> = {
    bash: ["terminal", "execute"],
    read: ["filesystem", "read"],
    write: ["filesystem", "write"],
    edit: ["filesystem", "write"],
    apply_patch: ["filesystem", "write"],
    glob: ["filesystem", "read"],
    grep: ["filesystem", "read"],
    list: ["filesystem", "read"],
    webfetch: ["network", "request"],
    websearch: ["network", "request"],
  };
  const hit = builtin[name];
  if (hit !== undefined) {
    return [hit[0], hit[1], false] as const;
  }
  return ["other", "execute", false] as const;
}

function unwrapData(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return null;
  const o = body as Record<string, unknown>;
  return o["success"] === true ? o["data"] : null;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function dashboardHintUrl(apiBaseUrl: string): string {
  try {
    const raw = apiBaseUrl.replace(/\/+$/, "");
    const lower = raw.toLowerCase();
    if (lower.includes("localhost:8080") || lower.includes("127.0.0.1:8080")) {
      return "http://localhost:5173/approvals";
    }
    const u = new URL(raw);
    if (u.hostname.startsWith("api.")) {
      u.hostname = "app." + u.hostname.slice(4);
    }
    return `${u.origin}/approvals`;
  } catch {
    return "https://app.multicorn.ai/approvals";
  }
}

function consentUrl(
  apiBaseUrl: string,
  agentName: string,
  service: string,
  actionType: string,
): string {
  const raw = apiBaseUrl.replace(/\/+$/, "");
  let origin: string;
  try {
    const lower = raw.toLowerCase();
    if (lower.includes("localhost:8080") || lower.includes("127.0.0.1:8080")) {
      origin = "http://localhost:5173";
    } else {
      const u = new URL(raw);
      if (u.hostname.startsWith("api.")) {
        u.hostname = "app." + u.hostname.slice(4);
      }
      origin = u.origin;
    }
  } catch {
    origin = "https://app.multicorn.ai";
  }
  const params = new URLSearchParams();
  params.set("agent", agentName);
  params.set("scopes", `${service}:${actionType}`);
  params.set("platform", PLATFORM);
  return `${origin}/consent?${params.toString()}`;
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    } else if (process.platform === "win32") {
      execFileSync("cmd.exe", ["/c", "start", "", url], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {
    /* ignore */
  }
}

function blockedMessage(
  data: unknown,
  service: string,
  actionType: string,
  approvalsUrl: string,
): string {
  if (data !== null && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const meta = d["metadata"];
    if (typeof meta === "string" && meta.length > 0) {
      const parsed = safeParseJson(meta);
      if (parsed !== null && typeof parsed === "object") {
        const br = (parsed as Record<string, unknown>)["block_reason"];
        if (typeof br === "string" && br.length > 0) {
          return `Shield: Action blocked - ${br}. Grant access at ${approvalsUrl}`;
        }
      }
    }
  }
  return `Shield: Action blocked. Required permission: ${service} (${actionType}). Grant access at ${approvalsUrl}`;
}

function scrubMetadataArgs(args: unknown): string {
  try {
    if (typeof args !== "object" || args === null) return "{}";
    const clone = { ...(args as Record<string, unknown>) };
    const contentKey = clone["content"];
    if (typeof contentKey === "string") {
      clone["content"] = "[" + contentKey.length.toString() + " chars redacted]";
    }
    const cmd = clone["command"];
    if (typeof cmd === "string" && cmd.length > 200) {
      clone["command"] = cmd.slice(0, 200) + "... [truncated]";
    }
    let out = JSON.stringify(clone);
    if (out.length > 4096) out = out.slice(0, 4096);
    return out;
  } catch {
    return "{}";
  }
}

function scrubResultSnippet(text: unknown): string {
  if (typeof text !== "string") return "";
  let s = text;
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  s = s.replace(/\bmcs_[A-Za-z0-9_-]+\b/g, "[REDACTED]");
  s = s.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED]");
  s = s.replace(/Bearer\s+[^\s]+/gi, "[REDACTED]");
  if (s.length > 500) {
    return s.slice(0, 500) + "[truncated]";
  }
  return s;
}

async function shieldPostActions(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ readonly statusCode: number; readonly bodyText: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/actions`;
  const ac = new AbortController();
  const t = setTimeout(() => {
    ac.abort();
  }, HTTP_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Connection: "close",
        "Content-Type": "application/json",
        "X-Multicorn-Key": apiKey,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const bodyText = await res.text();
    return { statusCode: res.status, bodyText };
  } finally {
    clearTimeout(t);
  }
}

async function notifyPluginLog(
  client: PluginInput["client"],
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  try {
    const appUnknown = (
      client as unknown as {
        app?: {
          log?: (p: unknown) => Promise<void>;
        };
      }
    ).app;
    if (appUnknown?.log === undefined) return;
    await appUnknown.log({
      body: { service: "multicorn-shield-opencode", level, message },
    });
  } catch {
    /* ignore */
  }
}

async function shieldBeforeDecision(
  cfg: ShieldConfigLoaded,
  toolName: string,
  args: Record<string, unknown>,
  approvalsUrlApp: string,
): Promise<{ readonly allow: true } | { readonly allow: false; readonly msg: string }> {
  const [service, actionType, skipCheck] = mapTool(toolName);
  if (skipCheck || cfg.apiKey.length === 0 || cfg.agentName.length === 0) {
    return { allow: true };
  }

  /** @type {Record<string, unknown>} */
  const metadata = {
    tool_name: toolName,
    parameters: scrubMetadataArgs(args),
    source: PLATFORM,
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: cfg.agentName,
    service,
    actionType,
    status: "pending",
    metadata,
    platform: PLATFORM,
  };

  let statusCode: number;
  let bodyText: string;
  try {
    const res = await shieldPostActions(cfg.baseUrl, cfg.apiKey, payload);
    statusCode = res.statusCode;
    bodyText = res.bodyText;
  } catch {
    return { allow: true };
  }

  const parsed = typeof bodyText === "string" ? safeParseJson(bodyText) : null;
  const data = unwrapData(parsed);

  if (statusCode === 202) {
    const url = consentUrl(cfg.baseUrl, cfg.agentName, service, actionType);
    openBrowser(url);
    return {
      allow: false,
      msg: `Shield: ${cfg.agentName} needs ${service}:${actionType} permission. Authorize at ${url} then retry this action.`,
    };
  }

  if (statusCode === 201) {
    if (data === null || typeof data !== "object") {
      const u = consentUrl(cfg.baseUrl, cfg.agentName, service, actionType);
      return {
        allow: false,
        msg: `Shield: ${cfg.agentName} needs ${service}:${actionType} permission. Approve at ${u} or review at ${approvalsUrlApp}`,
      };
    }
    const row = data as Record<string, unknown>;
    const rawStatus = row["status"];
    const st = typeof rawStatus === "string" ? rawStatus.toLowerCase() : "";
    if (st === "approved") {
      return { allow: true };
    }
    if (st === "blocked" || st === "requires_approval") {
      return {
        allow: false,
        msg: blockedMessage(data, service, actionType, approvalsUrlApp),
      };
    }
    const u = consentUrl(cfg.baseUrl, cfg.agentName, service, actionType);
    return {
      allow: false,
      msg: `Shield: ${cfg.agentName} needs ${service}:${actionType} permission. Approve at ${u} or review at ${approvalsUrlApp}`,
    };
  }

  const u = consentUrl(cfg.baseUrl, cfg.agentName, service, actionType);
  return {
    allow: false,
    msg: `Shield: ${cfg.agentName} needs ${service}:${actionType} permission. Approve at ${u} or review at ${approvalsUrlApp}`,
  };
}

function scheduleLogApproved(
  cfg: ShieldConfigLoaded,
  toolName: string,
  resultPreview: string,
): void {
  const [service, actionType] = mapTool(toolName);
  /** @type {Record<string, unknown>} */
  const metadata = {
    tool_name: toolName,
    result: resultPreview,
    source: PLATFORM,
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: cfg.agentName,
    service,
    actionType,
    status: "approved",
    metadata,
    platform: PLATFORM,
  };

  void shieldPostActions(cfg.baseUrl, cfg.apiKey, payload).catch(() => {
    /* intentionally ignored */
  });
}

export const MulticornShieldPlugin: Plugin = (input: PluginInput): Promise<Hooks> => {
  const directoryResolved = typeof input.directory === "string" ? input.directory : process.cwd();

  return Promise.resolve({
    "tool.execute.before": async ({ tool: toolNameRaw }, output) => {
      const cfg = loadShieldConfig(directoryResolved);
      if (cfg === null || cfg.apiKey.length === 0 || cfg.agentName.length === 0) {
        return;
      }

      const toolName = typeof toolNameRaw === "string" ? toolNameRaw : "";
      if (toolName.length === 0) return;

      const args =
        output.args !== null && typeof output.args === "object" && !Array.isArray(output.args)
          ? (output.args as Record<string, unknown>)
          : {};

      const approvalsUrl = dashboardHintUrl(cfg.baseUrl);

      try {
        const verdict = await shieldBeforeDecision(cfg, toolName, args, approvalsUrl);
        if (!verdict.allow && "msg" in verdict) {
          throw new Error(verdict.msg);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Shield:")) throw e;
        void notifyPluginLog(
          input.client,
          "warn",
          `Shield pre-tool check skipped: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    "tool.execute.after": (hookInput, output): Promise<void> => {
      const cfg = loadShieldConfig(directoryResolved);
      if (cfg === null || cfg.apiKey.length === 0 || cfg.agentName.length === 0) {
        return Promise.resolve();
      }

      const toolName = typeof hookInput.tool === "string" ? hookInput.tool : "";
      if (toolName.length === 0) {
        return Promise.resolve();
      }

      let snippet = "";
      if (typeof output === "object" && "output" in output) {
        const rawOut = (output as Record<string, unknown>)["output"];
        if (typeof rawOut === "string") {
          snippet = scrubResultSnippet(rawOut);
        }
      }

      scheduleLogApproved(cfg, toolName, snippet);
      return Promise.resolve();
    },
  });
};
