#!/usr/bin/env node
/**
 * Cline PreToolUse hook: asks Shield whether a tool call is allowed.
 * Reads JSON from stdin (Cline Hooks API), checks permissions via Shield API.
 * Returns {"cancel": false} to allow, {"cancel": true, "errorMessage": "..."} to block.
 * Fail-open if Shield is not configured or API is unreachable.
 */

"use strict";

const { execFileSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const AUTH_HEADER = "X-Multicorn-Key";
const LOG_PREFIX = "[multicorn-shield] Cline pre-hook:";
const HOOK_TEST_FAST_POLL = process.env.MULTICORN_SHIELD_CLINE_PRE_HOOK_TEST_FAST_POLL === "1";
const POLL_INTERVAL_MS = HOOK_TEST_FAST_POLL ? 1 : 3000;
const MAX_APPROVAL_POLLS = HOOK_TEST_FAST_POLL ? 3 : 100;
const HTTP_REQUEST_TIMEOUT_MS = HOOK_TEST_FAST_POLL ? 100 : 10000;

/** @type {Readonly<Record<string, { service: string; actionType: string }>>} */
const TOOL_MAP = {
  read_file: { service: "filesystem", actionType: "read" },
  write_to_file: { service: "filesystem", actionType: "write" },
  replace_in_file: { service: "filesystem", actionType: "write" },
  execute_command: { service: "terminal", actionType: "execute" },
  browser_action: { service: "browser", actionType: "execute" },
  list_files: { service: "filesystem", actionType: "read" },
  search_files: { service: "filesystem", actionType: "read" },
  list_code_definition_names: { service: "filesystem", actionType: "read" },
};

/**
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
function resolveClineAgentName(obj) {
  const agents = obj.agents;
  if (Array.isArray(agents)) {
    for (const entry of agents) {
      if (
        entry &&
        typeof entry === "object" &&
        /** @type {{ platform?: string; name?: string }} */ (entry).platform === "cline" &&
        typeof (/** @type {{ platform?: string; name?: string }} */ (entry).name) === "string"
      ) {
        return /** @type {{ name: string }} */ (entry).name;
      }
    }
  }
  return typeof obj.agentName === "string" ? obj.agentName : "";
}

/**
 * @returns {{ apiKey: string; baseUrl: string; agentName: string } | null}
 */
function loadConfig() {
  try {
    const configPath = path.join(os.homedir(), ".multicorn", "config.json");
    const raw = fs.readFileSync(configPath, "utf8");
    const obj = JSON.parse(raw);
    const apiKey = typeof obj.apiKey === "string" ? obj.apiKey : "";
    const baseUrl =
      typeof obj.baseUrl === "string" && obj.baseUrl.length > 0
        ? obj.baseUrl.replace(/\/+$/, "")
        : "https://api.multicorn.ai";
    const agentName = resolveClineAgentName(obj);
    return { apiKey, baseUrl, agentName };
  } catch {
    return null;
  }
}

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

/**
 * @param {string} apiBaseUrl
 * @returns {string}
 */
function dashboardHintUrl(apiBaseUrl) {
  return `${dashboardOrigin(apiBaseUrl)}/approvals`;
}

/**
 * @param {string} apiBaseUrl
 * @param {string} agentName
 * @param {string} service
 * @param {string} actionType
 * @returns {string}
 */
function consentUrl(apiBaseUrl, agentName, service, actionType) {
  const origin = dashboardOrigin(apiBaseUrl);
  const params = new URLSearchParams();
  params.set("agent", agentName);
  params.set("scopes", `${service}:${actionType}`);
  params.set("platform", "cline");
  return `${origin}/consent?${params.toString()}`;
}

/**
 * Maps a Cline tool name to a Shield service/actionType pair.
 * MCP tools (prefixed mcp_ or containing server context) map to mcp:<server>.<tool>.
 * @param {string} toolName
 * @param {Record<string, unknown>} parameters
 * @returns {{ service: string; actionType: string }}
 */
function mapToolName(toolName, parameters) {
  const name = String(toolName || "").trim();

  if (name.startsWith("mcp_") || name.includes("__")) {
    const parts = name.startsWith("mcp_") ? name.slice(4) : name;
    const sepIdx = parts.indexOf("__");
    if (sepIdx > 0) {
      const server = parts.slice(0, sepIdx).replace(/[^a-zA-Z0-9._-]+/g, "_");
      const tool = parts.slice(sepIdx + 2).replace(/[^a-zA-Z0-9._-]+/g, "_");
      return { service: `mcp:${server}.${tool}`, actionType: "execute" };
    }
    const safe = parts.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return { service: `mcp:${safe}`, actionType: "execute" };
  }

  const mapped = TOOL_MAP[name];
  if (mapped !== undefined) {
    return mapped;
  }

  return { service: "unknown", actionType: "execute" };
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} reqPath
 * @returns {Promise<{ statusCode: number; bodyText: string }>}
 */
function getJson(baseUrl, apiKey, reqPath) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      const root = String(baseUrl).replace(/\/+$/, "");
      const p = reqPath.startsWith("/") ? reqPath : `/${reqPath}`;
      u = new URL(`${root}${p}`);
    } catch (e) {
      reject(e);
      return;
    }
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const port = u.port || (isHttps ? 443 : 80);
    const options = {
      hostname: u.hostname,
      port,
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        Connection: "close",
        [AUTH_HEADER]: apiKey,
      },
    };
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          bodyText: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.setTimeout(HTTP_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {Record<string, unknown>} bodyObj
 * @returns {Promise<{ statusCode: number; bodyText: string }>}
 */
function postJson(baseUrl, apiKey, bodyObj) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      const root = String(baseUrl).replace(/\/+$/, "");
      u = new URL(`${root}/api/v1/actions`);
    } catch (e) {
      reject(e);
      return;
    }
    const payload = JSON.stringify(bodyObj);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const port = u.port || (isHttps ? 443 : 80);
    const options = {
      hostname: u.hostname,
      port,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        Connection: "close",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload, "utf8"),
        [AUTH_HEADER]: apiKey,
      },
    };
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          bodyText: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.setTimeout(HTTP_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} body
 * @returns {unknown}
 */
function unwrapData(body) {
  if (typeof body !== "object" || body === null) return null;
  const o = /** @type {Record<string, unknown>} */ (body);
  return o.success === true ? o.data : null;
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
 * @param {string} agentName
 * @returns {string}
 */
function consentMarkerPath(agentName) {
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.homedir(), ".multicorn", `.consent-cline-${safe}`);
}

/**
 * @param {string} agentName
 * @returns {boolean}
 */
function hasConsentMarker(agentName) {
  try {
    fs.accessSync(consentMarkerPath(agentName));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} agentName
 */
function writeConsentMarker(agentName) {
  try {
    const marker = consentMarkerPath(agentName);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, String(Date.now()), "utf8");
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} url
 */
function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      execSync(`start "" ${JSON.stringify(url)}`, {
        shell: true,
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

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Outputs JSON response to stdout and exits.
 * @param {boolean} cancel
 * @param {string} [errorMessage]
 */
function respond(cancel, errorMessage) {
  const response = cancel ? { cancel: true, errorMessage } : { cancel: false };
  process.stdout.write(JSON.stringify(response) + "\n");
  process.exit(0);
}

/**
 * @param {{ apiKey: string; baseUrl: string; agentName: string }} config
 * @param {string} approvalId
 * @param {string} service
 * @param {string} actionType
 * @param {string} approvalsUrl
 * @returns {Promise<void>}
 */
async function handlePendingWithConsentAndPoll(
  config,
  approvalId,
  service,
  actionType,
  approvalsUrl,
) {
  if (hasConsentMarker(config.agentName)) {
    respond(
      true,
      `Shield: This action requires approval before it can run. Grant access at ${approvalsUrl}`,
    );
    return;
  }

  const url = consentUrl(config.baseUrl, config.agentName, service, actionType);
  writeConsentMarker(config.agentName);
  openBrowser(url);
  process.stderr.write(`${LOG_PREFIX} Opening Shield consent screen... Waiting for approval.\n`);

  for (let i = 0; i < MAX_APPROVAL_POLLS; i++) {
    if (i > 0) {
      await sleep(POLL_INTERVAL_MS);
    }
    let statusCode;
    let bodyText;
    try {
      const res = await getJson(config.baseUrl, config.apiKey, `/api/v1/approvals/${approvalId}`);
      statusCode = res.statusCode;
      bodyText = res.bodyText;
    } catch {
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
    const d = /** @type {Record<string, unknown>} */ (data);
    const st = String(d.status ?? "").toLowerCase();
    if (st === "approved") {
      respond(false);
      return;
    }
    if (st === "blocked" || st === "denied" || st === "rejected") {
      const reason =
        typeof d.reason === "string" && d.reason.length > 0 ? d.reason : "Approval denied.";
      respond(true, `Shield: Action denied - ${reason}. Review at ${approvalsUrl}`);
      return;
    }
    if (st === "expired") {
      respond(true, `Shield: Approval request expired. Retry the action and complete approval when prompted.`);
      return;
    }
    if (st === "pending") {
      continue;
    }
  }

  respond(true, `Shield: Approval timed out. Approve at ${approvalsUrl}, then retry.`);
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${LOG_PREFIX} could not read stdin (${msg}). Allowing action.\n`);
    respond(false);
    return;
  }

  const config = loadConfig();
  if (config === null) {
    respond(false);
    return;
  }
  if (config.apiKey.length === 0 || config.agentName.length === 0) {
    respond(false);
    return;
  }

  /** @type {Record<string, unknown>} */
  let hookPayload;
  try {
    hookPayload = JSON.parse(raw.length > 0 ? raw : "{}");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${LOG_PREFIX} invalid JSON (${msg}). Allowing action.\n`);
    respond(false);
    return;
  }

  const preToolUse = hookPayload.preToolUse;
  if (preToolUse === null || typeof preToolUse !== "object") {
    respond(false);
    return;
  }

  const toolUse = /** @type {Record<string, unknown>} */ (preToolUse);
  const toolName = typeof toolUse.toolName === "string" ? toolUse.toolName : (typeof toolUse.tool === "string" ? toolUse.tool : "");
  const parameters =
    typeof toolUse.parameters === "object" && toolUse.parameters !== null
      ? /** @type {Record<string, unknown>} */ (toolUse.parameters)
      : {};

  if (toolName.length === 0) {
    respond(false);
    return;
  }

  const { service, actionType } = mapToolName(toolName, parameters);

  let paramsSerialized;
  try {
    paramsSerialized = JSON.stringify(parameters);
  } catch {
    paramsSerialized = "{}";
  }

  if (paramsSerialized.length > 4096) {
    paramsSerialized = paramsSerialized.slice(0, 4096);
  }

  const approvalsUrl = dashboardHintUrl(config.baseUrl);

  /** @type {Record<string, unknown>} */
  const metadata = {
    tool_name: toolName,
    task_id: typeof hookPayload.taskId === "string" ? hookPayload.taskId : "",
    cline_version: typeof hookPayload.clineVersion === "string" ? hookPayload.clineVersion : "",
    parameters: paramsSerialized,
    source: "cline",
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: config.agentName,
    service,
    actionType,
    status: "pending",
    metadata,
    platform: "cline",
  };

  let statusCode;
  let bodyText;
  try {
    const res = await postJson(config.baseUrl, config.apiKey, payload);
    statusCode = res.statusCode;
    bodyText = res.bodyText;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${LOG_PREFIX} Shield API unreachable (${msg}). Allowing action.\n`);
    respond(false);
    return;
  }

  const parsed = safeJsonParse(bodyText);
  const data = unwrapData(parsed);

  if (statusCode === 202) {
    if (data === null || typeof data !== "object") {
      respond(
        true,
        `Shield: This action needs approval. Open ${approvalsUrl} to approve, then retry.`,
      );
      return;
    }
    const approvalIdRaw = /** @type {Record<string, unknown>} */ (data).approval_id;
    const approvalId = typeof approvalIdRaw === "string" ? approvalIdRaw : "";
    if (approvalId.length === 0) {
      respond(
        true,
        `Shield: This action needs approval. Open ${approvalsUrl} to approve, then retry.`,
      );
      return;
    }
    await handlePendingWithConsentAndPoll(config, approvalId, service, actionType, approvalsUrl);
    return;
  }

  if (statusCode === 201) {
    if (data === null || typeof data !== "object") {
      respond(
        true,
        `Shield: ${config.agentName} needs ${service}:${actionType} permission. Approve at ${consentUrl(config.baseUrl, config.agentName, service, actionType)} or review at ${approvalsUrl}`,
      );
      return;
    }
    const st = String(/** @type {Record<string, unknown>} */ (data).status || "").toLowerCase();
    if (st === "approved") {
      respond(false);
      return;
    }
    if (st === "blocked") {
      respond(true, blockedMessage(data, service, actionType, approvalsUrl));
      return;
    }
    respond(
      true,
      `Shield: ${config.agentName} needs ${service}:${actionType} permission. Approve at ${consentUrl(config.baseUrl, config.agentName, service, actionType)} or review at ${approvalsUrl}`,
    );
    return;
  }

  respond(
    true,
    `Shield: ${config.agentName} needs ${service}:${actionType} permission. Approve at ${consentUrl(config.baseUrl, config.agentName, service, actionType)} or review at ${approvalsUrl}`,
  );
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`${LOG_PREFIX} unexpected error (${msg}). Allowing action.\n`);
  respond(false);
});
