/**
 * Claude Code PreToolUse hook: asks Shield whether a tool call is allowed.
 * Fail-open on API errors or missing config so local work keeps moving.
 */

"use strict";

const { execFileSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const AUTH_HEADER = "X-Multicorn-Key";
const POLL_INTERVAL_MS = 3000;
const MAX_APPROVAL_POLLS = 100;

/** @type {Readonly<Record<string, { service: string; actionType: string }>>} */
const TOOL_MAP = {
  bash: { service: "terminal", actionType: "execute" },
  read: { service: "filesystem", actionType: "read" },
  write: { service: "filesystem", actionType: "write" },
  edit: { service: "filesystem", actionType: "write" },
  grep: { service: "filesystem", actionType: "read" },
  webfetch: { service: "web", actionType: "read" },
  task: { service: "subagent", actionType: "execute" },
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
    const agentName = typeof obj.agentName === "string" ? obj.agentName : "";
    return { apiKey, baseUrl, agentName };
  } catch {
    return null;
  }
}

/**
 * Dashboard web app origin (not API origin).
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
  return `${origin}/consent?${params.toString()}`;
}

/**
 * @param {string} toolName
 * @returns {{ service: string; actionType: string }}
 */
function mapTool(toolName) {
  const key = String(toolName || "")
    .trim()
    .toLowerCase();
  if (key.length === 0) {
    return { service: "unknown", actionType: "execute" };
  }
  const mapped = TOOL_MAP[key];
  if (mapped !== undefined) {
    return mapped;
  }
  return { service: key, actionType: "execute" };
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} path
 * @returns {Promise<{ statusCode: number; bodyText: string }>}
 */
function getJson(baseUrl, apiKey, path) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      const root = String(baseUrl).replace(/\/+$/, "");
      const p = path.startsWith("/") ? path : `/${path}`;
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
            return `${br}\nGrant access in the Shield dashboard: ${approvalsUrl}\n`;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return (
    `Multicorn Shield blocked this tool call. Required permission: ${service} (${actionType}).\n` +
    `Grant access in the Shield dashboard: ${approvalsUrl}\n`
  );
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
 * @param {{ apiKey: string; baseUrl: string; agentName: string }} config
 * @param {string} approvalId
 * @param {string} service
 * @param {string} actionType
 * @returns {Promise<void>}
 */
async function handlePendingWithConsentAndPoll(config, approvalId, service, actionType) {
  const url = consentUrl(config.baseUrl, config.agentName, service, actionType);
  openBrowser(url);
  process.stderr.write("Opening Shield consent screen in your browser. Waiting for approval...\n");

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
      process.exit(0);
    }
    if (st === "blocked" || st === "denied" || st === "rejected") {
      const reason =
        typeof d.reason === "string" && d.reason.length > 0 ? d.reason : "Approval denied.";
      process.stderr.write(`${reason}\n`);
      process.exit(2);
    }
    if (st === "expired") {
      process.stderr.write("This approval request expired. Try the tool call again.\n");
      process.exit(2);
    }
    if (st === "pending") {
      continue;
    }
  }

  process.stderr.write(
    "Approval timed out after 5 minutes. Please approve in the Shield dashboard and try again.\n",
  );
  process.exit(2);
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[multicorn-shield] PreToolUse: could not read stdin (${msg}). Allowing tool.\n`,
    );
    process.exit(0);
  }

  const config = loadConfig();
  if (config === null) {
    process.exit(0);
  }
  if (config.apiKey.length === 0 || config.agentName.length === 0) {
    process.exit(0);
  }

  /** @type {Record<string, unknown>} */
  let hookPayload;
  try {
    hookPayload = JSON.parse(raw.length > 0 ? raw : "{}");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[multicorn-shield] PreToolUse: invalid JSON (${msg}). Allowing tool.\n`);
    process.exit(0);
  }

  const toolNameRaw =
    (typeof hookPayload.tool_name === "string" && hookPayload.tool_name) ||
    (typeof hookPayload.toolName === "string" && hookPayload.toolName) ||
    "";
  const toolInput =
    hookPayload.tool_input !== undefined ? hookPayload.tool_input : hookPayload.toolInput;

  let toolInputSerialized;
  try {
    toolInputSerialized =
      typeof toolInput === "string"
        ? toolInput
        : JSON.stringify(toolInput === undefined ? null : toolInput);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[multicorn-shield] PreToolUse: could not serialize tool_input (${msg}). Allowing tool.\n`,
    );
    process.exit(0);
  }

  const { service, actionType } = mapTool(toolNameRaw);
  const approvalsUrl = dashboardHintUrl(config.baseUrl);

  /** @type {Record<string, unknown>} */
  const metadata = {
    tool_name: toolNameRaw,
    tool_input: toolInputSerialized,
    source: "claude-code",
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: config.agentName,
    service,
    actionType,
    status: "pending",
    metadata,
  };

  let statusCode;
  let bodyText;
  try {
    const res = await postJson(config.baseUrl, config.apiKey, payload);
    statusCode = res.statusCode;
    bodyText = res.bodyText;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[multicorn-shield] PreToolUse: Shield API unreachable (${msg}). Allowing tool.\n`,
    );
    process.exit(0);
  }

  const parsed = safeJsonParse(bodyText);
  const data = unwrapData(parsed);

  if (statusCode === 202) {
    if (data === null || typeof data !== "object") {
      process.stderr.write(
        `This action needs approval in the Shield dashboard before it can run.\nOpen: ${approvalsUrl}\n`,
      );
      process.exit(2);
    }
    const approvalIdRaw = /** @type {Record<string, unknown>} */ (data).approval_id;
    const approvalId = typeof approvalIdRaw === "string" ? approvalIdRaw : "";
    if (approvalId.length === 0) {
      process.stderr.write(
        `This action needs approval in the Shield dashboard before it can run.\nOpen: ${approvalsUrl}\n`,
      );
      process.exit(2);
    }
    await handlePendingWithConsentAndPoll(config, approvalId, service, actionType);
    return;
  }

  if (statusCode === 201) {
    if (data === null || typeof data !== "object") {
      process.stderr.write(
        "[multicorn-shield] PreToolUse: unexpected Shield response. Allowing tool.\n",
      );
      process.exit(0);
    }
    const st = String(/** @type {Record<string, unknown>} */ (data).status || "").toLowerCase();
    if (st === "approved") {
      process.exit(0);
    }
    if (st === "blocked") {
      process.stderr.write(blockedMessage(data, service, actionType, approvalsUrl));
      process.exit(2);
    }
    process.stderr.write(
      "[multicorn-shield] PreToolUse: ambiguous Shield status. Allowing tool.\n",
    );
    process.exit(0);
  }

  process.stderr.write(
    `[multicorn-shield] PreToolUse: Shield returned HTTP ${String(statusCode)}. Allowing tool.\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[multicorn-shield] PreToolUse: error (${msg}). Allowing tool.\n`);
  process.exit(0);
});
