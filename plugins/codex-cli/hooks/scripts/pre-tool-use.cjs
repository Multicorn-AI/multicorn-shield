/**
 * Codex CLI PreToolUse hook: asks Shield whether a tool call is allowed.
 * Fail-closed on API errors once config is loaded. Fail-open only if Shield is not configured (no config file, no API key).
 *
 * Key difference from Claude Code: Codex supports JSON stdout responses with
 * `permissionDecision: "deny"` as the primary blocking mechanism, and exit code 2
 * only for fail-closed API errors.
 *
 * Tool mapping: see `./codex-cli-tool-map.cjs` (built from `src/hooks/codex-cli-tool-map.ts`).
 */

"use strict";

const { execFileSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const { mapCodexCliToolToShield } = require("./codex-cli-tool-map.cjs");

const AUTH_HEADER = "X-Multicorn-Key";
const HOOK_TEST_FAST_POLL = process.env.MULTICORN_SHIELD_PRE_HOOK_TEST_FAST_POLL === "1";
const POLL_INTERVAL_MS = HOOK_TEST_FAST_POLL ? 1 : 3000;
const MAX_APPROVAL_POLLS = HOOK_TEST_FAST_POLL ? 3 : 100;

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
 * @param {string} cwdResolved
 * @param {string} workspacePath
 * @returns {boolean}
 */
function cwdUnderWorkspacePath(cwdResolved, workspacePath) {
  const w = path.resolve(workspacePath);
  if (cwdResolved === w) return true;
  const prefix = w.endsWith(path.sep) ? w : w + path.sep;
  return cwdResolved.startsWith(prefix);
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
function resolveCodexCliAgentName(obj) {
  const cwdRaw =
    process.env.PWD !== undefined && String(process.env.PWD).length > 0
      ? process.env.PWD
      : process.cwd();
  const agents = obj.agents;
  const defaultAgentRaw = obj.defaultAgent;
  const defaultAgentName =
    typeof defaultAgentRaw === "string" && defaultAgentRaw.length > 0 ? defaultAgentRaw : "";

  if (!Array.isArray(agents)) {
    return typeof obj.agentName === "string" ? obj.agentName : "";
  }

  const matches = [];
  for (const entry of agents) {
    if (
      entry &&
      typeof entry === "object" &&
      /** @type {{ platform?: string; name?: string; workspacePath?: string }} */ (entry)
        .platform === "codex-cli" &&
      typeof (/** @type {{ name?: string }} */ (entry).name) === "string"
    ) {
      matches.push(/** @type {{ name: string; workspacePath?: string }} */ (entry));
    }
  }

  if (matches.length === 0) {
    return typeof obj.agentName === "string" ? obj.agentName : "";
  }

  const withWs = matches.filter(
    (m) => typeof m.workspacePath === "string" && m.workspacePath.length > 0,
  );
  const resolvedCwd = path.resolve(cwdRaw);
  let best = null;
  let bestLen = -1;
  for (const m of withWs) {
    if (!cwdUnderWorkspacePath(resolvedCwd, /** @type {string} */ (m.workspacePath))) continue;
    const len = path.resolve(/** @type {string} */ (m.workspacePath)).length;
    if (len > bestLen) {
      bestLen = len;
      best = m;
    }
  }
  if (best !== null) {
    return best.name;
  }
  if (defaultAgentName.length > 0) {
    const d = matches.find((m) => m.name === defaultAgentName);
    if (d !== undefined) return d.name;
  }
  return matches[0].name;
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
    const agentName = resolveCodexCliAgentName(obj);
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
  params.set("platform", "codex-cli");
  return `${origin}/consent?${params.toString()}`;
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
 * Output a Codex CLI deny response to stdout (JSON format).
 * @param {string} reason
 */
function denyViaStdout(reason) {
  const response = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
  process.stdout.write(response + "\n");
}

/**
 * @param {unknown} data
 * @param {string} service
 * @param {string} actionType
 * @param {string} approvalsUrl
 * @returns {string}
 */
function blockedReason(data, service, actionType, approvalsUrl) {
  if (data !== null && typeof data === "object") {
    const d = /** @type {Record<string, unknown>} */ (data);
    const meta = d.metadata;
    if (typeof meta === "string" && meta.length > 0) {
      try {
        const parsed = JSON.parse(meta);
        if (parsed !== null && typeof parsed === "object" && "block_reason" in parsed) {
          const br = /** @type {Record<string, unknown>} */ (parsed).block_reason;
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

/**
 * @param {string} agentName
 * @returns {string}
 */
function consentMarkerPath(agentName) {
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.homedir(), ".multicorn", `.consent-${safe}`);
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
 * @param {string} agentName
 */
function removeConsentMarker(agentName) {
  try {
    fs.unlinkSync(consentMarkerPath(agentName));
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
 * Polls GET /api/v1/approvals/{id} until the approval is decided or timeout.
 * Returns true if approved, false on timeout/error.
 * Outputs deny JSON on denial/expiry.
 *
 * @param {{ apiKey: string; baseUrl: string; agentName: string }} config
 * @param {string} approvalId
 * @param {string} approvalsUrl
 * @returns {Promise<boolean>}
 */
async function pollApprovalStatus(config, approvalId, approvalsUrl) {
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
      return true;
    }
    if (st === "blocked" || st === "denied" || st === "rejected") {
      const reason =
        typeof d.reason === "string" && d.reason.length > 0 ? d.reason : "Approval denied.";
      denyViaStdout(`Shield denied this approval request: ${reason}`);
      process.exit(0);
    }
    if (st === "expired") {
      denyViaStdout("Shield approval request expired. Retry the tool call and complete approval when prompted.");
      process.exit(0);
    }
    if (st === "pending") {
      continue;
    }
  }
  return false;
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
      `[multicorn-shield] PreToolUse: Waiting for approval (up to 5 min)...\n` +
        `  Approve in the Shield dashboard: ${approvalsUrl}\n`,
    );

    const approved = await pollApprovalStatus(config, approvalId, approvalsUrl);
    if (approved) {
      process.exit(0);
    }

    removeConsentMarker(config.agentName);

    denyViaStdout(`Shield approval timed out after 5 minutes. Approve at ${approvalsUrl} and retry.`);
    process.exit(0);
  }

  const url = consentUrl(config.baseUrl, config.agentName, service, actionType);
  writeConsentMarker(config.agentName);
  openBrowser(url);
  process.stderr.write("Opening Shield consent screen... Waiting for approval (up to 5 min).\n");

  const approved = await pollApprovalStatus(config, approvalId, approvalsUrl);
  if (approved) {
    process.exit(0);
  }

  denyViaStdout(`Shield approval timed out after 5 minutes. Approve at ${approvalsUrl} and retry.`);
  process.exit(0);
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
    (typeof hookPayload.tool_name === "string" && hookPayload.tool_name) || "";
  const toolInput =
    hookPayload.tool_input !== undefined ? hookPayload.tool_input : undefined;

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

  const { service, actionType } = mapCodexCliToolToShield(toolNameRaw, toolInput);
  const approvalsUrl = dashboardHintUrl(config.baseUrl);

  /** @type {Record<string, unknown>} */
  const metadata = {
    tool_name: toolNameRaw,
    tool_input: toolInputSerialized,
    source: "codex-cli",
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: config.agentName,
    service,
    actionType,
    status: "pending",
    metadata,
    platform: "codex-cli",
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
      `[multicorn-shield] PreToolUse: Action blocked: Shield API unreachable, cannot verify permissions.\n` +
        `  Check that the Shield service is running and retry.\n` +
        `  Detail: ${msg}\n`,
    );
    process.exit(2);
  }

  const parsed = safeJsonParse(bodyText);
  const data = unwrapData(parsed);

  if (statusCode === 202) {
    if (data === null || typeof data !== "object") {
      denyViaStdout("This action needs approval in the Shield dashboard before it can run.");
      process.exit(0);
    }
    const approvalIdRaw = /** @type {Record<string, unknown>} */ (data).approval_id;
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
        `[multicorn-shield] PreToolUse: Action blocked: unexpected Shield response, cannot verify permissions.\n` +
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
      denyViaStdout(blockedReason(data, service, actionType, approvalsUrl));
      process.exit(0);
    }
    process.stderr.write(
      `[multicorn-shield] PreToolUse: Action blocked: ambiguous Shield status, cannot verify permissions.\n` +
        `  Check that your Shield API and plugin versions match, then retry.\n` +
        `  Detail: status=${JSON.stringify(/** @type {Record<string, unknown>} */ (data).status)}\n`,
    );
    process.exit(2);
  }

  const httpDetail = bodyText.length > 300 ? `${bodyText.slice(0, 300)}...` : bodyText;
  process.stderr.write(
    `[multicorn-shield] PreToolUse: Action blocked: Shield returned HTTP ${String(statusCode)}, cannot verify permissions.\n` +
      `  Check your API key, Shield service status, and rate limits, then retry.\n` +
      `  Detail: HTTP ${String(statusCode)} body=${httpDetail}\n`,
  );
  process.exit(2);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(
    `[multicorn-shield] PreToolUse: Action blocked: unexpected error, cannot verify permissions.\n` +
      `  Retry the tool call. If it keeps failing, check Shield logs.\n` +
      `  Detail: ${msg}\n`,
  );
  process.exit(2);
});
