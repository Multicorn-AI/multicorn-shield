/**
 * Claude Code PostToolUse hook: logs completed tool calls to Shield (audit trail).
 * Never blocks; always exit 0.
 *
 * Tool mapping: see `./claude-code-tool-map.cjs` (built from `src/hooks/claude-code-tool-map.ts`).
 */

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const { mapClaudeCodeToolToShield } = require("./claude-code-tool-map.cjs");

const AUTH_HEADER = "X-Multicorn-Key";

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

// Agent resolution for Claude Code (duplicated in pre-tool-use.cjs).
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
function resolveClaudeCodeAgentName(obj) {
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
        .platform === "claude-code" &&
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
    const agentName = resolveClaudeCodeAgentName(obj);
    return { apiKey, baseUrl, agentName };
  } catch {
    return null;
  }
}

/**
 * @param {string} urlString
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
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload, "utf8"),
        [AUTH_HEADER]: apiKey,
      },
    };
    const req = lib.request(options, (res) => {
      res.resume();
      res.on("end", () => resolve());
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

  const toolNameRaw =
    (typeof hookPayload.tool_name === "string" && hookPayload.tool_name) ||
    (typeof hookPayload.toolName === "string" && hookPayload.toolName) ||
    "";
  const toolInput =
    hookPayload.tool_input !== undefined ? hookPayload.tool_input : hookPayload.toolInput;
  const toolResult =
    hookPayload.tool_result !== undefined
      ? hookPayload.tool_result
      : hookPayload.toolResult !== undefined
        ? hookPayload.toolResult
        : undefined;

  let toolInputSerialized;
  let toolResultSerialized;
  try {
    toolInputSerialized =
      typeof toolInput === "string"
        ? toolInput
        : JSON.stringify(toolInput === undefined ? null : toolInput);
    toolResultSerialized =
      typeof toolResult === "string"
        ? toolResult
        : JSON.stringify(toolResult === undefined ? null : toolResult);
  } catch {
    process.exit(0);
  }

  const { service, actionType } = mapClaudeCodeToolToShield(toolNameRaw, toolInput);

  /** @type {Record<string, unknown>} */
  const metadata = {
    tool_name: toolNameRaw,
    tool_input: toolInputSerialized,
    tool_result: toolResultSerialized,
    source: "claude-code",
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: config.agentName,
    service,
    actionType,
    status: "approved",
    metadata,
    platform: "claude-code",
  };

  try {
    await postJson(config.baseUrl, config.apiKey, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[multicorn-shield] PostToolUse: Warning: failed to log action to Shield audit trail.\n  Detail: ${msg}\n`,
    );
  }

  process.exit(0);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(
    `[multicorn-shield] PostToolUse: Warning: failed to log action to Shield audit trail.\n  Detail: ${msg}\n`,
  );
  process.exit(0);
});
