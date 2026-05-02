// Copyright (c) Multicorn AI Pty Ltd. MIT License. See LICENSE file.

/**
 * @file Shared helpers for Gemini CLI BeforeTool / AfterTool Shield hooks.
 */

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const AUTH_HEADER = "X-Multicorn-Key";
const HTTP_REQUEST_TIMEOUT_MS = 10000;

/** Tools that should pass through without calling Shield (internal / UX-only). */
const SKIP_TOOLS = new Set([
  "save_memory",
  "activate_skill",
  "get_internal_docs",
  "ask_user",
  "write_todos",
  "enter_plan_mode",
  "exit_plan_mode",
  "update_topic",
  "complete_task",
]);

/** @type {Readonly<Record<string, { service: string; actionType: string }>>} */
const TOOL_MAP = {
  read_file: { service: "filesystem", actionType: "read" },
  read_many_files: { service: "filesystem", actionType: "read" },
  list_directory: { service: "filesystem", actionType: "read" },
  glob: { service: "filesystem", actionType: "read" },
  grep_search: { service: "filesystem", actionType: "read" },
  write_file: { service: "filesystem", actionType: "write" },
  replace: { service: "filesystem", actionType: "write" },
  run_shell_command: { service: "terminal", actionType: "execute" },
  google_web_search: { service: "browser", actionType: "execute" },
  web_fetch: { service: "browser", actionType: "execute" },
};

function logPrefix(label) {
  return `[multicorn-shield] Gemini CLI ${label}:`;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

function resolveGeminiCliAgentName(obj) {
  const agents = obj.agents;
  if (Array.isArray(agents)) {
    for (const entry of agents) {
      if (
        entry &&
        typeof entry === "object" &&
        /** @type {{ platform?: string; name?: string }} */ (entry).platform === "gemini-cli" &&
        typeof (/** @type {{ platform?: string; name?: string }} */ (entry).name) === "string"
      ) {
        return /** @type {{ name: string }} */ (entry).name;
      }
    }
  }
  return typeof obj.agentName === "string" ? obj.agentName : "";
}

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
    const agentName = resolveGeminiCliAgentName(obj);
    return { apiKey, baseUrl, agentName };
  } catch {
    return null;
  }
}

/**
 * @param {string} toolName
 * @returns {{ service: string; actionType: string } | null} null = skip hook API calls
 */
function mapToolName(toolName) {
  const name = String(toolName || "").trim();
  if (name.length === 0) return null;
  if (SKIP_TOOLS.has(name)) return null;

  if (name.startsWith("mcp_")) {
    const rest = name.slice(4);
    const idx = rest.indexOf("_");
    if (idx <= 0) {
      const safe = rest.replace(/[^a-zA-Z0-9._-]+/g, "_");
      return { service: `mcp:${safe}`, actionType: "execute" };
    }
    const server = rest.slice(0, idx).replace(/[^a-zA-Z0-9._-]+/g, "_");
    const tool = rest.slice(idx + 1).replace(/[^a-zA-Z0-9._-]+/g, "_");
    return { service: `mcp:${server}.${tool}`, actionType: "execute" };
  }

  const mapped = TOOL_MAP[name];
  if (mapped !== undefined) {
    return mapped;
  }

  return { service: "unknown", actionType: "execute" };
}

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
    const hostname = u.hostname;
    /** @type {string} */
    const pathnamePlusSearch = u.pathname + u.search;
    const options = {
      hostname,
      port,
      path: pathnamePlusSearch,
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

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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

function scrubParameters(parameters, maxLen = 4096) {
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

function scrubResultForMetadata(result) {
  if (result === null || result === undefined) return "";
  let s;
  try {
    s = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    s = String(result);
  }
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
 * @param {string} apiBaseUrl
 * @param {string} agentName
 * @param {string} service
 * @param {string} actionType
 */
function consentUrl(apiBaseUrl, agentName, service, actionType) {
  let origin = "https://app.multicorn.ai";
  try {
    const raw = String(apiBaseUrl).replace(/\/+$/, "");
    const lower = raw.toLowerCase();
    if (lower.includes("localhost:8080") || lower.includes("127.0.0.1:8080")) {
      origin = "http://localhost:5173";
    } else {
      const u = new URL(raw);
      if (u.hostname.startsWith("api.")) {
        u.hostname = "app." + u.hostname.slice(4);
      }
      origin = u.origin;
    }
  } catch {
    /* keep default */
  }
  const params = new URLSearchParams();
  params.set("agent", agentName);
  params.set("scopes", `${service}:${actionType}`);
  params.set("platform", "gemini-cli");
  return `${origin}/consent?${params.toString()}`;
}

/** @param {string} url */
function openBrowser(url) {
  try {
    const { execFileSync } = require("node:child_process");
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

module.exports = {
  AUTH_HEADER,
  logPrefix,
  HTTP_REQUEST_TIMEOUT_MS,
  TOOL_MAP,
  readStdin,
  loadConfig,
  resolveGeminiCliAgentName,
  mapToolName,
  postJson,
  safeJsonParse,
  unwrapData,
  scrubParameters,
  scrubResultForMetadata,
  consentUrl,
  openBrowser,
};
