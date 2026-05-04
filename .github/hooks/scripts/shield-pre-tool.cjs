#!/usr/bin/env node
// Copyright (c) Multicorn AI Pty Ltd. MIT License. See LICENSE file.
/**
 * GitHub Copilot preToolUse hook: checks Shield permission before a tool runs.
 * stdin: toolName, toolArgs (JSON string), timestamp, cwd, sessionId (GitHub Hooks API).
 * Deny: stdout JSON { permissionDecision: "deny", permissionDecisionReason: "..." }.
 * Allow: exit 0 with empty stdout (or JSON allow).
 */

"use strict";

const { execFileSync } = require("node:child_process");

const {
  buildScrubbedParametersJson,
  loadConfig,
  logPrefix,
  mapToolName,
  parseToolArgsObject,
  postJson,
  readStdin,
  safeJsonParse,
  unwrapData,
} = require("./shared.cjs");

const HOOK_PREFIX = logPrefix("pre-hook");

/**
 * @param {string} apiBaseUrl
 * @returns {string}
 */
function dashboardOrigin(apiBaseUrl) {
  try {
    const raw = String(apiBaseUrl).replace(/\/+$/, "");
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

function dashboardHintUrl(apiBaseUrl) {
  return `${dashboardOrigin(apiBaseUrl)}/approvals`;
}

function consentUrl(apiBaseUrl, agentName, service, actionType) {
  const origin = dashboardOrigin(apiBaseUrl);
  const params = new URLSearchParams();
  params.set("agent", agentName);
  params.set("scopes", `${service}:${actionType}`);
  params.set("platform", "github-copilot");
  return `${origin}/consent?${params.toString()}`;
}

/**
 * @param {unknown} data
 * @param {string} service
 * @param {string} actionType
 * @param {string} approvalsUrl
 * @returns {string}
 */
function blockedMessage(data, service, actionType, approvalsUrl) {
  if (data !== null && typeof data === "object") {
    const d = /** @type {Record<string, unknown>} */ (data);
    const meta = d.metadata;
    if (typeof meta === "string" && meta.length > 0) {
      try {
        const parsed = JSON.parse(meta);
        if (parsed !== null && typeof parsed === "object" && "block_reason" in parsed) {
          const br = /** @type {Record<string, unknown>} */ (parsed).block_reason;
          if (typeof br === "string" && br.length > 0) {
            return `Shield: Action blocked - ${br}. Grant access at ${approvalsUrl}`;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return `Shield: Action blocked. Required permission: ${service} (${actionType}). Grant access at ${approvalsUrl}`;
}

/**
 * @param {string} url
 */
function openBrowser(url) {
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

/**
 * GitHub Hooks: deny with documented shape.
 * @param {string} reason
 */
function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    }) + "\n",
  );
  process.exit(0);
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${HOOK_PREFIX} could not read stdin (${msg}). Fail-open.\n`);
    process.exit(0);
  }

  const config = loadConfig();
  if (config === null || config.apiKey.length === 0 || config.agentName.length === 0) {
    process.exit(0);
  }

  /** @type {Record<string, unknown>} */
  let hookPayload;
  try {
    hookPayload = JSON.parse(raw.length > 0 ? raw : "{}");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${HOOK_PREFIX} invalid JSON (${msg}). Fail-open.\n`);
    process.exit(0);
  }

  const toolName =
    typeof hookPayload.toolName === "string"
      ? hookPayload.toolName
      : typeof hookPayload.tool === "string"
        ? hookPayload.tool
        : "";

  if (toolName.length === 0) {
    process.exit(0);
  }

  const parameters = parseToolArgsObject(hookPayload.toolArgs);
  const { service, actionType } = mapToolName(toolName);

  const paramsSerialized = buildScrubbedParametersJson(parameters);

  const approvalsUrl = dashboardHintUrl(config.baseUrl);

  /** @type {Record<string, unknown>} */
  const metadata = {
    tool_name: toolName,
    cwd: typeof hookPayload.cwd === "string" ? hookPayload.cwd : "",
    session_id: typeof hookPayload.sessionId === "string" ? hookPayload.sessionId : "",
    parameters: paramsSerialized,
    timestamp: typeof hookPayload.timestamp === "string" ? hookPayload.timestamp : "",
    source: "github-copilot",
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: config.agentName,
    service,
    actionType,
    status: "pending",
    metadata,
    platform: "github-copilot",
  };

  let statusCode;
  let bodyText;
  try {
    const res = await postJson(config.baseUrl, config.apiKey, payload);
    statusCode = res.statusCode;
    bodyText = res.bodyText;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${HOOK_PREFIX} Shield API unreachable (${msg}). Fail-open.\n`);
    process.exit(0);
  }

  const parsed = safeJsonParse(bodyText);
  const data = unwrapData(parsed);

  if (statusCode === 202) {
    const url = consentUrl(config.baseUrl, config.agentName, service, actionType);
    openBrowser(url);
    deny(
      `Shield: ${config.agentName} needs ${service}:${actionType} permission. Authorize at ${url} then retry.`,
    );
    return;
  }

  if (statusCode === 201) {
    if (data === null || typeof data !== "object") {
      deny(
        `Shield: ${config.agentName} needs ${service}:${actionType} permission. Approve at ${consentUrl(config.baseUrl, config.agentName, service, actionType)} or review at ${approvalsUrl}`,
      );
      return;
    }
    const st = String(/** @type {Record<string, unknown>} */ (data).status || "").toLowerCase();
    if (st === "approved") {
      process.exit(0);
      return;
    }
    if (st === "blocked") {
      deny(blockedMessage(data, service, actionType, approvalsUrl));
      return;
    }
    deny(
      `Shield: ${config.agentName} needs ${service}:${actionType} permission. Approve at ${consentUrl(config.baseUrl, config.agentName, service, actionType)} or review at ${approvalsUrl}`,
    );
    return;
  }

  deny(
    `Shield: ${config.agentName} needs ${service}:${actionType} permission. Approve at ${consentUrl(config.baseUrl, config.agentName, service, actionType)} or review at ${approvalsUrl}`,
  );
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`${HOOK_PREFIX} unexpected error (${msg}). Fail-open.\n`);
  process.exit(0);
});
