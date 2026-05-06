/**
 * Windsurf Cascade post-hook: logs completed actions to the Shield audit trail.
 * Routes by agent_action_name. Never blocks; always exit 0.
 */

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const AUTH_HEADER = "X-Multicorn-Key";
const LOG_PREFIX = "[multicorn-shield] Windsurf post-hook:";
const HTTP_REQUEST_TIMEOUT_MS =
  process.env.MULTICORN_SHIELD_WINDSURF_PRE_HOOK_TEST_FAST_POLL === "1" ? 100 : 10000;

/** @type {Readonly<Record<string, { service: string; actionType: string }>>} */
const POST_EVENT_MAP = {
  post_read_code: { service: "filesystem", actionType: "read" },
  post_write_code: { service: "filesystem", actionType: "write" },
  post_run_command: { service: "terminal", actionType: "execute" },
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

// Duplicated in pre-action.cjs. CJS hooks cannot import shared TypeScript modules.
/**
 * @param {string} cwdResolved
 * @param {string} workspacePath
 * @returns {boolean}
 */
function cwdUnderWorkspacePath(cwdResolved, workspacePath) {
  const w = path.resolve(workspacePath);
  const c = path.resolve(cwdResolved);
  if (c === w) return true;
  const prefix = w.endsWith(path.sep) ? w : w + path.sep;
  return c.startsWith(prefix);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} platform
 * @param {string} cwd
 * @returns {string}
 */
function pickAgentNameForPlatform(obj, platform, cwd) {
  const agents = obj.agents;
  if (!Array.isArray(agents)) {
    return typeof obj.agentName === "string" ? obj.agentName : "";
  }
  const matches = [];
  for (const entry of agents) {
    if (
      entry &&
      typeof entry === "object" &&
      /** @type {{ platform?: string; name?: string; workspacePath?: string }} */ (entry).platform ===
        platform &&
      typeof (/** @type {{ platform?: string; name?: string }} */ (entry).name) === "string"
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
  if (withWs.length === 0) {
    return matches[0].name;
  }
  const resolvedCwd = path.resolve(cwd);
  let best = null;
  let bestLen = -1;
  for (const m of withWs) {
    if (!cwdUnderWorkspacePath(resolvedCwd, m.workspacePath)) continue;
    const len = path.resolve(m.workspacePath).length;
    if (len > bestLen) {
      bestLen = len;
      best = m;
    }
  }
  if (best !== null) {
    return best.name;
  }
  return matches[0].name;
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
function resolveWindsurfAgentName(obj) {
  return pickAgentNameForPlatform(obj, "windsurf", process.cwd());
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
 * @param {unknown} toolInfo
 * @returns {{ service: string; actionType: string }}
 */
function mapMcpPost(toolInfo) {
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
function mapPostEvent(agentActionName, toolInfo) {
  const name = String(agentActionName || "").trim();
  if (name === "post_mcp_tool_use") {
    return mapMcpPost(toolInfo);
  }
  const mapped = POST_EVENT_MAP[name];
  if (mapped !== undefined) {
    return mapped;
  }
  return null;
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

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch {
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
  } catch {
    process.exit(0);
  }

  const agentActionName =
    typeof hookPayload.agent_action_name === "string" ? hookPayload.agent_action_name : "";
  const toolInfo = hookPayload.tool_info;

  const mapped = mapPostEvent(agentActionName, toolInfo);
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
  } catch {
    process.exit(0);
  }

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
    status: "approved",
    metadata,
    platform: "windsurf",
  };

  try {
    await postJson(config.baseUrl, config.apiKey, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `${LOG_PREFIX} Warning: failed to log action to Shield audit trail. Check your network connection and that your API key in ~/.multicorn/config.json is valid.\n  Detail: ${msg}\n`,
    );
  }

  process.exit(0);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(
    `${LOG_PREFIX} Warning: failed to log action to Shield audit trail. Check your network connection and that your API key in ~/.multicorn/config.json is valid.\n  Detail: ${msg}\n`,
  );
  process.exit(0);
});
