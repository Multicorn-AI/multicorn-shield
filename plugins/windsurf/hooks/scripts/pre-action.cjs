/**
 * Windsurf Cascade pre-hook: permission check before read, write, terminal, or MCP tool use.
 * Routes by stdin JSON field agent_action_name (see Windsurf Cascade Hooks docs).
 * Fail-closed on API errors once config is loaded. Fail-open if Shield is not configured.
 */

"use strict";

const { execFileSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const AUTH_HEADER = "X-Multicorn-Key";
const LOG_PREFIX = "[multicorn-shield] Windsurf pre-hook:";
const HOOK_TEST_FAST_POLL = process.env.MULTICORN_SHIELD_WINDSURF_PRE_HOOK_TEST_FAST_POLL === "1";
const POLL_INTERVAL_MS = HOOK_TEST_FAST_POLL ? 1 : 3000;
const MAX_APPROVAL_POLLS = HOOK_TEST_FAST_POLL ? 3 : 100;

/** @type {Readonly<Record<string, { service: string; actionType: string }>>} */
const PRE_EVENT_MAP = {
  pre_read_code: { service: "filesystem", actionType: "read" },
  pre_write_code: { service: "filesystem", actionType: "write" },
  pre_run_command: { service: "terminal", actionType: "execute" },
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

// Duplicated in post-action.cjs. CJS hooks cannot import shared TypeScript modules.
/**
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
function resolveWindsurfAgentName(obj) {
  const agents = obj.agents;
  if (Array.isArray(agents)) {
    for (const entry of agents) {
      if (
        entry &&
        typeof entry === "object" &&
        /** @type {{ platform?: string; name?: string }} */ (entry).platform === "windsurf" &&
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
    const agentName = resolveWindsurfAgentName(obj);
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
  params.set("platform", "windsurf");
  return `${origin}/consent?${params.toString()}`;
}

/**
 * @param {unknown} toolInfo
 * @returns {{ service: string; actionType: string }}
 */
function mapMcpPre(toolInfo) {
  if (toolInfo === null || typeof toolInfo !== "object") {
    return { service: "mcp", actionType: "execute" };
  }
  const t = /** @type {Record<string, unknown>} */ (toolInfo);
  const server = String(t.mcp_server_name ?? "unknown").trim() || "unknown";
  const tool = String(t.mcp_tool_name ?? "unknown").trim() || "unknown";
  const safeServer = server.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const safeTool = tool.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return { service: `mcp:${safeServer}.${safeTool}`, actionType: "execute" };
}

/**
 * @param {string} agentActionName
 * @param {unknown} toolInfo
 * @returns {{ service: string; actionType: string } | null}
 */
function mapPreEvent(agentActionName, toolInfo) {
  const name = String(agentActionName || "").trim();
  if (name === "pre_mcp_tool_use") {
    return mapMcpPre(toolInfo);
  }
  const mapped = PRE_EVENT_MAP[name];
  if (mapped !== undefined) {
    return mapped;
  }
  return null;
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
            return (
              `${LOG_PREFIX} Action blocked: ${br}\n` +
              `  Grant access in the Shield dashboard and retry.\n` +
              `  Detail: ${approvalsUrl}\n`
            );
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return (
    `${LOG_PREFIX} Action blocked: Multicorn Shield blocked this action. Required permission: ${service} (${actionType}).\n` +
    `  Grant access in the Shield dashboard and retry.\n` +
    `  Detail: ${approvalsUrl}\n`
  );
}

/**
 * @param {string} agentName
 * @returns {string}
 */
function consentMarkerPath(agentName) {
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.homedir(), ".multicorn", `.consent-windsurf-${safe}`);
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
    process.stderr.write(
      `${LOG_PREFIX} Action blocked: this action requires approval before it can run.\n` +
        `  Grant access in the Shield dashboard and retry.\n` +
        `  Detail: ${approvalsUrl}\n`,
    );
    process.exit(2);
  }

  const url = consentUrl(config.baseUrl, config.agentName, service, actionType);
  writeConsentMarker(config.agentName);
  openBrowser(url);
  process.stderr.write("Opening Shield consent screen... Waiting for approval (up to 5 min).\n");

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
      process.stderr.write(
        `${LOG_PREFIX} Action blocked: Shield denied this approval request.\n` +
          `  Request access again from the Shield dashboard and retry.\n` +
          `  Detail: ${reason}\n`,
      );
      process.exit(2);
    }
    if (st === "expired") {
      process.stderr.write(
        `${LOG_PREFIX} Action blocked: this approval request expired.\n` +
          `  Start the action again and complete approval when prompted.\n` +
          `  Detail: status=expired\n`,
      );
      process.exit(2);
    }
    if (st === "pending") {
      continue;
    }
  }

  process.stderr.write(
    `${LOG_PREFIX} Action blocked: approval timed out after 5 minutes.\n` +
      `  Approve in the Shield dashboard, then retry.\n` +
      `  Detail: approvalsUrl=${approvalsUrl}\n`,
  );
  process.exit(2);
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${LOG_PREFIX} could not read stdin (${msg}). Allowing action.\n`);
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
    process.stderr.write(`${LOG_PREFIX} invalid JSON (${msg}). Allowing action.\n`);
    process.exit(0);
  }

  const agentActionName =
    typeof hookPayload.agent_action_name === "string" ? hookPayload.agent_action_name : "";

  if (process.env.MULTICORN_SHIELD_WINDSURF_PRE_HOOK_TEST_SERIALIZE_FAIL === "1") {
    hookPayload.tool_info = {
      toJSON() {
        throw new TypeError("MULTICORN_SHIELD_WINDSURF_PRE_HOOK_TEST_SERIALIZE_FAIL");
      },
    };
  }

  const toolInfo = hookPayload.tool_info;

  const mapped = mapPreEvent(agentActionName, toolInfo);
  if (mapped === null) {
    process.exit(0);
  }
  const { service, actionType } = mapped;

  let toolInfoSerialized;
  try {
    toolInfoSerialized =
      typeof toolInfo === "string"
        ? toolInfo
        : JSON.stringify(toolInfo === undefined ? null : toolInfo);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `${LOG_PREFIX} could not serialize tool_info (${msg}). Allowing action.\n`,
    );
    process.exit(0);
  }

  const approvalsUrl = dashboardHintUrl(config.baseUrl);

  /** @type {Record<string, unknown>} */
  const metadata = {
    agent_action_name: agentActionName,
    trajectory_id: typeof hookPayload.trajectory_id === "string" ? hookPayload.trajectory_id : "",
    execution_id: typeof hookPayload.execution_id === "string" ? hookPayload.execution_id : "",
    model_name: typeof hookPayload.model_name === "string" ? hookPayload.model_name : "",
    tool_info: toolInfoSerialized,
    source: "windsurf",
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: config.agentName,
    service,
    actionType,
    status: "pending",
    metadata,
    platform: "windsurf",
  };

  if (process.env.MULTICORN_SHIELD_WINDSURF_PRE_HOOK_TEST_THROW === "1") {
    throw new Error("MULTICORN_SHIELD_WINDSURF_PRE_HOOK_TEST_THROW");
  }

  let statusCode;
  let bodyText;
  try {
    const res = await postJson(config.baseUrl, config.apiKey, payload);
    statusCode = res.statusCode;
    bodyText = res.bodyText;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `${LOG_PREFIX} Action blocked: Shield API unreachable, cannot verify permissions.\n` +
        `  Check that the Shield service is running and retry.\n` +
        `  Detail: ${msg}\n`,
    );
    process.exit(2);
  }

  const parsed = safeJsonParse(bodyText);
  const data = unwrapData(parsed);

  if (statusCode === 202) {
    if (data === null || typeof data !== "object") {
      process.stderr.write(
        `${LOG_PREFIX} Action blocked: this action needs approval in the Shield dashboard before it can run.\n` +
          `  Open the approvals page and complete approval, then retry.\n` +
          `  Detail: missing approval data in Shield response\n`,
      );
      process.exit(2);
    }
    const approvalIdRaw = /** @type {Record<string, unknown>} */ (data).approval_id;
    const approvalId = typeof approvalIdRaw === "string" ? approvalIdRaw : "";
    if (approvalId.length === 0) {
      process.stderr.write(
        `${LOG_PREFIX} Action blocked: this action needs approval in the Shield dashboard before it can run.\n` +
          `  Open the approvals page and complete approval, then retry.\n` +
          `  Detail: approval_id missing in Shield response\n`,
      );
      process.exit(2);
    }
    await handlePendingWithConsentAndPoll(config, approvalId, service, actionType, approvalsUrl);
    return;
  }

  if (statusCode === 201) {
    if (data === null || typeof data !== "object") {
      const detail = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
      process.stderr.write(
        `${LOG_PREFIX} Action blocked: unexpected Shield response, cannot verify permissions.\n` +
          `  Check that the Shield service is healthy and retry.\n` +
          `  Detail: ${detail}\n`,
      );
      process.exit(2);
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
      `${LOG_PREFIX} Action blocked: ambiguous Shield status, cannot verify permissions.\n` +
        `  Check that your Shield API and plugin versions match, then retry.\n` +
        `  Detail: status=${JSON.stringify(/** @type {Record<string, unknown>} */ (data).status)}\n`,
    );
    process.exit(2);
  }

  const httpDetail = bodyText.length > 300 ? `${bodyText.slice(0, 300)}...` : bodyText;
  process.stderr.write(
    `${LOG_PREFIX} Action blocked: Shield returned HTTP ${String(statusCode)}, cannot verify permissions.\n` +
      `  Check your API key, Shield service status, and rate limits, then retry.\n` +
      `  Detail: HTTP ${String(statusCode)} body=${httpDetail}\n`,
  );
  process.exit(2);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(
    `${LOG_PREFIX} Action blocked: unexpected error, cannot verify permissions.\n` +
      `  Retry the action. If it keeps failing, check Shield logs.\n` +
      `  Detail: ${msg}\n`,
  );
  process.exit(2);
});
