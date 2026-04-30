#!/usr/bin/env node
/**
 * Cline PostToolUse hook: logs completed actions to the Shield audit trail.
 * Reads JSON from stdin (Cline Hooks API), posts to Shield API.
 * Always returns {"cancel": false} - post hooks never block.
 */

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const AUTH_HEADER = "X-Multicorn-Key";
const LOG_PREFIX = "[multicorn-shield] Cline post-hook:";
const HTTP_REQUEST_TIMEOUT_MS =
  process.env.MULTICORN_SHIELD_CLINE_PRE_HOOK_TEST_FAST_POLL === "1" ? 100 : 10000;

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
 * Maps a Cline tool name to a Shield service/actionType pair.
 * @param {string} toolName
 * @returns {{ service: string; actionType: string }}
 */
function mapToolName(toolName) {
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
 * @param {Record<string, unknown>} bodyObj
 * @returns {Promise<void>}
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
      res.resume();
      res.on("end", () => {
        const code = res.statusCode ?? 0;
        if (code >= 200 && code < 300) {
          resolve();
        } else {
          reject(new Error(`HTTP ${String(code)}`));
        }
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
 * Outputs JSON response to stdout and exits.
 */
function respond() {
  process.stdout.write(JSON.stringify({ cancel: false }) + "\n");
  process.exit(0);
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch {
    respond();
    return;
  }

  const config = loadConfig();
  if (config === null || config.apiKey.length === 0 || config.agentName.length === 0) {
    respond();
    return;
  }

  /** @type {Record<string, unknown>} */
  let hookPayload;
  try {
    hookPayload = JSON.parse(raw.length > 0 ? raw : "{}");
  } catch {
    respond();
    return;
  }

  const postToolUse = hookPayload.postToolUse;
  if (postToolUse === null || typeof postToolUse !== "object") {
    respond();
    return;
  }

  const toolUse = /** @type {Record<string, unknown>} */ (postToolUse);
  const toolName = typeof toolUse.tool === "string" ? toolUse.tool : "";

  if (toolName.length === 0) {
    respond();
    return;
  }

  const { service, actionType } = mapToolName(toolName);

  let paramsSerialized;
  try {
    const parameters = toolUse.parameters;
    paramsSerialized =
      typeof parameters === "string"
        ? parameters
        : JSON.stringify(parameters === undefined ? null : parameters);
  } catch {
    paramsSerialized = "{}";
  }

  /** @type {Record<string, unknown>} */
  const metadata = {
    tool_name: toolName,
    task_id: typeof hookPayload.taskId === "string" ? hookPayload.taskId : "",
    cline_version: typeof hookPayload.clineVersion === "string" ? hookPayload.clineVersion : "",
    parameters: paramsSerialized,
    result: typeof toolUse.result === "string" ? toolUse.result.slice(0, 2048) : "",
    timing: typeof toolUse.timing === "object" ? JSON.stringify(toolUse.timing) : "",
    source: "cline",
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: config.agentName,
    service,
    actionType,
    status: "approved",
    metadata,
    platform: "cline",
  };

  try {
    await postJson(config.baseUrl, config.apiKey, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `${LOG_PREFIX} Warning: failed to log action to Shield audit trail. Detail: ${msg}\n`,
    );
  }

  respond();
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(
    `${LOG_PREFIX} Warning: failed to log action to Shield audit trail. Detail: ${msg}\n`,
  );
  respond();
});
