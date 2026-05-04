// Copyright (c) Multicorn AI Pty Ltd. MIT License. See LICENSE file.

/**
 * Shared helpers for GitHub Copilot preToolUse / postToolUse Shield hooks.
 */

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const AUTH_HEADER = "X-Multicorn-Key";
const HTTP_REQUEST_TIMEOUT_MS = 10000;

/** @type {Readonly<Record<string, { service: string; actionType: string }>>} */
const COPILOT_TOOL_MAP = {
  bash: { service: "terminal", actionType: "execute" },
  edit: { service: "filesystem", actionType: "write" },
  create: { service: "filesystem", actionType: "write" },
  view: { service: "filesystem", actionType: "read" },
  glob: { service: "filesystem", actionType: "read" },
  grep: { service: "filesystem", actionType: "read" },
};

/**
 * @param {string} label
 * @returns {string}
 */
function logPrefix(label) {
  return `[multicorn-shield] GitHub Copilot ${label}:`;
}

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
function resolveGithubCopilotAgentName(obj) {
  const agents = obj.agents;
  if (Array.isArray(agents)) {
    for (const entry of agents) {
      if (
        entry &&
        typeof entry === "object" &&
        /** @type {{ platform?: string; name?: string }} */ (entry).platform === "github-copilot" &&
        typeof /** @type {{ platform?: string; name?: string }} */ (entry).name === "string"
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
    const baseLower = baseUrl.toLowerCase();
    const isHttps = baseLower.startsWith("https://");
    const isLocal = baseLower.includes("localhost") || baseLower.includes("127.0.0.1");
    if (!isHttps && !isLocal) {
      process.stderr.write(
        `${logPrefix("config")} baseUrl must use HTTPS for non-local servers. Fail-open: Shield disabled.\n`,
      );
      return null;
    }
    const agentName = resolveGithubCopilotAgentName(obj);
    return { apiKey, baseUrl, agentName };
  } catch {
    return null;
  }
}

/**
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

  const mapped = COPILOT_TOOL_MAP[name];
  if (mapped !== undefined) {
    return mapped;
  }

  return { service: "unknown", actionType: "execute" };
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

function applyParameterScrub(parameters) {
  const scrubbedParams = { ...parameters };
  if (typeof scrubbedParams.content === "string") {
    scrubbedParams.content = `[${scrubbedParams.content.length} chars redacted]`;
  }
  if (typeof scrubbedParams.command === "string" && scrubbedParams.command.length > 200) {
    scrubbedParams.command = scrubbedParams.command.slice(0, 200) + "... [truncated]";
  }
  return scrubbedParams;
}

/**
 * @param {unknown} parameters
 * @param {number} [maxLen]
 * @returns {string}
 */
function buildScrubbedParametersJson(parameters, maxLen = 4096) {
  /** @type {Record<string, unknown>} */
  let base = {};
  if (typeof parameters === "object" && parameters !== null) {
    base = { .../** @type {Record<string, unknown>} */ (parameters) };
  } else if (typeof parameters === "string") {
    try {
      const p = JSON.parse(parameters);
      if (p !== null && typeof p === "object") {
        base = { .../** @type {Record<string, unknown>} */ (p) };
      } else {
        base = { raw: parameters };
      }
    } catch {
      base = { raw: parameters };
    }
  }

  const scrubbed = applyParameterScrub(base);
  let paramsSerialized;
  try {
    paramsSerialized = JSON.stringify(scrubbed);
  } catch {
    paramsSerialized = "{}";
  }
  if (paramsSerialized.length > maxLen) {
    paramsSerialized = paramsSerialized.slice(0, maxLen);
  }
  return paramsSerialized;
}

/**
 * @param {unknown} result
 * @returns {string}
 */
function scrubResultForMetadata(result) {
  if (typeof result !== "string") return "";
  let s = result;
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  s = s.replace(/\bmcs_[A-Za-z0-9_-]+\b/g, "[REDACTED]");
  s = s.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED]");
  s = s.replace(/Bearer\s+[^\s]+/gi, "[REDACTED]");
  s = s.replace(/\b(password|token)\s*[:=]\s*[^\s]+\b/gi, "[REDACTED]");
  if (s.length > 500) {
    s = s.slice(0, 500) + "[truncated]";
  }
  return s;
}

/**
 * Parses Copilot hook tool arguments (object or JSON string).
 * @param {unknown} toolArgs
 * @returns {Record<string, unknown>}
 */
function parseToolArgsObject(toolArgs) {
  if (typeof toolArgs === "object" && toolArgs !== null) {
    return /** @type {Record<string, unknown>} */ (toolArgs);
  }
  if (typeof toolArgs === "string" && toolArgs.length > 0) {
    try {
      const p = JSON.parse(toolArgs);
      if (p !== null && typeof p === "object") {
        return /** @type {Record<string, unknown>} */ (p);
      }
    } catch {
      /* ignore */
    }
  }
  return {};
}

module.exports = {
  AUTH_HEADER,
  logPrefix,
  HTTP_REQUEST_TIMEOUT_MS,
  COPILOT_TOOL_MAP,
  readStdin,
  loadConfig,
  resolveGithubCopilotAgentName,
  mapToolName,
  postJson,
  safeJsonParse,
  unwrapData,
  buildScrubbedParametersJson,
  scrubResultForMetadata,
  parseToolArgsObject,
};
