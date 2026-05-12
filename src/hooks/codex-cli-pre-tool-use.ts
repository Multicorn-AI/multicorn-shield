/**
 * MIT License
 *
 * Copyright (c) Multicorn AI Pty Ltd
 *
 * Codex CLI PreToolUse hook: asks Shield whether a tool call is allowed.
 * Fail-closed on API errors once config is loaded. Fail-open only if Shield is not configured.
 *
 * Built to `plugins/codex-cli/hooks/scripts/pre-tool-use.cjs`. Do not edit the CJS output by hand.
 *
 * @module hooks/codex-cli-pre-tool-use
 */

import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  formatHttpApiKeyRefusal,
  formatShieldNetworkError,
  loadCodexCliConfig,
  readHttpApiKeyRefusalHostname,
  serializeHookAuditFragment,
  shieldPostJson,
  shieldGetJson,
} from "./codex-cli-hooks-shared.js";
import { mapCodexCliToolToShield } from "./codex-cli-tool-map.js";

const FAST_POLL =
  process.env["NODE_ENV"] === "test" &&
  process.env["MULTICORN_SHIELD_PRE_HOOK_TEST_FAST_POLL"] === "1";
const POLL_INTERVAL_MS = FAST_POLL ? 1 : 3000;
const MAX_APPROVAL_POLLS = FAST_POLL ? 3 : 100;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => chunks.push(c));
    process.stdin.on("end", () => {
      resolve(chunks.join(""));
    });
    process.stdin.on("error", reject);
  });
}

function dashboardOrigin(apiBaseUrl: string): string {
  try {
    const raw = apiBaseUrl.replace(/\/+$/, "");
    const lower = raw.toLowerCase();
    if (lower.includes("localhost:8080") || lower.includes("127.0.0.1:8080")) {
      return "http://localhost:5173";
    }
    const u = new URL(raw);
    if (u.hostname.startsWith("api.")) {
      u.hostname = "app." + u.hostname.slice(4);
    }
    return u.origin;
  } catch {
    return "https://app.multicorn.ai";
  }
}

function dashboardHintUrl(apiBaseUrl: string): string {
  return `${dashboardOrigin(apiBaseUrl)}/approvals`;
}

function consentUrl(
  apiBaseUrl: string,
  agentName: string,
  service: string,
  actionType: string,
): string {
  const origin = dashboardOrigin(apiBaseUrl);
  const params = new URLSearchParams();
  params.set("agent", agentName);
  params.set("scopes", `${service}:${actionType}`);
  params.set("platform", "codex-cli");
  return `${origin}/consent?${params.toString()}`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unwrapData(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return null;
  const o = body as Record<string, unknown>;
  return o["success"] === true ? o["data"] : null;
}

function denyViaStdout(reason: string): void {
  const response = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
  process.stdout.write(response + "\n");
}

function blockedReason(
  data: unknown,
  service: string,
  actionType: string,
  approvalsUrl: string,
): string {
  if (data !== null && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const meta = d["metadata"];
    if (typeof meta === "string" && meta.length > 0) {
      try {
        const parsed = JSON.parse(meta) as unknown;
        if (parsed !== null && typeof parsed === "object" && "block_reason" in parsed) {
          const br = (parsed as Record<string, unknown>)["block_reason"];
          if (typeof br === "string" && br.length > 0) {
            return `Shield blocked: ${br}. Grant access at ${approvalsUrl}`;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return `Shield blocked this tool call. Required permission: ${service} (${actionType}). Grant access at ${approvalsUrl}`;
}

function consentMarkerPath(agentName: string): string {
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.homedir(), ".multicorn", `.consent-${safe}`);
}

function hasConsentMarker(agentName: string): boolean {
  try {
    fs.accessSync(consentMarkerPath(agentName));
    return true;
  } catch {
    return false;
  }
}

function writeConsentMarker(agentName: string): void {
  try {
    const marker = consentMarkerPath(agentName);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, String(Date.now()), "utf8");
  } catch {
    /* ignore */
  }
}

function removeConsentMarker(agentName: string): void {
  try {
    fs.unlinkSync(consentMarkerPath(agentName));
  } catch {
    /* ignore */
  }
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      execSync(`start "" ${JSON.stringify(url)}`, {
        shell: process.env["ComSpec"] ?? "cmd.exe",
        stdio: "ignore",
        windowsHide: true,
      });
    } else if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {
    /* ignore */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollApprovalStatus(
  config: { apiKey: string; baseUrl: string; agentName: string },
  approvalId: string,
  consentLink: string,
): Promise<boolean> {
  let lastProgressWrite = Date.now();
  for (let i = 0; i < MAX_APPROVAL_POLLS; i++) {
    if (i > 0) {
      await sleep(POLL_INTERVAL_MS);
    }
    const now = Date.now();
    if (now - lastProgressWrite >= 30_000) {
      process.stderr.write(`[Shield] Waiting for approval... ${consentLink}\n`);
      lastProgressWrite = now;
    }

    let statusCode: number;
    let bodyText: string;
    try {
      const res = await shieldGetJson(
        config.baseUrl,
        config.apiKey,
        `/api/v1/approvals/${approvalId}`,
      );
      statusCode = res.statusCode;
      bodyText = res.bodyText;
    } catch (e) {
      const refusedHost = readHttpApiKeyRefusalHostname(e);
      if (refusedHost !== null) {
        process.stderr.write(formatHttpApiKeyRefusal(refusedHost));
        process.exit(2);
      }
      continue;
    }
    if (statusCode < 200 || statusCode >= 300) {
      continue;
    }
    const parsed = safeJsonParse(bodyText);
    const data = unwrapData(parsed);
    if (data === null || typeof data !== "object") {
      continue;
    }
    const d = data as Record<string, unknown>;
    const statusRaw = d["status"];
    const st = (typeof statusRaw === "string" ? statusRaw : "").toLowerCase();
    if (st === "approved") {
      return true;
    }
    if (st === "blocked" || st === "denied" || st === "rejected") {
      const reasonRaw = d["reason"];
      const reason =
        typeof reasonRaw === "string" && reasonRaw.length > 0 ? reasonRaw : "Approval denied.";
      denyViaStdout(`Shield denied this approval request: ${reason}`);
      process.exit(0);
    }
    if (st === "expired") {
      denyViaStdout(
        "Shield approval request expired. Retry the tool call and complete approval when prompted.",
      );
      process.exit(0);
    }
    if (st === "pending") {
      continue;
    }
  }
  return false;
}

async function handlePendingWithConsentAndPoll(
  config: { apiKey: string; baseUrl: string; agentName: string },
  approvalId: string,
  service: string,
  actionType: string,
  approvalsUrl: string,
): Promise<void> {
  const consentLink = consentUrl(config.baseUrl, config.agentName, service, actionType);
  process.stderr.write(`[Shield] Action requires approval. Open: ${consentLink}\n`);

  if (hasConsentMarker(config.agentName)) {
    process.stderr.write(
      `[Shield] Waiting for approval (up to 5 min)...\n  Approve in the Shield dashboard: ${approvalsUrl}\n`,
    );

    const approved = await pollApprovalStatus(config, approvalId, consentLink);
    if (approved) {
      process.exit(0);
    }

    removeConsentMarker(config.agentName);

    denyViaStdout(
      `Shield approval timed out after 5 minutes. Approve at ${approvalsUrl} and retry.`,
    );
    process.exit(0);
  }

  writeConsentMarker(config.agentName);
  openBrowser(consentLink);
  process.stderr.write(
    "[Shield] Opening Shield consent screen... Waiting for approval (up to 5 min).\n",
  );

  const approved = await pollApprovalStatus(config, approvalId, consentLink);
  if (approved) {
    process.exit(0);
  }

  denyViaStdout(`Shield approval timed out after 5 minutes. Approve at ${approvalsUrl} and retry.`);
  process.exit(0);
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    process.stderr.write("[Shield] Warning: could not read stdin. Allowing tool.\n");
    process.exit(0);
  }

  const config = loadCodexCliConfig();
  if (config === null) {
    process.exit(0);
  }
  if (config.apiKey.length === 0 || config.agentName.length === 0) {
    process.exit(0);
  }

  let hookPayload: Record<string, unknown>;
  try {
    hookPayload = JSON.parse(raw.length > 0 ? raw : "{}") as Record<string, unknown>;
  } catch {
    process.stderr.write("[Shield] Warning: invalid hook JSON. Allowing tool.\n");
    process.exit(0);
  }

  const toolNameRaw =
    (typeof hookPayload["tool_name"] === "string" && hookPayload["tool_name"]) || "";
  const toolInput = hookPayload["tool_input"] !== undefined ? hookPayload["tool_input"] : undefined;

  try {
    void (typeof toolInput === "string"
      ? toolInput
      : JSON.stringify(toolInput === undefined ? null : toolInput));
  } catch {
    process.stderr.write("[Shield] Warning: could not serialize tool input. Allowing tool.\n");
    process.exit(0);
  }

  const { service, actionType } = mapCodexCliToolToShield(toolNameRaw, toolInput);
  const approvalsUrl = dashboardHintUrl(config.baseUrl);

  const metadata: Record<string, unknown> = {
    tool_name: toolNameRaw,
    tool_input: serializeHookAuditFragment(toolInput),
    source: "codex-cli",
  };

  const payload: Record<string, unknown> = {
    agent: config.agentName,
    service,
    actionType,
    status: "pending",
    metadata,
    platform: "codex-cli",
  };

  let statusCode: number;
  let bodyText: string;
  try {
    const res = await shieldPostJson(config.baseUrl, config.apiKey, payload);
    statusCode = res.statusCode;
    bodyText = res.bodyText;
  } catch (e) {
    const refusedHost = readHttpApiKeyRefusalHostname(e);
    if (refusedHost !== null) {
      process.stderr.write(formatHttpApiKeyRefusal(refusedHost));
      process.exit(2);
    }
    process.stderr.write(formatShieldNetworkError(e));
    process.exit(2);
  }

  const parsed = safeJsonParse(bodyText);
  const data = unwrapData(parsed);

  if (statusCode === 202) {
    if (data === null || typeof data !== "object") {
      denyViaStdout("This action needs approval in the Shield dashboard before it can run.");
      process.exit(0);
    }
    const approvalIdRaw = (data as Record<string, unknown>)["approval_id"];
    const approvalId = typeof approvalIdRaw === "string" ? approvalIdRaw : "";
    if (approvalId.length === 0) {
      denyViaStdout("This action needs approval in the Shield dashboard before it can run.");
      process.exit(0);
    }
    await handlePendingWithConsentAndPoll(config, approvalId, service, actionType, approvalsUrl);
    return;
  }

  if (statusCode === 201) {
    if (data === null || typeof data !== "object") {
      const detail = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
      process.stderr.write(
        `[Shield] Error: unexpected Shield response, cannot verify permissions.\n  Detail: ${detail}\n`,
      );
      process.exit(2);
    }
    const dataObj = data as Record<string, unknown>;
    const statusRaw = dataObj["status"];
    const st = (typeof statusRaw === "string" ? statusRaw : "").toLowerCase();
    if (st === "approved") {
      process.exit(0);
    }
    if (st === "blocked") {
      denyViaStdout(blockedReason(data, service, actionType, approvalsUrl));
      process.exit(0);
    }
    process.stderr.write(
      `[Shield] Error: ambiguous Shield status, cannot verify permissions.\n  Detail: status=${JSON.stringify(dataObj["status"])}\n`,
    );
    process.exit(2);
  }

  const httpDetail = bodyText.length > 300 ? `${bodyText.slice(0, 300)}...` : bodyText;
  process.stderr.write(
    `[Shield] Error: Shield returned HTTP ${String(statusCode)}, cannot verify permissions.\n  Detail: HTTP ${String(statusCode)} body=${httpDetail}\n`,
  );
  process.exit(2);
}

main().catch((e: unknown) => {
  const refusedHost = readHttpApiKeyRefusalHostname(e);
  if (refusedHost !== null) {
    process.stderr.write(formatHttpApiKeyRefusal(refusedHost));
    process.exit(2);
  }
  process.stderr.write(formatShieldNetworkError(e));
  process.exit(2);
});
