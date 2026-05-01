#!/usr/bin/env node
// Copyright (c) Multicorn AI Pty Ltd. MIT License. See LICENSE file.
/**
 * Gemini CLI BeforeTool hook: asks Shield whether a tool call is allowed.
 * Reads JSON from stdin. Writes JSON to stdout only (decision allow/deny). Logs to stderr.
 * Fail-open on missing config or unreachable API.
 */

"use strict";

const {
  loadConfig,
  logPrefix,
  mapToolName,
  postJson,
  readStdin,
  safeJsonParse,
  scrubParameters,
  unwrapData,
  consentUrl,
  openBrowser,
} = require("./shared.cjs");

const HOOK_PREFIX = logPrefix("before-tool");

/**
 * @param {string} decision
 * @param {string} [reason]
 */
function respond(decision, reason) {
  /** @type {Record<string, unknown>} */
  const out = { decision };
  if (reason !== undefined && reason.length > 0) {
    out.reason = reason;
  }
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

function dashboardHintUrl(apiBaseUrl) {
  try {
    const raw = String(apiBaseUrl).replace(/\/+$/, "");
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

/**
 * @param {unknown} data
 * @param {string} approvalsUrl
 */
function blockedReason(data, approvalsUrl) {
  if (data !== null && typeof data === "object") {
    const d = /** @type {Record<string, unknown>} */ (data);
    const meta = d.metadata;
    if (typeof meta === "string" && meta.length > 0) {
      try {
        const parsed = JSON.parse(meta);
        if (parsed !== null && typeof parsed === "object" && "block_reason" in parsed) {
          const br = /** @type {Record<string, unknown>} */ (parsed).block_reason;
          if (typeof br === "string" && br.length > 0) {
            return `Blocked by Multicorn Shield: ${br}. Grant access at ${approvalsUrl}`;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return `Blocked by Multicorn Shield. Grant access at ${approvalsUrl}`;
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${HOOK_PREFIX} could not read stdin (${msg}). Allowing.\n`);
    respond("allow");
    return;
  }

  /** @type {Record<string, unknown>} */
  let hookPayload;
  try {
    hookPayload = JSON.parse(raw.length > 0 ? raw : "{}");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${HOOK_PREFIX} invalid JSON (${msg}). Allowing.\n`);
    respond("allow");
    return;
  }

  const toolName = typeof hookPayload.tool_name === "string" ? hookPayload.tool_name : "";

  const mapped = mapToolName(toolName);
  if (mapped === null) {
    respond("allow");
    return;
  }
  const { service, actionType } = mapped;

  const toolInput =
    typeof hookPayload.tool_input === "object" && hookPayload.tool_input !== null
      ? /** @type {Record<string, unknown>} */ (hookPayload.tool_input)
      : {};

  const config = loadConfig();
  if (config === null || config.apiKey.length === 0 || config.agentName.length === 0) {
    respond("allow");
    return;
  }

  const paramsSerialized = scrubParameters(toolInput);
  const approvalsUrl = dashboardHintUrl(config.baseUrl);

  /** @type {Record<string, unknown>} */
  const metadata = {
    tool_name: toolName,
    session_id: typeof hookPayload.session_id === "string" ? hookPayload.session_id : "",
    cwd: typeof hookPayload.cwd === "string" ? hookPayload.cwd : "",
    parameters: paramsSerialized,
    source: "gemini-cli",
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: config.agentName,
    service,
    actionType,
    status: "pending",
    metadata,
    platform: "gemini-cli",
  };

  let statusCode;
  let bodyText;
  try {
    const res = await postJson(config.baseUrl, config.apiKey, payload);
    statusCode = res.statusCode;
    bodyText = res.bodyText;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${HOOK_PREFIX} Shield API unreachable (${msg}). Allowing.\n`);
    respond("allow");
    return;
  }

  const parsed = safeJsonParse(bodyText);
  const data = unwrapData(parsed);

  if (statusCode === 202) {
    const url = consentUrl(config.baseUrl, config.agentName, service, actionType);
    openBrowser(url);
    respond(
      "deny",
      `Action blocked by Multicorn Shield. Authorise at: ${url}`,
    );
    return;
  }

  if (statusCode === 201) {
    if (data === null || typeof data !== "object") {
      const url = consentUrl(config.baseUrl, config.agentName, service, actionType);
      respond(
        "deny",
        `Action blocked by Multicorn Shield. Authorise at: ${url}`,
      );
      return;
    }
    const st = String(/** @type {Record<string, unknown>} */ (data).status || "").toLowerCase();
    if (st === "approved") {
      respond("allow");
      return;
    }
    if (st === "blocked") {
      respond("deny", blockedReason(data, approvalsUrl));
      return;
    }
    const url = consentUrl(config.baseUrl, config.agentName, service, actionType);
    respond("deny", `Action blocked by Multicorn Shield. Authorise at: ${url}`);
    return;
  }

  const url = consentUrl(config.baseUrl, config.agentName, service, actionType);
  respond("deny", `Action blocked by Multicorn Shield. Authorise at: ${url}`);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`${HOOK_PREFIX} unexpected error (${msg}). Allowing.\n`);
  respond("allow");
});
