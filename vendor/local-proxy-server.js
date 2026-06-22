import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { isIP } from 'net';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

// ../multicorn-proxy/src/server.ts

// ../multicorn-proxy/node_modules/.pnpm/multicorn-shield@file+..+multicorn-shield/node_modules/multicorn-shield/dist/proxy.js
var BLOCKED_ERROR_CODE = -32e3;
var INTERNAL_ERROR_CODE = -32002;
var SERVICE_UNREACHABLE_ERROR_CODE = -32003;
var AUTH_ERROR_CODE = -32004;
function parseJsonRpcLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isJsonRpcRequest(parsed) ? parsed : null;
}
function extractToolCallParams(request) {
  if (request.method !== "tools/call") return null;
  if (typeof request.params !== "object" || request.params === null) return null;
  const params = request.params;
  const name = params["name"];
  const args = params["arguments"];
  if (typeof name !== "string") return null;
  if (typeof args !== "object" || args === null) return null;
  return { name, arguments: args };
}
function buildBlockedResponse(id, service, _permissionLevel, dashboardUrl) {
  const displayService = capitalize(service);
  const message = `Action blocked by Shield

This agent cannot use ${displayService}.

Configure permissions: ${dashboardUrl}`;
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: BLOCKED_ERROR_CODE,
      message
    }
  };
}
function buildInternalErrorResponse(id) {
  const message = "Action blocked: Shield encountered an internal error and cannot verify permissions. Check proxy logs for details.";
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: INTERNAL_ERROR_CODE,
      message
    }
  };
}
function buildServiceUnreachableResponse(id, dashboardUrl) {
  const message = `Action blocked: Shield cannot verify permissions (service unreachable). Configure offline behaviour at ${dashboardUrl}`;
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: SERVICE_UNREACHABLE_ERROR_CODE,
      message
    }
  };
}
function buildAuthErrorResponse(id) {
  const message = "Action blocked: Shield API key is invalid or has been revoked. Run npx multicorn-shield init to reconfigure.";
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: AUTH_ERROR_CODE,
      message
    }
  };
}
function isJsonRpcRequest(value) {
  if (typeof value !== "object" || value === null) return false;
  const obj = value;
  if (obj["jsonrpc"] !== "2.0") return false;
  if (typeof obj["method"] !== "string") return false;
  const id = obj["id"];
  const validId = id === null || id === void 0 || typeof id === "string" || typeof id === "number";
  return validId;
}
function capitalize(str) {
  if (str.length === 0) return str;
  const first = str[0];
  return first !== void 0 ? first.toUpperCase() + str.slice(1) : str;
}
function deriveDashboardUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      url.port = "5173";
      url.protocol = "http:";
      return url.toString();
    }
    if (url.hostname === "api.multicorn.ai") {
      url.hostname = "app.multicorn.ai";
      return url.toString();
    }
    if (url.hostname.includes("api")) {
      url.hostname = url.hostname.replace("api", "app");
      return url.toString();
    }
    if (url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return "https://app.multicorn.ai";
    }
    return "https://app.multicorn.ai";
  } catch {
    return "https://app.multicorn.ai";
  }
}
var ShieldAuthError = class _ShieldAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShieldAuthError";
    Object.setPrototypeOf(this, _ShieldAuthError.prototype);
  }
};
async function findAgentByName(agentName, apiKey, baseUrl) {
  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1/agents`, {
      headers: { "X-Multicorn-Key": apiKey },
      signal: AbortSignal.timeout(8e3)
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { id: "", name: agentName, scopes: [], authInvalid: true };
    }
    return null;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!isApiSuccessResponse(body)) return null;
  const agents = body.data;
  if (!Array.isArray(agents)) return null;
  const match = agents.find(
    (a) => isAgentSummaryShape(a) && a.name === agentName
  );
  if (match === void 0) return null;
  return { id: match.id, name: match.name, scopes: [] };
}
async function registerAgent(agentName, apiKey, baseUrl, platform) {
  const response = await fetch(`${baseUrl}/api/v1/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Multicorn-Key": apiKey
    },
    body: JSON.stringify({ name: agentName, ...platform ? { platform } : {} }),
    signal: AbortSignal.timeout(8e3)
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ShieldAuthError(
        `Failed to register agent "${agentName}": service returned ${String(response.status)}.`
      );
    }
    throw new Error(
      `Failed to register agent "${agentName}": service returned ${String(response.status)}.`
    );
  }
  const body = await response.json();
  if (!isApiSuccessResponse(body)) {
    throw new Error(`Failed to register agent "${agentName}": unexpected response format.`);
  }
  if (!isAgentSummaryShape(body.data)) {
    throw new Error(`Failed to register agent "${agentName}": response missing agent ID.`);
  }
  return body.data.id;
}
async function fetchGrantedScopes(agentId, apiKey, baseUrl) {
  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1/agents/${agentId}`, {
      headers: { "X-Multicorn-Key": apiKey },
      signal: AbortSignal.timeout(8e3)
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  const body = await response.json();
  if (!isApiSuccessResponse(body)) return [];
  const agentDetail = body.data;
  if (!isAgentDetailShape(agentDetail)) return [];
  const scopes = [];
  for (const perm of agentDetail.permissions) {
    if (!isPermissionShape(perm)) continue;
    if (perm.revoked_at !== null) continue;
    if (perm.read) scopes.push({ service: perm.service, permissionLevel: "read" });
    if (perm.write) scopes.push({ service: perm.service, permissionLevel: "write" });
    if (perm.delete === true) scopes.push({ service: perm.service, permissionLevel: "delete" });
    if (perm.execute) scopes.push({ service: perm.service, permissionLevel: "execute" });
  }
  return scopes;
}
function isApiSuccessResponse(value) {
  if (typeof value !== "object" || value === null) return false;
  const obj = value;
  return obj["success"] === true;
}
function isAgentSummaryShape(value) {
  if (typeof value !== "object" || value === null) return false;
  const obj = value;
  return typeof obj["id"] === "string" && typeof obj["name"] === "string";
}
function isAgentDetailShape(value) {
  if (typeof value !== "object" || value === null) return false;
  const obj = value;
  return Array.isArray(obj["permissions"]);
}
function isPermissionShape(value) {
  if (typeof value !== "object" || value === null) return false;
  const obj = value;
  return typeof obj["service"] === "string" && typeof obj["read"] === "boolean" && typeof obj["write"] === "boolean" && typeof obj["execute"] === "boolean" && (obj["revoked_at"] === null || obj["revoked_at"] === void 0 || typeof obj["revoked_at"] === "string");
}
var LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
function createLogger(level, output = process.stderr) {
  const minLevel = LOG_LEVELS[level];
  function write(logLevel, msg, data) {
    if (LOG_LEVELS[logLevel] < minLevel) return;
    const entry = {
      level: logLevel,
      time: (/* @__PURE__ */ new Date()).toISOString(),
      msg,
      ...data
    };
    output.write(JSON.stringify(entry) + "\n");
  }
  return {
    debug: (msg, data) => {
      write("debug", msg, data);
    },
    info: (msg, data) => {
      write("info", msg, data);
    },
    warn: (msg, data) => {
      write("warn", msg, data);
    },
    error: (msg, data) => {
      write("error", msg, data);
    }
  };
}
function isValidLogLevel(value) {
  return typeof value === "string" && Object.hasOwn(LOG_LEVELS, value);
}
var PERMISSION_LEVELS = {
  Read: "read",
  Write: "write",
  Delete: "delete",
  Execute: "execute",
  Publish: "publish",
  Create: "create"
};
var VALID_PERMISSION_LEVELS = new Set(Object.values(PERMISSION_LEVELS));
[...VALID_PERMISSION_LEVELS].join(", ");
function formatScope(scope) {
  return `${scope.permissionLevel}:${scope.service}`;
}
function validateScopeAccess(grantedScopes, requested) {
  const isGranted = grantedScopes.some(
    (granted) => granted.service === requested.service && granted.permissionLevel === requested.permissionLevel
  );
  if (isGranted) {
    return { allowed: true };
  }
  const serviceScopes = grantedScopes.filter((g) => g.service === requested.service);
  if (serviceScopes.length > 0) {
    const grantedLevels = serviceScopes.map((g) => `"${g.permissionLevel}"`).join(", ");
    return {
      allowed: false,
      reason: `Permission "${requested.permissionLevel}" is not granted for service "${requested.service}". Currently granted permission level(s): ${grantedLevels}. Requested scope "${formatScope(requested)}" requires explicit consent.`
    };
  }
  return {
    allowed: false,
    reason: `No permissions granted for service "${requested.service}". The agent has not been authorised to access this service. Request scope "${formatScope(requested)}" via the consent screen.`
  };
}
var FILESYSTEM_READ_TOOLS = /* @__PURE__ */ new Set([
  "read_file",
  "read_text_file",
  "read_media_file",
  "read_multiple_files",
  "list_directory",
  "list_dir",
  "directory_tree",
  "tree",
  "get_file_info",
  "stat",
  "search_files",
  "glob_file_search",
  "list_allowed_directories",
  "file_search"
]);
var FILESYSTEM_WRITE_TOOLS = /* @__PURE__ */ new Set([
  "write_file",
  "edit_file",
  "create_directory",
  "mkdir",
  "move_file",
  "rename",
  "delete_file",
  "remove_file",
  "copy_file"
]);
var TERMINAL_EXECUTE_TOOLS = /* @__PURE__ */ new Set([
  "run_terminal_cmd",
  "execute_command",
  "terminal_run",
  "run_command"
]);
var BROWSER_EXECUTE_TOOLS = /* @__PURE__ */ new Set([
  "web_fetch",
  "fetch_url",
  "browser_navigate",
  "navigate",
  "mcp_web_fetch"
]);
var INTEGRATION_SERVICE_BY_PREFIX = {
  gmail: "gmail",
  google_calendar: "google_calendar",
  calendar: "google_calendar",
  google_drive: "google_drive",
  drive: "google_drive",
  slack: "slack",
  payments: "payments",
  payment: "payments",
  stripe: "payments",
  github: "github",
  gitlab: "gitlab",
  notion: "notion",
  linear: "linear",
  jira: "jira"
};
function inferPermissionFromToolName(normalized) {
  if (normalized.includes("_read") || normalized.includes("_get") || normalized.includes("_list") || normalized.endsWith("_fetch") || normalized.includes("_search")) {
    return "read";
  }
  if (normalized.includes("_write") || normalized.includes("_send") || normalized.includes("_create") || normalized.includes("_update") || normalized.includes("_delete") || normalized.includes("_push") || normalized.includes("_commit") || normalized.includes("_post") || normalized.includes("_patch")) {
    return "write";
  }
  return "execute";
}
function mapMcpToolToScope(toolName) {
  const actionType = toolName.trim();
  const normalized = actionType.toLowerCase();
  if (normalized.length === 0) {
    return { service: "unknown", permissionLevel: "execute", actionType };
  }
  if (FILESYSTEM_READ_TOOLS.has(normalized)) {
    return { service: "filesystem", permissionLevel: "read", actionType };
  }
  if (FILESYSTEM_WRITE_TOOLS.has(normalized)) {
    return { service: "filesystem", permissionLevel: "write", actionType };
  }
  if (TERMINAL_EXECUTE_TOOLS.has(normalized)) {
    return { service: "terminal", permissionLevel: "execute", actionType };
  }
  if (BROWSER_EXECUTE_TOOLS.has(normalized)) {
    return { service: "browser", permissionLevel: "execute", actionType };
  }
  if (normalized === "read") {
    return { service: "filesystem", permissionLevel: "read", actionType };
  }
  if (normalized === "write" || normalized === "edit") {
    return { service: "filesystem", permissionLevel: "write", actionType };
  }
  if (normalized === "exec") {
    return { service: "terminal", permissionLevel: "execute", actionType };
  }
  if (normalized.startsWith("git_")) {
    const permissionLevel2 = inferPermissionFromToolName(normalized);
    return { service: "git", permissionLevel: permissionLevel2, actionType };
  }
  for (const [prefix, service] of Object.entries(INTEGRATION_SERVICE_BY_PREFIX)) {
    if (normalized.startsWith(`${prefix}_`) || normalized === prefix) {
      const permissionLevel2 = inferPermissionFromToolName(normalized);
      return { service, permissionLevel: permissionLevel2, actionType };
    }
  }
  const idx = normalized.indexOf("_");
  if (idx === -1) {
    return { service: normalized, permissionLevel: "execute", actionType };
  }
  const head = normalized.slice(0, idx);
  const tail = normalized.slice(idx + 1);
  let permissionLevel = "execute";
  if (tail.includes("read") || tail.includes("list") || tail.includes("get") || tail.includes("search") || tail.includes("fetch")) {
    permissionLevel = "read";
  } else if (tail.includes("write") || tail.includes("send") || tail.includes("create") || tail.includes("update") || tail.includes("delete") || tail.includes("remove")) {
    permissionLevel = "write";
  }
  return { service: head, permissionLevel, actionType };
}

// ../multicorn-proxy/src/auth.ts
function extractApiKey(headers, searchParams) {
  const multicornKey = headers["x-multicorn-key"];
  if (typeof multicornKey === "string" && multicornKey.length > 0) {
    return multicornKey;
  }
  const authHeader = headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token.length > 0) {
      return token;
    }
  }
  if (searchParams !== void 0) {
    const fromQuery = searchParams.get("key");
    if (typeof fromQuery === "string" && fromQuery.length > 0) {
      return fromQuery;
    }
  }
  return void 0;
}
function readProxyVersion() {
  if ("0.1.0".length > 0) {
    return "0.1.0";
  }
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const v = JSON.parse(raw);
    return typeof v.version === "string" ? v.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
var PROXY_VERSION = readProxyVersion();
var PROXY_VERSION_HEADER = "X-Multicorn-Proxy-Version";

// ../multicorn-proxy/src/config-resolver.ts
var MULTICORN_MCP_SENTINEL = "multicorn://mcp";
var PROXY_RESOLVE_SECRET_HEADER = "X-Multicorn-Proxy-Resolve-Secret";
var PROXY_LOCAL_HEADER = "X-Multicorn-Proxy-Local";
function hashKey(apiKey) {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}
var ALLOWED_SCHEMES = /* @__PURE__ */ new Set(["http:", "https:"]);
var ALLOWED_EXPLICIT_PORTS = /* @__PURE__ */ new Set(["80", "443", "8080", "8443"]);
var TargetUrlError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "TargetUrlError";
  }
};
function schemeLabel(protocol) {
  return protocol.endsWith(":") ? protocol.slice(0, -1) : protocol;
}
function ipv4ToParts(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = [];
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    nums.push(v);
  }
  return [nums[0], nums[1], nums[2], nums[3]];
}
function isBlockedIPv4Literal(host) {
  if (host === "0.0.0.0") return true;
  const quad = ipv4ToParts(host);
  if (quad === null) return false;
  const [a, b] = quad;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
function isBlockedIPv6Literal(host) {
  const h = host.toLowerCase();
  if (h === "::1") return true;
  if (h.startsWith("fe80:")) return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (mapped !== null) {
    return isBlockedIPv4Literal(mapped[1]);
  }
  return false;
}
function normaliseHostnameForValidation(hostname) {
  if (hostname.length >= 2 && hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}
function validateTargetUrl(targetUrl, allowPrivateTargets) {
  if (targetUrl === "multicorn://mcp") return;
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new TargetUrlError("targetUrl is not a valid URL");
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new TargetUrlError(`targetUrl uses blocked scheme: ${schemeLabel(parsed.protocol)}`);
  }
  if (allowPrivateTargets) {
    return;
  }
  const port = parsed.port;
  if (port !== "" && !ALLOWED_EXPLICIT_PORTS.has(port)) {
    throw new TargetUrlError(`targetUrl uses disallowed port: ${port}`);
  }
  const host = normaliseHostnameForValidation(parsed.hostname);
  if (host === "") {
    throw new TargetUrlError("targetUrl has empty host");
  }
  if (host === "0.0.0.0") {
    throw new TargetUrlError("targetUrl host is blocked: 0.0.0.0");
  }
  if (host.toLowerCase() === "localhost") {
    throw new TargetUrlError("targetUrl host is blocked: localhost");
  }
  const v = isIP(host);
  if (v === 4) {
    if (isBlockedIPv4Literal(host)) {
      throw new TargetUrlError(`targetUrl resolves to private IP range: ${host}`);
    }
  } else if (v === 6) {
    if (isBlockedIPv6Literal(host)) {
      throw new TargetUrlError(`targetUrl uses blocked IPv6 host: ${host}`);
    }
  }
}
function createConfigResolver(shieldApiBaseUrl, ttlMs, allowPrivateTargets, proxyResolveInternalSecret, mcpTtlMs = ttlMs) {
  const cache = /* @__PURE__ */ new Map();
  const lastSeenAgentName = /* @__PURE__ */ new Map();
  function prune() {
    const now = Date.now();
    for (const [k, b] of cache) {
      if (b.expiresAt <= now) cache.delete(k);
    }
  }
  return {
    hashKey,
    getLastSeenAgentName(routingToken) {
      return lastSeenAgentName.get(routingToken);
    },
    trackAgentName(routingToken, agentName) {
      const prev = lastSeenAgentName.get(routingToken);
      lastSeenAgentName.set(routingToken, agentName);
      return prev !== void 0 && prev !== agentName;
    },
    async resolve(routingToken, apiKey) {
      prune();
      const ck = `${routingToken}|${hashKey(apiKey)}`;
      const hit = cache.get(ck);
      if (hit !== void 0 && hit.expiresAt > Date.now()) {
        return hit.body;
      }
      const url = `${shieldApiBaseUrl}/api/v1/proxy/config/resolve/${encodeURIComponent(routingToken)}`;
      const headers = {
        "X-Multicorn-Key": apiKey,
        // Report the running proxy version so the backend can stamp the agent's
        // last-seen version + timestamp. Resolve runs on the first request and on
        // every cache miss (~60s while the agent is active), so it doubles as a
        // lightweight liveness heartbeat without a dedicated endpoint.
        [PROXY_VERSION_HEADER]: PROXY_VERSION
      };
      if (proxyResolveInternalSecret !== void 0 && proxyResolveInternalSecret.length > 0) {
        headers[PROXY_RESOLVE_SECRET_HEADER] = proxyResolveInternalSecret;
      }
      if (allowPrivateTargets) {
        headers[PROXY_LOCAL_HEADER] = "1";
      }
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15e3),
        redirect: "manual"
      });
      if (response.status === 401) {
        throw new ResolveError("unauthorized", "Invalid or missing API key");
      }
      if (response.status === 403) {
        throw new ResolveError("forbidden", "API key cannot access this route");
      }
      if (response.status === 404) {
        throw new ResolveError("not_found", "Unknown routing token");
      }
      if (!response.ok) {
        throw new ResolveError("upstream", `Resolve failed: HTTP ${String(response.status)}`);
      }
      const json = await response.json();
      if (!isSuccessEnvelope(json)) {
        throw new ResolveError("upstream", "Unexpected resolve response shape");
      }
      const body = parseProxyConfigResolveBody(json.data, allowPrivateTargets);
      if (body === null) {
        throw new ResolveError("upstream", "Unexpected resolve response shape");
      }
      const effectiveTtl = body.targetUrl === MULTICORN_MCP_SENTINEL ? mcpTtlMs : ttlMs;
      cache.set(ck, { body, expiresAt: Date.now() + effectiveTtl });
      return body;
    },
    invalidate(routingToken, apiKey) {
      cache.delete(`${routingToken}|${hashKey(apiKey)}`);
    }
  };
}
var ResolveError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ResolveError";
  }
};
function isSuccessEnvelope(v) {
  return typeof v === "object" && v !== null && v.success === true && "data" in v;
}
function parseProxyConfigResolveBody(v, allowPrivateTargets) {
  if (typeof v !== "object" || v === null) return null;
  const o = v;
  const targetUrl = typeof o["target_url"] === "string" ? o["target_url"] : typeof o["targetUrl"] === "string" ? o["targetUrl"] : void 0;
  const serverName = typeof o["server_name"] === "string" ? o["server_name"] : typeof o["serverName"] === "string" ? o["serverName"] : void 0;
  const userId = typeof o["user_id"] === "string" ? o["user_id"] : typeof o["userId"] === "string" ? o["userId"] : void 0;
  if (targetUrl === void 0 || serverName === void 0 || userId === void 0) {
    return null;
  }
  const platform = typeof o["platform"] === "string" && o["platform"].length > 0 ? o["platform"] : void 0;
  const agentName = typeof o["agent_name"] === "string" && o["agent_name"].length > 0 ? o["agent_name"] : typeof o["agentName"] === "string" && o["agentName"].length > 0 ? o["agentName"] : void 0;
  validateTargetUrl(targetUrl, allowPrivateTargets);
  const upstreamHeaders = parseResolveUpstreamHeaders(o);
  const serviceTokens = parseResolveServiceTokens(o);
  const upstreams = parseResolveUpstreams(o, allowPrivateTargets);
  let body = {
    targetUrl,
    serverName,
    userId,
    platform,
    agentName
  };
  if (upstreamHeaders !== void 0) {
    body = { ...body, upstreamHeaders };
  }
  if (serviceTokens !== void 0) {
    body = { ...body, serviceTokens };
  }
  if (upstreams !== void 0) {
    body = { ...body, upstreams };
  }
  return body;
}
var UPSTREAM_KINDS = /* @__PURE__ */ new Set(["builtin", "hosted", "local", "http"]);
function parseResolveUpstreams(o, allowPrivateTargets) {
  const raw = o["upstreams"];
  if (!Array.isArray(raw) || raw.length === 0) {
    return void 0;
  }
  const out = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item;
    const targetUrl = typeof obj["target_url"] === "string" ? obj["target_url"] : typeof obj["targetUrl"] === "string" ? obj["targetUrl"] : void 0;
    const kind = typeof obj["kind"] === "string" ? obj["kind"] : void 0;
    if (targetUrl === void 0 || kind === void 0 || !UPSTREAM_KINDS.has(kind)) {
      continue;
    }
    if (kind !== "builtin" && kind !== "local") {
      validateTargetUrl(targetUrl, allowPrivateTargets);
    }
    const localDir = typeof obj["local_dir"] === "string" ? obj["local_dir"] : typeof obj["localDir"] === "string" ? obj["localDir"] : void 0;
    const entry = { targetUrl, kind };
    out.push(localDir !== void 0 ? { ...entry, localDir } : entry);
  }
  return out.length > 0 ? out : void 0;
}
function parseResolveServiceTokens(o) {
  const raw = o["service_tokens"] ?? o["serviceTokens"];
  if (raw === null || raw === void 0 || typeof raw !== "object" || Array.isArray(raw)) {
    return void 0;
  }
  const obj = raw;
  const google = parseSingleServiceToken(obj["google"]);
  if (google === void 0) {
    return void 0;
  }
  return { google };
}
function parseSingleServiceToken(raw) {
  if (raw === null || raw === void 0 || typeof raw !== "object" || Array.isArray(raw)) {
    return void 0;
  }
  const obj = raw;
  const accessToken = typeof obj["access_token"] === "string" ? obj["access_token"] : typeof obj["accessToken"] === "string" ? obj["accessToken"] : void 0;
  if (accessToken === void 0 || accessToken.length === 0) {
    return void 0;
  }
  const grantedScopes = typeof obj["granted_scopes"] === "string" ? obj["granted_scopes"] : typeof obj["grantedScopes"] === "string" ? obj["grantedScopes"] : "";
  return { accessToken, grantedScopes };
}
var MAX_RESOLVE_UPSTREAM_ENTRIES = 16;
function parseResolveUpstreamHeaders(o) {
  const raw = o["upstream_headers"] ?? o["upstreamHeaders"];
  if (raw === null || raw === void 0) {
    return void 0;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return void 0;
  }
  const obj = raw;
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return void 0;
  }
  if (entries.length > MAX_RESOLVE_UPSTREAM_ENTRIES) {
    return void 0;
  }
  const out = {};
  for (const [k, v] of entries) {
    if (typeof v !== "string" || v.length === 0) {
      continue;
    }
    const name = k.trim();
    if (name.length === 0 || name.length > 128) {
      continue;
    }
    out[name] = v;
  }
  return Object.keys(out).length > 0 ? out : void 0;
}

// ../multicorn-proxy/src/env.ts
function loadEnv() {
  const port = Number(process.env["PORT"] ?? 3e3);
  const hostRaw = process.env["HOST"]?.trim();
  const host = hostRaw !== void 0 && hostRaw.length > 0 ? hostRaw : void 0;
  const base = process.env["SHIELD_API_BASE_URL"]?.trim().replace(/\/+$/, "") ?? "https://api.multicorn.ai";
  const rawLevel = process.env["LOG_LEVEL"] ?? "info";
  const logLevel = isValidLogLevel(rawLevel) ? rawLevel : "info";
  const allowPrivateTargets = process.env["ALLOW_PRIVATE_TARGETS"] === "true";
  const resolveSecretRaw = process.env["MULTICORN_PROXY_RESOLVE_INTERNAL_SECRET"]?.trim();
  return {
    port: Number.isFinite(port) && port > 0 ? port : 3e3,
    host,
    shieldApiBaseUrl: base,
    logLevel,
    rateLimitRpm: Math.max(1, Number(process.env["RATE_LIMIT_RPM"] ?? 100)),
    configResolveTtlMs: Math.max(
      1e3,
      Number(process.env["CONFIG_RESOLVE_TTL_MS"] ?? 6e4)
    ),
    configResolveMcpTtlMs: Math.max(
      1e3,
      Number(process.env["CONFIG_RESOLVE_MCP_TTL_MS"] ?? 3e4)
    ),
    scopeCacheTtlMs: Math.max(1e3, Number(process.env["SCOPE_CACHE_TTL_MS"] ?? 6e4)),
    allowPrivateTargets,
    serverRequestTimeoutMs: Math.max(
      1e3,
      Number(process.env["SERVER_REQUEST_TIMEOUT_MS"] ?? 3e4)
    ),
    serverHeadersTimeoutMs: Math.max(
      1e3,
      Number(process.env["SERVER_HEADERS_TIMEOUT_MS"] ?? 1e4)
    ),
    proxyResolveInternalSecret: resolveSecretRaw !== void 0 && resolveSecretRaw.length > 0 ? resolveSecretRaw : void 0
  };
}

// ../multicorn-proxy/src/query-key.ts
function stripKeyQueryParamFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (!u.searchParams.has("key")) return urlString;
    u.searchParams.delete("key");
    return u.toString();
  } catch {
    return urlString;
  }
}
function redactKeyQueryParamForLogs(urlString) {
  if (urlString.length === 0) return urlString;
  const lowered = urlString.toLowerCase();
  if (!lowered.includes("key=") && !lowered.includes("key%3d")) {
    return urlString;
  }
  try {
    const isAbsolute = urlString.startsWith("http://") || urlString.startsWith("https://");
    const u = isAbsolute ? new URL(urlString) : new URL(urlString, "http://127.0.0.1");
    if (u.searchParams.has("key")) {
      u.searchParams.set("key", "[redacted]");
    }
    if (isAbsolute) {
      return u.toString();
    }
    return u.pathname + u.search + u.hash;
  } catch {
    return urlString.replace(/([?&])key=[^&]*/gi, "$1key=[redacted]");
  }
}

// ../multicorn-proxy/src/mcp-handshake.ts
var KNOWN_PROTOCOL_VERSIONS = /* @__PURE__ */ new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18"
]);
var FALLBACK_PROTOCOL_VERSION = "2024-11-05";
var proxySemver = PROXY_VERSION;
function negotiateMcpProtocolVersion(clientParams) {
  if (typeof clientParams !== "object" || clientParams === null) {
    return FALLBACK_PROTOCOL_VERSION;
  }
  const v = clientParams["protocolVersion"];
  if (typeof v === "string" && v.length > 0 && KNOWN_PROTOCOL_VERSIONS.has(v)) {
    return v;
  }
  return FALLBACK_PROTOCOL_VERSION;
}
function classifyUnauthenticatedMcpHandshake(rpc) {
  if (rpc === null) return null;
  if (rpc.method === "initialize") return "initialize";
  if (rpc.method === "notifications/initialized") return "initialized_notification";
  if (rpc.method === "tools/list") return "tools_list";
  if (rpc.method === "prompts/list") return "prompts_list";
  if (rpc.method === "resources/list") return "resources_list";
  return null;
}
function buildUnauthenticatedDiscoveryListResponse(rpc, kind) {
  const result = kind === "tools_list" ? { tools: [] } : kind === "prompts_list" ? { prompts: [] } : { resources: [] };
  const payload = {
    jsonrpc: "2.0",
    id: rpc.id,
    result
  };
  return JSON.stringify(payload);
}
function buildUnauthenticatedInitializeResponse(rpc) {
  const protocolVersion = negotiateMcpProtocolVersion(rpc.params);
  const payload = {
    jsonrpc: "2.0",
    id: rpc.id,
    result: {
      protocolVersion,
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      },
      serverInfo: {
        name: "multicorn-proxy",
        version: proxySemver
      }
    }
  };
  return JSON.stringify(payload);
}

// ../multicorn-proxy/src/mcp-forwarder.ts
var PathTraversalError = class extends Error {
  constructor(path) {
    super(`Path traversal detected: ${path}`);
    this.name = "PathTraversalError";
  }
};
function fullyDecode(value) {
  let result = value;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(result);
      if (next === result) return result;
      result = next;
    } catch {
      throw new PathTraversalError(value);
    }
  }
  return result;
}
function assertSafeRestPath(restPath) {
  const decoded = fullyDecode(restPath);
  if (decoded.includes("\0")) {
    throw new PathTraversalError(restPath);
  }
  const segments = decoded.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      throw new PathTraversalError(restPath);
    }
  }
}
function resolvedPathWithinBase(resolvedPathname, originalPathname) {
  if (originalPathname === "/" || originalPathname === "") {
    return resolvedPathname.startsWith("/");
  }
  const basePrefix = originalPathname.endsWith("/") ? originalPathname.slice(0, -1) : originalPathname;
  return resolvedPathname === basePrefix || resolvedPathname.startsWith(`${basePrefix}/`);
}
function buildForwardUrl(baseTarget, restPath) {
  const base = new URL(baseTarget);
  const originalPathname = base.pathname;
  if (restPath === "" || restPath === "/") {
    return base.toString();
  }
  assertSafeRestPath(restPath);
  const extra = restPath.startsWith("/") ? restPath : `/${restPath}`;
  const prefix = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  base.pathname = prefix + extra;
  if (!resolvedPathWithinBase(base.pathname, originalPathname)) {
    throw new PathTraversalError(restPath);
  }
  return base.toString();
}
async function forwardToMcp(targetUrl, init, options) {
  const headers = new Headers();
  const pass = /* @__PURE__ */ new Set([
    "content-type",
    "accept",
    "mcp-protocol-version",
    "mcp-session-id"
  ]);
  for (const name of pass) {
    const v = init.headers[name] ?? init.headers[name.toLowerCase()];
    if (typeof v === "string" && v.length > 0) {
      headers.set(name, v);
    }
  }
  const extra = options?.configUpstreamHeaders;
  if (extra !== void 0) {
    for (const [name, value] of Object.entries(extra)) {
      if (typeof value === "string" && value.length > 0) {
        headers.set(name, value);
      }
    }
  }
  return fetch(targetUrl, {
    method: init.method,
    headers,
    body: init.body !== void 0 && init.method !== "GET" && init.method !== "HEAD" ? new Uint8Array(init.body) : void 0,
    signal: init.signal,
    redirect: "manual"
  });
}
function bufferFromRequest(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > limitBytes) {
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
}

// ../multicorn-proxy/src/mcp-aggregator.ts
var PROTOCOL_VERSION = "2024-11-05";
var UPSTREAM_TIMEOUT_MS = 3e4;
var STATE_TTL_MS = 5 * 6e4;
var store = /* @__PURE__ */ new Map();
function specSignature(upstreams) {
  return upstreams.map((u) => `${u.kind}:${u.url}`).join("|");
}
function pruneStore() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}
function getState(stateKey, upstreams) {
  pruneStore();
  const signature = specSignature(upstreams);
  const existing = store.get(stateKey);
  if (existing !== void 0 && existing.signature === signature) {
    existing.expiresAt = Date.now() + STATE_TTL_MS;
    return existing;
  }
  const fresh = {
    signature,
    upstreams: upstreams.map((spec) => ({ spec, sessionId: void 0, initialized: false, tools: [] })),
    toolOwner: /* @__PURE__ */ new Map(),
    toolsBuilt: false,
    expiresAt: Date.now() + STATE_TTL_MS
  };
  store.set(stateKey, fresh);
  return fresh;
}
function baseHeaders(session, apiKey) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION
  };
  if (session.sessionId !== void 0) {
    headers["mcp-session-id"] = session.sessionId;
  }
  if (session.spec.kind === "hosted") {
    headers["authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}
function parseRpcResponseText(text, contentType, id) {
  const candidates = [];
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload.length === 0 || payload === "[DONE]") continue;
      try {
        candidates.push(JSON.parse(payload));
      } catch {
      }
    }
  } else if (text.trim().length > 0) {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      return null;
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === id && ("result" in candidate || "error" in candidate)) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === "object" && candidate !== null && ("result" in candidate || "error" in candidate)) {
      return candidate;
    }
  }
  return null;
}
async function postToUpstream(session, rpc, apiKey, signal) {
  const res = await fetch(session.spec.url, {
    method: "POST",
    headers: baseHeaders(session, apiKey),
    body: JSON.stringify(rpc),
    signal,
    redirect: "manual"
  });
  const sessionId = res.headers.get("mcp-session-id") ?? void 0;
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const text = await res.text();
  const id = rpc.id ?? null;
  const response = parseRpcResponseText(text, contentType, id);
  return { response, sessionId, ok: res.ok };
}
var aggRequestId = 0;
function nextId() {
  aggRequestId += 1;
  return `agg-${String(aggRequestId)}`;
}
async function ensureInitialized(session, apiKey, signal, logger) {
  if (session.initialized) return;
  const initRpc = {
    jsonrpc: "2.0",
    id: nextId(),
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "multicorn-aggregator", version: "1.0.0" }
    }
  };
  const result = await postToUpstream(session, initRpc, apiKey, signal);
  if (result.sessionId !== void 0) {
    session.sessionId = result.sessionId;
  }
  try {
    await postToUpstream(
      session,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      apiKey,
      signal
    );
  } catch (err) {
    logger?.debug?.("Upstream initialized notification failed (continuing).", {
      url: session.spec.url,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  session.initialized = true;
}
async function serveBuiltinRpc(serveBuiltin, rpc, logger) {
  if (serveBuiltin === void 0) return null;
  try {
    const text = await serveBuiltin(rpc);
    if (text === null) return null;
    const id = rpc.id ?? null;
    return parseRpcResponseText(text, "application/json", id);
  } catch (err) {
    logger?.warn("Aggregator built-in serve failed.", {
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
async function listUpstreamTools(session, apiKey, signal, serveBuiltin, logger) {
  let response;
  if (session.spec.kind === "builtin") {
    response = await serveBuiltinRpc(
      serveBuiltin,
      { jsonrpc: "2.0", id: nextId(), method: "tools/list", params: {} },
      logger
    );
  } else {
    await ensureInitialized(session, apiKey, signal, logger);
    const listRpc = { jsonrpc: "2.0", id: nextId(), method: "tools/list", params: {} };
    response = (await postToUpstream(session, listRpc, apiKey, signal)).response;
  }
  const result = response?.result;
  const tools = result?.tools;
  if (!Array.isArray(tools)) return [];
  const valid = [];
  for (const tool of tools) {
    if (typeof tool === "object" && tool !== null && typeof tool.name === "string") {
      valid.push(tool);
    }
  }
  return valid;
}
async function buildToolMap(state, apiKey, signal, serveBuiltin, logger) {
  const merged = [];
  state.toolOwner = /* @__PURE__ */ new Map();
  for (let i = 0; i < state.upstreams.length; i++) {
    const session = state.upstreams[i];
    let tools = [];
    try {
      tools = await listUpstreamTools(session, apiKey, signal, serveBuiltin, logger);
    } catch (err) {
      logger?.warn("Aggregator could not list tools from upstream.", {
        url: session.spec.url,
        kind: session.spec.kind,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    session.tools = tools;
    for (const tool of tools) {
      if (!state.toolOwner.has(tool.name)) {
        state.toolOwner.set(tool.name, i);
        merged.push(tool);
      }
    }
  }
  state.toolsBuilt = true;
  return merged;
}
function jsonResponse(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function jsonError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}
async function handleAggregatedRequest(input) {
  const { rpc, signal, apiKey, logger } = input;
  const stateKey = `${input.routingToken}|${input.keyHash}`;
  const state = getState(stateKey, input.upstreams);
  const id = rpc.id ?? null;
  switch (rpc.method) {
    case "initialize":
      return jsonResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: "multicorn-aggregator", version: "1.0.0" },
        capabilities: { tools: {} }
      });
    case "notifications/initialized":
      return null;
    case "ping":
      return jsonResponse(id, {});
    case "prompts/list":
      return jsonResponse(id, { prompts: [] });
    case "resources/list":
      return jsonResponse(id, { resources: [] });
    case "tools/list": {
      const tools = await buildToolMap(state, apiKey, signal, input.serveBuiltin, logger);
      return jsonResponse(id, { tools });
    }
    case "tools/call": {
      const params = rpc.params;
      const toolName = typeof params?.name === "string" ? params.name : void 0;
      if (toolName === void 0) {
        return jsonError(id, -32602, "tools/call missing tool name");
      }
      if (!state.toolsBuilt) {
        await buildToolMap(state, apiKey, signal, input.serveBuiltin, logger);
      }
      let ownerIndex = state.toolOwner.get(toolName);
      if (ownerIndex === void 0) {
        await buildToolMap(state, apiKey, signal, input.serveBuiltin, logger);
        ownerIndex = state.toolOwner.get(toolName);
      }
      if (ownerIndex === void 0) {
        return jsonError(id, -32601, `Unknown tool: ${toolName}`);
      }
      const owner = state.upstreams[ownerIndex];
      logger?.info("Aggregator routing tool call.", {
        tool: toolName,
        upstreamKind: owner.spec.kind,
        routingToken: input.routingToken
      });
      if (owner.spec.kind === "local" || owner.spec.kind === "builtin") {
        const override = await input.interceptLocal(rpc);
        if (override !== null) {
          return override;
        }
      }
      let result;
      if (owner.spec.kind === "builtin") {
        result = await serveBuiltinRpc(input.serveBuiltin, rpc, logger);
      } else {
        result = await forwardCall(owner, rpc, apiKey, signal, logger);
        if (result === null && owner.initialized) {
          owner.initialized = false;
          owner.sessionId = void 0;
          await ensureInitialized(owner, apiKey, signal, logger);
          result = await forwardCall(owner, rpc, apiKey, signal, logger);
        }
      }
      if (result === null) {
        return jsonError(id, -32603, `Upstream did not return a response for ${toolName}`);
      }
      return JSON.stringify({ ...result, id });
    }
    default:
      return jsonError(id, -32601, `Method not found: ${rpc.method}`);
  }
}
async function forwardCall(owner, rpc, apiKey, signal, logger) {
  try {
    await ensureInitialized(owner, apiKey, signal, logger);
    const { response } = await postToUpstream(owner, rpc, apiKey, signal);
    return response;
  } catch (err) {
    logger?.warn("Aggregator forward failed.", {
      url: owner.spec.url,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
var AGGREGATOR_UPSTREAM_TIMEOUT_MS = UPSTREAM_TIMEOUT_MS;

// ../multicorn-proxy/src/multicorn-mcp.ts
var MULTICORN_MCP_SENTINEL2 = "multicorn://mcp";
var GOOGLE_API_TIMEOUT_MS = 15e3;
var SAMPLE_NOTE = "\n\nThis is sample data. Connect your Google account in the Shield dashboard to see your real emails, events, and files.";
var TOOLS = [
  {
    name: "gmail_read_inbox",
    description: "Read recent emails from your inbox. Optionally filter by query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to filter emails (Gmail search syntax)" },
        limit: { type: "number", description: "Maximum number of emails to return (default 5)" }
      },
      required: []
    }
  },
  {
    name: "gmail_send_email",
    description: "Send an email to a recipient.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body content" }
      },
      required: ["to", "subject", "body"]
    }
  },
  {
    name: "gmail_delete_thread",
    description: "Move an email thread to trash.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "ID of the thread to trash" }
      },
      required: ["thread_id"]
    }
  },
  {
    name: "gmail_delete_email",
    description: "Moves an email to Trash.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "ID of the email message to move to Trash" }
      },
      required: ["message_id"]
    }
  },
  {
    name: "calendar_list_events",
    description: "List calendar events across all of the user's calendars. Defaults to today; optionally filter by date.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date to list events for (YYYY-MM-DD format)" }
      },
      required: []
    }
  },
  {
    name: "calendar_create_event",
    description: "Create a new calendar event.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        date: { type: "string", description: "Event date and time (YYYY-MM-DD or ISO 8601)" },
        duration_minutes: { type: "number", description: "Duration in minutes (default 60)" },
        location: { type: "string", description: "Optional event location" }
      },
      required: ["title", "date"]
    }
  },
  {
    name: "calendar_update_event",
    description: "Update an existing calendar event (title, time, duration, or location).",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "ID of the event to update" },
        title: { type: "string", description: "New event title" },
        date: { type: "string", description: "New event date and time (YYYY-MM-DD or ISO 8601)" },
        duration_minutes: { type: "number", description: "New duration in minutes" },
        location: { type: "string", description: "New event location" }
      },
      required: ["event_id"]
    }
  },
  {
    name: "calendar_delete_event",
    description: "Delete a calendar event.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "ID of the event to delete" }
      },
      required: ["event_id"]
    }
  },
  {
    name: "drive_search_files",
    description: "Search for files in your drive. Lists recent files when no query is given.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to find files by name" }
      },
      required: []
    }
  },
  {
    name: "drive_write_file",
    description: "Save a text file to your drive.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name including extension" },
        content: { type: "string", description: "File content to save" }
      },
      required: ["name", "content"]
    }
  },
  {
    name: "list_directory",
    description: "List the files in your sandboxed Multicorn workspace.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "read_file",
    description: "Read the contents of a file in your sandboxed Multicorn workspace.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name to read" }
      },
      required: ["name"]
    }
  },
  {
    name: "write_file",
    description: "Create or overwrite a file in your sandboxed Multicorn workspace.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name including extension" },
        content: { type: "string", description: "File content to save" }
      },
      required: ["name", "content"]
    }
  },
  {
    name: "delete_file",
    description: "Delete a file from your sandboxed Multicorn workspace.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name to delete" }
      },
      required: ["name"]
    }
  },
  {
    name: "slack_read_messages",
    description: "Read recent messages from Slack channels.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name to read from (without #)" }
      },
      required: []
    }
  },
  {
    name: "slack_send_message",
    description: "Send a message to a Slack channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name to send to (without #)" },
        message: { type: "string", description: "Message content" }
      },
      required: ["channel", "message"]
    }
  }
];
function handleToolsList(id) {
  return {
    jsonrpc: "2.0",
    id,
    result: { tools: TOOLS }
  };
}
async function handleToolCall(id, params, ctx) {
  if (typeof params !== "object" || params === null) {
    return { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } };
  }
  const p = params;
  const toolName = typeof p["name"] === "string" ? p["name"] : "";
  const args = typeof p["arguments"] === "object" && p["arguments"] !== null ? p["arguments"] : {};
  const result = await executeToolCall(toolName, args, ctx);
  if (result === null) {
    return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${toolName}` } };
  }
  return { jsonrpc: "2.0", id, result };
}
async function executeToolCall(toolName, args, ctx) {
  switch (toolName) {
    case "gmail_read_inbox":
      return gmailReadInbox(args, ctx);
    case "gmail_send_email":
      return gmailSendEmail(args, ctx);
    case "gmail_delete_thread":
      return gmailDeleteThread(args, ctx);
    case "gmail_delete_email":
      return gmailDeleteEmail(args, ctx);
    case "calendar_list_events":
      return calendarListEvents(args, ctx);
    case "calendar_create_event":
      return calendarCreateEvent(args, ctx);
    case "calendar_update_event":
      return calendarUpdateEvent(args, ctx);
    case "calendar_delete_event":
      return calendarDeleteEvent(args, ctx);
    case "drive_search_files":
      return driveSearchFiles(args, ctx);
    case "drive_write_file":
      return driveWriteFile(args, ctx);
    case "list_directory":
      return workspaceList(ctx);
    case "read_file":
      return workspaceRead(args, ctx);
    case "write_file":
      return workspaceWrite(args, ctx);
    case "delete_file":
      return workspaceDelete(args, ctx);
    case "slack_read_messages":
      return slackReadMessages(args);
    case "slack_send_message":
      return slackSendMessage(args);
    default:
      return Promise.resolve(null);
  }
}
var GoogleApiError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "GoogleApiError";
  }
};
function textResult(text) {
  return { content: [{ type: "text", text }] };
}
function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function googleErrorResult(err) {
  if (err instanceof GoogleApiError) {
    if (err.status === 401) {
      return errorResult("Your Google connection has expired. Open your Shield dashboard to reconnect.");
    }
    if (err.status === 403) {
      const detail = err.message.length > 0 ? ` (${err.message})` : "";
      return errorResult(
        `Your Google account is missing a required permission${detail}. Reconnect Google in your Shield dashboard and grant the requested access.`
      );
    }
    return errorResult(`Google API error: ${err.message}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(`Could not reach Google: ${message}`);
}
async function googleRequest(url, auth, init) {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${auth.accessToken}`);
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body,
    signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
    redirect: "manual"
  });
  if (!response.ok) {
    const raw = await response.text();
    throw new GoogleApiError(response.status, extractGoogleErrorMessage(raw, response.status));
  }
  if (response.status === 204) {
    return {};
  }
  return response.json();
}
function extractGoogleErrorMessage(raw, status) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.error === "object" && parsed.error !== null && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
  }
  return `HTTP ${String(status)}`;
}
async function gmailReadInbox(args, ctx) {
  const query = typeof args["query"] === "string" ? args["query"] : "";
  const limit = typeof args["limit"] === "number" && args["limit"] > 0 ? Math.floor(args["limit"]) : 5;
  if (ctx.google === void 0) {
    return textResult(sampleGmailReadInbox(query, limit) + SAMPLE_NOTE);
  }
  try {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(limit));
    if (query.length > 0) {
      listUrl.searchParams.set("q", query);
    }
    const list = await googleRequest(listUrl.toString(), ctx.google);
    const messages = list.messages ?? [];
    if (messages.length === 0) {
      return textResult("No emails found matching your query.");
    }
    const details = await Promise.all(
      messages.slice(0, limit).map(async (m) => {
        const metaUrl = new URL(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}`
        );
        metaUrl.searchParams.set("format", "metadata");
        for (const h of ["From", "Subject", "Date"]) {
          metaUrl.searchParams.append("metadataHeaders", h);
        }
        return await googleRequest(metaUrl.toString(), ctx.google);
      })
    );
    const text = details.map((msg) => {
      const headers = msg.payload?.headers ?? [];
      const from = findHeader(headers, "From") ?? "(unknown sender)";
      const subject = findHeader(headers, "Subject") ?? "(no subject)";
      const date = findHeader(headers, "Date") ?? "";
      const snippet = msg.snippet ?? "";
      const threadId = msg.threadId !== void 0 && msg.threadId.length > 0 ? `
Thread ID: ${msg.threadId}` : "";
      return `From: ${from}
Subject: ${subject}
Date: ${date}${threadId}
Preview: ${snippet}`;
    }).join("\n\n");
    return textResult(text);
  } catch (err) {
    return googleErrorResult(err);
  }
}
function findHeader(headers, name) {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}
async function gmailSendEmail(args, ctx) {
  const to = typeof args["to"] === "string" ? args["to"] : "";
  const subject = typeof args["subject"] === "string" ? args["subject"] : "";
  const body = typeof args["body"] === "string" ? args["body"] : "";
  if (ctx.google === void 0) {
    return textResult(`Email sent to ${to} with subject '${subject}'` + SAMPLE_NOTE);
  }
  try {
    const raw = buildRawEmail(to, subject, body);
    await googleRequest("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", ctx.google, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw })
    });
    return textResult(`Email sent to ${to} with subject '${subject}'.`);
  } catch (err) {
    return googleErrorResult(err);
  }
}
function buildRawEmail(to, subject, body) {
  const message = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join(
    "\r\n"
  );
  return Buffer.from(message, "utf8").toString("base64url");
}
async function gmailDeleteThread(args, ctx) {
  const threadId = typeof args["thread_id"] === "string" ? args["thread_id"] : "";
  if (threadId.length === 0) {
    return errorResult("A thread_id is required to delete a thread.");
  }
  if (ctx.google === void 0) {
    return textResult(`Thread '${threadId}' moved to trash` + SAMPLE_NOTE);
  }
  try {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}/trash`;
    await googleRequest(url, ctx.google, { method: "POST" });
    return textResult(`Thread '${threadId}' moved to trash.`);
  } catch (err) {
    return googleErrorResult(err);
  }
}
async function gmailDeleteEmail(args, ctx) {
  const messageId = typeof args["message_id"] === "string" ? args["message_id"] : "";
  if (messageId.length === 0) {
    return errorResult("A message_id is required to delete an email.");
  }
  if (ctx.google === void 0) {
    return textResult(`Email '${messageId}' moved to Trash` + SAMPLE_NOTE);
  }
  try {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/trash`;
    await googleRequest(url, ctx.google, { method: "POST" });
    return textResult(`Email '${messageId}' moved to Trash.`);
  } catch (err) {
    if (err instanceof GoogleApiError) {
      if (err.status === 404) {
        return errorResult("Email not found. The message may have already been deleted or the ID is invalid.");
      }
      if (err.status === 403) {
        return errorResult("Permission denied. The agent does not have write access to Gmail.");
      }
    }
    return googleErrorResult(err);
  }
}
async function fetchCalendarIds(auth) {
  const url = "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader";
  const data = await googleRequest(url, auth);
  const items = data.items ?? [];
  if (items.length === 0) return ["primary"];
  const selected = items.filter((c) => c.selected !== false).map((c) => c.id);
  return selected.length > 0 ? selected : ["primary"];
}
async function fetchCalendarTimezone(auth) {
  const data = await googleRequest(
    "https://www.googleapis.com/calendar/v3/calendars/primary",
    auth
  );
  return data.timeZone ?? "UTC";
}
async function fetchEventsForCalendar(calendarId, start, end, timeZone, auth) {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  );
  url.searchParams.set("timeMin", start);
  url.searchParams.set("timeMax", end);
  url.searchParams.set("timeZone", timeZone);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  const data = await googleRequest(url.toString(), auth);
  return (data.items ?? []).map((e) => ({
    ...e,
    _calendarId: calendarId === "primary" ? void 0 : calendarId
  }));
}
async function calendarListEvents(args, ctx) {
  const dateArg = typeof args["date"] === "string" ? args["date"] : void 0;
  if (ctx.google === void 0) {
    return textResult(sampleCalendarListEvents() + SAMPLE_NOTE);
  }
  try {
    let timeZone;
    try {
      timeZone = await fetchCalendarTimezone(ctx.google);
    } catch {
      timeZone = "UTC";
    }
    const { start, end } = dayBounds(dateArg, timeZone);
    let calendarIds;
    try {
      calendarIds = await fetchCalendarIds(ctx.google);
    } catch {
      calendarIds = ["primary"];
    }
    const results = await Promise.allSettled(
      calendarIds.map((id) => fetchEventsForCalendar(id, start, end, timeZone, ctx.google))
    );
    const items = results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
    if (items.length === 0) {
      const firstError = results.find(
        (r) => r.status === "rejected"
      );
      if (firstError) throw firstError.reason;
      return textResult("No events found for that day.");
    }
    items.sort((a, b) => {
      const aTime = a.start?.dateTime ?? a.start?.date ?? "";
      const bTime = b.start?.dateTime ?? b.start?.date ?? "";
      return aTime.localeCompare(bTime);
    });
    const text = items.map((e) => {
      const summary = e.summary ?? "(no title)";
      const when = formatEventTime(e);
      const id = e.id !== void 0 && e.id.length > 0 ? `
  Event ID: ${e.id}` : "";
      const location = e.location !== void 0 && e.location.length > 0 ? `
  Location: ${e.location}` : "";
      const cal = e._calendarId !== void 0 ? `
  Calendar: ${e._calendarId}` : "";
      const attendees = e.attendees !== void 0 && e.attendees.length > 0 ? `
  Attendees: ${e.attendees.map((a) => a.email).join(", ")}` : "";
      return `${when} - ${summary}${id}${cal}${location}${attendees}`;
    }).join("\n");
    return textResult(text);
  } catch (err) {
    return googleErrorResult(err);
  }
}
function formatEventTime(e) {
  const start = e.start?.dateTime ?? e.start?.date ?? "";
  const end = e.end?.dateTime ?? e.end?.date ?? "";
  if (start.length === 0) return "(time unknown)";
  return end.length > 0 ? `${start} to ${end}` : start;
}
function dayBounds(date, timeZone) {
  let localDate;
  if (date !== void 0 && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    localDate = date;
  } else {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    localDate = formatter.format(/* @__PURE__ */ new Date());
  }
  const startUtc = localMidnightToUtc(localDate, 0, timeZone);
  const endUtc = localMidnightToUtc(localDate, 86399999, timeZone);
  return { start: startUtc, end: endUtc };
}
function localMidnightToUtc(localDate, msAfterMidnight, timeZone) {
  const midnightNaive = (/* @__PURE__ */ new Date(`${localDate}T00:00:00Z`)).getTime();
  const offsetMs = tzOffsetMs(new Date(midnightNaive), timeZone);
  const midnightUtc = midnightNaive - offsetMs;
  const verify = tzOffsetMs(new Date(midnightUtc), timeZone);
  if (verify !== offsetMs) {
    return new Date(midnightNaive - verify + msAfterMidnight).toISOString();
  }
  return new Date(midnightUtc + msAfterMidnight).toISOString();
}
function tzOffsetMs(instant, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(instant);
  const p = (type) => parts.find((x) => x.type === type)?.value ?? "0";
  const h = p("hour") === "24" ? "00" : p("hour");
  const wall = Date.UTC(
    Number(p("year")),
    Number(p("month")) - 1,
    Number(p("day")),
    Number(h),
    Number(p("minute")),
    Number(p("second"))
  );
  return wall - instant.getTime();
}
async function calendarCreateEvent(args, ctx) {
  const title = typeof args["title"] === "string" ? args["title"] : "";
  const date = typeof args["date"] === "string" ? args["date"] : "";
  const durationMinutes = typeof args["duration_minutes"] === "number" && args["duration_minutes"] > 0 ? Math.floor(args["duration_minutes"]) : 60;
  const location = typeof args["location"] === "string" ? args["location"] : void 0;
  if (ctx.google === void 0) {
    return textResult(`Event '${title}' created for ${date}` + SAMPLE_NOTE);
  }
  try {
    const startDate = parseEventStart(date);
    const endDate = new Date(startDate.getTime() + durationMinutes * 6e4);
    const eventBody = {
      summary: title,
      start: { dateTime: startDate.toISOString() },
      end: { dateTime: endDate.toISOString() }
    };
    if (location !== void 0 && location.length > 0) {
      eventBody["location"] = location;
    }
    await googleRequest("https://www.googleapis.com/calendar/v3/calendars/primary/events", ctx.google, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventBody)
    });
    return textResult(`Event '${title}' created for ${startDate.toISOString()} (${String(durationMinutes)} min).`);
  } catch (err) {
    return googleErrorResult(err);
  }
}
function parseEventStart(date) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return /* @__PURE__ */ new Date(`${date}T09:00:00.000Z`);
  }
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    return /* @__PURE__ */ new Date(`${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}T09:00:00.000Z`);
  }
  return parsed;
}
async function calendarUpdateEvent(args, ctx) {
  const eventId = typeof args["event_id"] === "string" ? args["event_id"] : "";
  if (eventId.length === 0) {
    return errorResult("An event_id is required to update an event.");
  }
  const title = typeof args["title"] === "string" ? args["title"] : void 0;
  const date = typeof args["date"] === "string" ? args["date"] : void 0;
  const durationMinutes = typeof args["duration_minutes"] === "number" && args["duration_minutes"] > 0 ? Math.floor(args["duration_minutes"]) : void 0;
  const location = typeof args["location"] === "string" ? args["location"] : void 0;
  if (ctx.google === void 0) {
    return textResult(`Event '${eventId}' updated` + SAMPLE_NOTE);
  }
  try {
    const eventBody = {};
    if (title !== void 0) {
      eventBody["summary"] = title;
    }
    if (location !== void 0) {
      eventBody["location"] = location;
    }
    if (date !== void 0) {
      const startDate = parseEventStart(date);
      eventBody["start"] = { dateTime: startDate.toISOString() };
      const minutes = durationMinutes ?? 60;
      eventBody["end"] = { dateTime: new Date(startDate.getTime() + minutes * 6e4).toISOString() };
    }
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`;
    await googleRequest(url, ctx.google, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventBody)
    });
    return textResult(`Event '${eventId}' updated.`);
  } catch (err) {
    return googleErrorResult(err);
  }
}
async function calendarDeleteEvent(args, ctx) {
  const eventId = typeof args["event_id"] === "string" ? args["event_id"] : "";
  if (eventId.length === 0) {
    return errorResult("An event_id is required to delete an event.");
  }
  if (ctx.google === void 0) {
    return textResult(`Event '${eventId}' deleted` + SAMPLE_NOTE);
  }
  try {
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`;
    await googleRequest(url, ctx.google, { method: "DELETE" });
    return textResult(`Event '${eventId}' deleted.`);
  } catch (err) {
    return googleErrorResult(err);
  }
}
async function driveSearchFiles(args, ctx) {
  const query = typeof args["query"] === "string" ? args["query"] : "";
  if (ctx.google === void 0) {
    return textResult(sampleDriveSearchFiles(query) + SAMPLE_NOTE);
  }
  try {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    if (query.length > 0) {
      url.searchParams.set("q", `name contains '${query.replace(/'/g, "\\'")}'`);
    }
    url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,owners,shared)");
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("pageSize", "10");
    const data = await googleRequest(url.toString(), ctx.google);
    const files = data.files ?? [];
    if (files.length === 0) {
      return textResult("No files found matching your query.");
    }
    const text = files.map((f) => {
      const modified = f.modifiedTime !== void 0 ? ` - modified ${f.modifiedTime}` : "";
      const shared = f.shared === true ? ", shared" : "";
      return `${f.name}${modified}${shared}`;
    }).join("\n");
    return textResult(text);
  } catch (err) {
    return googleErrorResult(err);
  }
}
async function driveWriteFile(args, ctx) {
  const name = typeof args["name"] === "string" ? args["name"] : "";
  const content = typeof args["content"] === "string" ? args["content"] : "";
  if (ctx.google === void 0) {
    return textResult(`File '${name}' saved to Drive` + SAMPLE_NOTE);
  }
  try {
    const boundary = `multicorn-${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name });
    const multipartBody = `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${metadata}\r
--${boundary}\r
Content-Type: text/plain\r
\r
${content}\r
--${boundary}--`;
    await googleRequest("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", ctx.google, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipartBody
    });
    return textResult(`File '${name}' saved to Drive.`);
  } catch (err) {
    return googleErrorResult(err);
  }
}
function slackReadMessages(args) {
  const messages = [
    { channel: "general", author: "Sam Patel", text: "Launch is confirmed for next Tuesday. Marketing assets are ready." },
    { channel: "engineering", author: "Alex Chen", text: "PR #247 merged. Deployment starts at 4pm." },
    { channel: "random", author: "Jordan Kim", text: "Friday social is at the rooftop bar this week!" }
  ];
  const channel = typeof args["channel"] === "string" ? args["channel"].toLowerCase().replace(/^#/, "") : "";
  let filtered = messages;
  if (channel.length > 0) {
    filtered = messages.filter((m) => m.channel === channel);
  }
  const text = filtered.length === 0 ? `No recent messages in #${channel}.` : filtered.map((m) => `#${m.channel} \u2014 ${m.author}: "${m.text}"`).join("\n");
  return Promise.resolve(textResult(text));
}
function slackSendMessage(args) {
  const channel = typeof args["channel"] === "string" ? args["channel"].replace(/^#/, "") : "";
  return Promise.resolve(textResult(`Message sent to #${channel}`));
}
function sampleGmailReadInbox(query, limit) {
  const emails = [
    {
      from: "Alex Chen <alex@acme.co>",
      subject: "Q3 planning doc ready for review",
      date: "yesterday",
      threadId: "thread_sample_q3",
      preview: "Hey team, I've finished the Q3 planning document..."
    },
    {
      from: "Jordan Kim <jordan@acme.co>",
      subject: "Design review at 2pm",
      date: "today",
      threadId: "thread_sample_design",
      preview: "Quick reminder about the design review..."
    },
    {
      from: "Acme Weekly <newsletter@acme.co>",
      subject: "This week at Acme",
      date: "2 days ago",
      threadId: "thread_sample_weekly",
      preview: "Product launch update, new hires, and Friday social..."
    }
  ];
  const q = query.toLowerCase();
  let filtered = emails;
  if (q.length > 0) {
    filtered = emails.filter(
      (e) => e.subject.toLowerCase().includes(q) || e.from.toLowerCase().includes(q) || e.preview.toLowerCase().includes(q)
    );
  }
  filtered = filtered.slice(0, limit);
  return filtered.length === 0 ? "No emails found matching your query." : filtered.map(
    (e) => `From: ${e.from}
Subject: ${e.subject}
Date: ${e.date}
Thread ID: ${e.threadId}
Preview: ${e.preview}`
  ).join("\n\n");
}
function sampleCalendarListEvents() {
  return [
    "9:00 AM \u2014 Daily standup (15 min, recurring) [Event ID: evt_sample_standup]",
    "11:00 AM \u2014 1:1 with Alex Chen (30 min) [Event ID: evt_sample_1on1]",
    "12:30 PM \u2014 Team lunch at Sushi Place (60 min) [Event ID: evt_sample_lunch]",
    "3:00 PM \u2014 Sprint demo (45 min, Friday) [Event ID: evt_sample_demo]"
  ].join("\n");
}
function sampleDriveSearchFiles(query) {
  const files = [
    { name: "Q3 Planning.docx", modified: "Modified yesterday", shared: "shared with team" },
    { name: "Budget 2026.xlsx", modified: "Modified 3 days ago", shared: "shared with finance" },
    { name: "Meeting Notes - Sprint Review.md", modified: "Modified today", shared: "" },
    { name: "Product Roadmap.pdf", modified: "Modified last week", shared: "shared with leadership" },
    { name: "Onboarding Checklist.docx", modified: "Modified 2 weeks ago", shared: "" }
  ];
  const q = query.toLowerCase();
  let filtered = files;
  if (q.length > 0) {
    filtered = files.filter((f) => f.name.toLowerCase().includes(q));
  }
  return filtered.length === 0 ? "No files found matching your query." : filtered.map((f) => `${f.name} \u2014 ${f.modified}${f.shared ? `, ${f.shared}` : ""}`).join("\n");
}
var WORKSPACE_TIMEOUT_MS = 1e4;
var WORKSPACE_AUTH_HEADER = "X-Multicorn-Key";
var WORKSPACE_UNAVAILABLE = "Your Multicorn workspace is temporarily unavailable. Please try again in a moment.";
var WorkspaceApiError = class extends Error {
};
async function workspaceRequest(ws, path, init) {
  const base = ws.baseUrl.replace(/\/+$/, "");
  const headers = { [WORKSPACE_AUTH_HEADER]: ws.apiKey };
  if (init?.body !== void 0) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${base}/api/v1/workspace/files${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body,
    signal: AbortSignal.timeout(WORKSPACE_TIMEOUT_MS),
    redirect: "manual"
  });
  if (response.status === 404) {
    throw new WorkspaceApiError("not_found");
  }
  if (!response.ok) {
    throw new WorkspaceApiError(`Workspace API error: HTTP ${String(response.status)}`);
  }
  if (response.status === 204) {
    return {};
  }
  return response.json();
}
function unwrapData(json) {
  if (typeof json !== "object" || json === null) return null;
  const obj = json;
  const data = obj["data"];
  if (typeof data !== "object" || data === null) return null;
  return data;
}
function encodeFileName(name) {
  return encodeURIComponent(name.trim());
}
async function workspaceList(ctx) {
  if (ctx.workspace === void 0) {
    return textResult("Your Multicorn workspace is empty.");
  }
  try {
    const json = await workspaceRequest(ctx.workspace, "");
    const data = unwrapData(json);
    const files = Array.isArray(data?.["files"]) ? data["files"] : [];
    if (files.length === 0) {
      return textResult("Your Multicorn workspace has no files yet.");
    }
    const lines = files.map((f) => {
      const size = typeof f.size === "number" ? ` (${String(f.size)} bytes)` : "";
      return `${f.name}${size}`;
    });
    return textResult(`Files in your Multicorn workspace:
${lines.join("\n")}`);
  } catch {
    return errorResult(WORKSPACE_UNAVAILABLE);
  }
}
async function workspaceRead(args, ctx) {
  const name = typeof args["name"] === "string" ? args["name"].trim() : "";
  if (name.length === 0) {
    return errorResult("A file name is required.");
  }
  if (ctx.workspace === void 0) {
    return errorResult(`No file named "${name}" in your Multicorn workspace.`);
  }
  try {
    const json = await workspaceRequest(ctx.workspace, `/${encodeFileName(name)}`);
    const data = unwrapData(json);
    const content = typeof data?.["content"] === "string" ? data["content"] : "";
    return textResult(`Contents of ${name}:

${content}`);
  } catch (err) {
    if (err instanceof WorkspaceApiError && err.message === "not_found") {
      return errorResult(`No file named "${name}" in your Multicorn workspace.`);
    }
    return errorResult(WORKSPACE_UNAVAILABLE);
  }
}
async function workspaceWrite(args, ctx) {
  const name = typeof args["name"] === "string" ? args["name"].trim() : "";
  const content = typeof args["content"] === "string" ? args["content"] : "";
  if (name.length === 0) {
    return errorResult("A file name is required.");
  }
  if (ctx.workspace === void 0) {
    return errorResult(WORKSPACE_UNAVAILABLE);
  }
  try {
    await workspaceRequest(ctx.workspace, `/${encodeFileName(name)}`, {
      method: "PUT",
      body: JSON.stringify({ content })
    });
    return textResult(`Saved "${name}" to your Multicorn workspace.`);
  } catch {
    return errorResult(WORKSPACE_UNAVAILABLE);
  }
}
async function workspaceDelete(args, ctx) {
  const name = typeof args["name"] === "string" ? args["name"].trim() : "";
  if (name.length === 0) {
    return errorResult("A file name is required.");
  }
  if (ctx.workspace === void 0) {
    return errorResult(WORKSPACE_UNAVAILABLE);
  }
  try {
    await workspaceRequest(ctx.workspace, `/${encodeFileName(name)}`, { method: "DELETE" });
    return textResult(`Deleted "${name}" from your Multicorn workspace.`);
  } catch (err) {
    if (err instanceof WorkspaceApiError && err.message === "not_found") {
      return errorResult(`No file named "${name}" in your Multicorn workspace.`);
    }
    return errorResult(WORKSPACE_UNAVAILABLE);
  }
}
var MCP_TOOL_SCOPES = {
  gmail_read_inbox: { service: "gmail", permissionLevel: "read" },
  gmail_send_email: { service: "gmail", permissionLevel: "write" },
  gmail_delete_thread: { service: "gmail", permissionLevel: "write" },
  gmail_delete_email: { service: "gmail", permissionLevel: "write" },
  calendar_list_events: { service: "calendar", permissionLevel: "read" },
  calendar_create_event: { service: "calendar", permissionLevel: "write" },
  calendar_update_event: { service: "calendar", permissionLevel: "write" },
  calendar_delete_event: { service: "calendar", permissionLevel: "write" },
  drive_search_files: { service: "drive", permissionLevel: "read" },
  drive_write_file: { service: "drive", permissionLevel: "write" },
  // Hosted workspace filesystem. Delete is its own scope - granting write to
  // save a file must never imply the right to delete one.
  list_directory: { service: "filesystem", permissionLevel: "read" },
  read_file: { service: "filesystem", permissionLevel: "read" },
  write_file: { service: "filesystem", permissionLevel: "write" },
  delete_file: { service: "filesystem", permissionLevel: "delete" },
  slack_read_messages: { service: "slack", permissionLevel: "read" },
  slack_send_message: { service: "slack", permissionLevel: "write" }
};
function getMcpToolScope(toolName) {
  const name = toolName.trim();
  const direct = MCP_TOOL_SCOPES[name];
  if (direct !== void 0) return direct;
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex !== -1) {
    return MCP_TOOL_SCOPES[name.slice(dotIndex + 1)];
  }
  return void 0;
}
async function handleMulticornMcpRequest(rpc, ctx = {}) {
  if (rpc.method === "tools/list") {
    return JSON.stringify(handleToolsList(rpc.id));
  }
  if (rpc.method === "tools/call") {
    return JSON.stringify(await handleToolCall(rpc.id, rpc.params, ctx));
  }
  if (rpc.method === "initialize") {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "multicorn-mcp", version: "1.0.0" },
        capabilities: { tools: {} }
      }
    });
  }
  if (rpc.method === "notifications/initialized") {
    return null;
  }
  if (rpc.method === "prompts/list" || rpc.method === "resources/list") {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.id,
      result: rpc.method === "prompts/list" ? { prompts: [] } : { resources: [] }
    });
  }
  return JSON.stringify({
    jsonrpc: "2.0",
    id: rpc.id,
    error: { code: -32601, message: `Method not found: ${rpc.method}` }
  });
}

// ../multicorn-proxy/src/tool-call-intercept.ts
var ACTION_CHECK_TIMEOUT_MS = 8e3;
var AUTH_HEADER = "X-Multicorn-Key";
var AUDIT_LOG_TIMEOUT_MS = 5e3;
var AUDIT_LOG_MAX_ATTEMPTS = 3;
var CANONICAL_SERVICE = {
  google_calendar: "calendar",
  google_drive: "drive"
};
function canonicaliseService(service) {
  return CANONICAL_SERVICE[service] ?? service;
}
function connectedServicesFromGoogleScopes(grantedScopes) {
  if (grantedScopes === void 0 || grantedScopes.length === 0) {
    return [];
  }
  const lower = grantedScopes.toLowerCase();
  const services = [];
  if (lower.includes("gmail") || lower.includes("mail.google")) {
    services.push("gmail");
  }
  if (lower.includes("calendar")) {
    services.push("calendar");
  }
  if (lower.includes("drive")) {
    services.push("drive");
  }
  return services;
}
function buildConsentUrl(agentName, service, permissionLevel, dashboardUrl, platform, _connectedServices = []) {
  const base = dashboardUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ agent: agentName });
  params.set("scopes", `${service}:${permissionLevel}`);
  if (platform) {
    params.set("platform", platform);
  }
  return `${base}/consent?${params.toString()}`;
}
function buildPendingApprovalResponse(id, service, permissionLevel, _dashboardUrl, _agentName, consentUrl) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      // isError marks this as a tool-level failure. Many MCP clients skip the
      // outputSchema/structuredContent check on error results; structuredContent
      // is also included so clients that always enforce the schema still accept
      // it. Together this keeps the consent link from being rejected as -32600
      // for upstream tools that declare an output schema (e.g. server-filesystem).
      isError: true,
      content: [
        {
          type: "text",
          text: `Permission required

This tool needs approval before it can be used. Open this link to grant access:

${consentUrl}

After approving, try your request again.`
        }
      ],
      structuredContent: {
        multicornConsentRequired: true,
        service,
        permissionLevel,
        consentUrl
      }
    }
  };
}
function buildMutationPermissionRequiredResponse(id, service, level, consentUrl) {
  const label = level === "delete" ? "Delete" : "Write";
  return {
    jsonrpc: "2.0",
    id,
    result: {
      // See buildPendingApprovalResponse: isError + structuredContent keep this
      // consent result valid for upstream tools that declare an output schema,
      // so the link surfaces instead of failing as MCP error -32600.
      isError: true,
      content: [
        {
          type: "text",
          text: `${label} permission required

This action needs ${level} permission for ${service}, which has not been granted. ` + `${level === "delete" ? "Write access does not include delete." : ""}`.trim() + `

Grant ${level} access here:

${consentUrl}

After granting, try your request again.`
        }
      ],
      structuredContent: {
        multicornConsentRequired: true,
        service,
        permissionLevel: level,
        consentUrl
      }
    }
  };
}
async function checkActionPermission(payload, apiKey, baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/v1/actions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [AUTH_HEADER]: apiKey
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ACTION_CHECK_TIMEOUT_MS),
      redirect: "manual"
    });
    if (response.status === 201) {
      return { status: "approved" };
    }
    if (response.status === 202) {
      let body;
      try {
        body = await response.json();
      } catch {
        return { status: "blocked" };
      }
      if (typeof body !== "object" || body === null) return { status: "blocked" };
      const obj = body;
      if (obj["success"] !== true) return { status: "blocked" };
      const data = obj["data"];
      if (typeof data !== "object" || data === null) return { status: "blocked" };
      const dataObj = data;
      if (dataObj["status"] === "approved") {
        return { status: "approved" };
      }
      const approvalId = dataObj["approval_id"];
      if (typeof approvalId !== "string") return { status: "blocked" };
      return { status: "pending", approvalId };
    }
    return { status: "blocked" };
  } catch {
    return { status: "blocked" };
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function auditBackoffMs(attempt) {
  return 150 * Math.pow(3, attempt);
}
async function recordAuditAction(payload, apiKey, baseUrl, logger) {
  let lastError;
  logger?.info("Recording action to audit log.", {
    agent: payload.agent,
    service: payload.service,
    actionType: payload.actionType,
    status: payload.status
  });
  for (let attempt = 0; attempt < AUDIT_LOG_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/actions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [AUTH_HEADER]: apiKey
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(AUDIT_LOG_TIMEOUT_MS),
        redirect: "manual"
      });
      if (response.ok) {
        logger?.info("Action recorded to audit log.", {
          agent: payload.agent,
          service: payload.service,
          actionType: payload.actionType,
          status: payload.status,
          httpStatus: response.status
        });
        return;
      }
      if (response.status >= 400 && response.status < 500) {
        lastError = new Error(`audit log POST rejected with client error ${String(response.status)}`);
        break;
      }
      lastError = new Error(`audit log POST failed with status ${String(response.status)}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < AUDIT_LOG_MAX_ATTEMPTS - 1) {
      await sleep(auditBackoffMs(attempt));
    }
  }
  logger?.error("Audit log write dropped after retries.", {
    auditLogDropped: true,
    agent: payload.agent,
    service: payload.service,
    actionType: payload.actionType,
    status: payload.status,
    attempts: AUDIT_LOG_MAX_ATTEMPTS,
    error: lastError?.message ?? "unknown error"
  });
}
async function maybeInterceptToolsCall(input) {
  if (input.rpc.method !== "tools/call") {
    return null;
  }
  const toolParams = extractToolCallParams(input.rpc);
  if (toolParams === null) {
    return null;
  }
  try {
    const cacheKey = `${input.routingToken}|${input.keyHash}`;
    let agentId;
    let grantedScopes;
    const agentName = input.agentName ?? input.serverName;
    input.logger?.info("Intercepting tool call.", {
      tool: toolParams.name,
      agentName,
      serverName: input.serverName,
      routingToken: input.routingToken
    });
    const cached = input.scopeCache.get(cacheKey);
    if (cached !== null) {
      agentId = cached.agentId;
      grantedScopes = cached.grantedScopes;
    } else {
      const resolved = await resolveAgentAndScopes(
        agentName,
        input.apiKey,
        input.baseUrl,
        input.platform
      );
      if (resolved.kind === "auth") {
        return JSON.stringify(buildAuthErrorResponse(input.rpc.id));
      }
      if (resolved.kind === "unreachable") {
        return JSON.stringify(buildServiceUnreachableResponse(input.rpc.id, input.dashboardUrl));
      }
      agentId = resolved.agentId;
      grantedScopes = resolved.scopes;
      input.scopeCache.set(cacheKey, { agentId, grantedScopes });
    }
    if (agentId.length === 0) {
      return JSON.stringify(buildServiceUnreachableResponse(input.rpc.id, input.dashboardUrl));
    }
    const baseMapping = mapMcpToolToScope(toolParams.name);
    const builtInScope = getMcpToolScope(toolParams.name);
    const mapping = {
      service: builtInScope?.service ?? canonicaliseService(baseMapping.service),
      permissionLevel: builtInScope?.permissionLevel ?? baseMapping.permissionLevel,
      actionType: baseMapping.actionType
    };
    const requested = {
      service: mapping.service,
      permissionLevel: mapping.permissionLevel
    };
    const connectedServices = connectedServicesFromGoogleScopes(input.googleGrantedScopes);
    let validation = validateScopeAccess(grantedScopes, requested);
    if (!validation.allowed && cached !== null && (mapping.permissionLevel === "write" || mapping.permissionLevel === "delete")) {
      const refreshedScopes = await fetchGrantedScopes(agentId, input.apiKey, input.baseUrl);
      if (refreshedScopes.length > 0) {
        grantedScopes = refreshedScopes;
        input.scopeCache.set(cacheKey, { agentId, grantedScopes });
        validation = validateScopeAccess(grantedScopes, requested);
      }
    }
    if (!validation.allowed) {
      if (mapping.permissionLevel === "write" || mapping.permissionLevel === "delete") {
        const consentUrl = buildConsentUrl(
          agentName,
          mapping.service,
          mapping.permissionLevel,
          input.dashboardUrl,
          input.platform,
          connectedServices
        );
        void recordAuditAction(
          {
            agent: agentName,
            service: mapping.service,
            actionType: mapping.actionType,
            status: "blocked"
          },
          input.apiKey,
          input.baseUrl,
          input.logger
        );
        return JSON.stringify(
          buildMutationPermissionRequiredResponse(
            input.rpc.id,
            mapping.service,
            mapping.permissionLevel,
            consentUrl
          )
        );
      }
      const permissionResult = await checkActionPermission(
        {
          agent: agentName,
          service: mapping.service,
          actionType: mapping.actionType,
          status: "approved"
        },
        input.apiKey,
        input.baseUrl
      );
      if (permissionResult.status === "approved") {
        const refreshedScopes = await fetchGrantedScopes(agentId, input.apiKey, input.baseUrl);
        if (refreshedScopes.length > 0) {
          input.scopeCache.set(cacheKey, { agentId, grantedScopes: refreshedScopes });
        }
        void recordAuditAction(
          {
            agent: agentName,
            service: mapping.service,
            actionType: mapping.actionType,
            status: "approved"
          },
          input.apiKey,
          input.baseUrl,
          input.logger
        );
        return null;
      }
      if (permissionResult.status === "pending" && permissionResult.approvalId !== void 0) {
        const consentUrl = buildConsentUrl(
          agentName,
          mapping.service,
          mapping.permissionLevel,
          input.dashboardUrl,
          input.platform,
          connectedServices
        );
        return JSON.stringify(
          buildPendingApprovalResponse(
            input.rpc.id,
            mapping.service,
            mapping.permissionLevel,
            input.dashboardUrl,
            agentName,
            consentUrl
          )
        );
      }
      void recordAuditAction(
        {
          agent: agentName,
          service: mapping.service,
          actionType: mapping.actionType,
          status: "blocked"
        },
        input.apiKey,
        input.baseUrl,
        input.logger
      );
      return JSON.stringify(
        buildBlockedResponse(
          input.rpc.id,
          mapping.service,
          mapping.permissionLevel,
          input.dashboardUrl
        )
      );
    }
    void recordAuditAction(
      {
        agent: agentName,
        service: mapping.service,
        actionType: mapping.actionType,
        status: "approved"
      },
      input.apiKey,
      input.baseUrl,
      input.logger
    );
    return null;
  } catch {
    return JSON.stringify(buildInternalErrorResponse(input.rpc.id));
  }
}
async function resolveAgentAndScopes(serverName, apiKey, baseUrl, platform) {
  const existing = await findAgentByName(serverName, apiKey, baseUrl);
  if (existing?.authInvalid) {
    return { kind: "auth" };
  }
  let agentId;
  if (existing !== null) {
    agentId = existing.id;
  } else {
    try {
      agentId = await registerAgent(serverName, apiKey, baseUrl, platform);
    } catch (err) {
      if (err instanceof ShieldAuthError) {
        return { kind: "auth" };
      }
      return { kind: "unreachable" };
    }
  }
  if (agentId.length === 0) {
    return { kind: "unreachable" };
  }
  const scopes = await fetchGrantedScopes(agentId, apiKey, baseUrl);
  return { kind: "ok", agentId, scopes };
}

// ../multicorn-proxy/src/proxy-handler.ts
var MCP_PROXY_MAX_BODY_BYTES = 2 * 1024 * 1024;
var UPSTREAM_TIMEOUT_MS2 = 3e4;
var ALLOWED_RESPONSE_HEADERS = /* @__PURE__ */ new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
  "cache-control"
]);
function filterUpstreamResponseHeaders(headers, logger) {
  const out = {};
  headers.forEach((value, key) => {
    const nameLower = key.toLowerCase();
    if (ALLOWED_RESPONSE_HEADERS.has(nameLower)) {
      out[nameLower] = value;
    } else {
      logger.debug("Dropped upstream response header.", {
        action: "drop_upstream_header",
        key: nameLower
      });
    }
  });
  return out;
}
function headersToRecord(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}
async function pipeWebStreamToNode(body, res) {
  if (body === null) {
    res.end();
    return;
  }
  const reader = body.getReader();
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== void 0 && value.byteLength > 0) {
        res.write(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}
async function readResponseText(body) {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks = [];
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== void 0) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
async function pipeSseUpstreamToBridge(body, sessionKey, bridgeStore) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5));
          }
        }
        if (dataLines.length > 0) {
          const payload = dataLines.join("\n");
          bridgeStore.sendEvent(sessionKey, payload);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim().length > 0) {
      const dataLines = [];
      for (const line of buffer.split("\n")) {
        if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5));
        }
      }
      if (dataLines.length > 0) {
        bridgeStore.sendEvent(sessionKey, dataLines.join("\n"));
      }
    }
  } finally {
    reader.releaseLock();
  }
}
function createProxyRequestHandler(deps) {
  const { env, configResolver, scopeCache, rateLimiter, logger, bridgeStore } = deps;
  return async function handleProxiedRequest(req, res, route, apiKey) {
    const keyHash = configResolver.hashKey(apiKey);
    const retryAfter = rateLimiter.check(keyHash);
    if (retryAfter !== null) {
      res.writeHead(429, {
        "Retry-After": String(retryAfter),
        "Content-Type": "application/json"
      });
      res.end(
        JSON.stringify({ type: "about:blank", title: "Too Many Requests", status: 429 })
      );
      return;
    }
    let resolveBody;
    try {
      resolveBody = await configResolver.resolve(route.routingToken, apiKey);
    } catch (e) {
      if (e instanceof TargetUrlError) {
        logger.warn("Rejected target URL from config resolve.", { error: e.message });
        res.writeHead(502, { "Content-Type": "application/problem+json" });
        res.end(
          JSON.stringify({
            type: "https://multicorn.ai/errors/bad-gateway",
            title: "Bad Gateway",
            status: 502,
            detail: e.message
          })
        );
        return;
      }
      if (e instanceof ResolveError) {
        if (e.code === "unauthorized") {
          res.writeHead(401, { "Content-Type": "application/problem+json" });
          res.end(
            JSON.stringify({
              type: "https://multicorn.ai/errors/unauthorized",
              title: "Unauthorized",
              status: 401,
              detail: e.message
            })
          );
          return;
        }
        if (e.code === "forbidden") {
          res.writeHead(403, { "Content-Type": "application/problem+json" });
          res.end(
            JSON.stringify({
              type: "https://multicorn.ai/errors/forbidden",
              title: "Forbidden",
              status: 403,
              detail: e.message
            })
          );
          return;
        }
        if (e.code === "not_found") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unknown_routing_token" }));
          return;
        }
      }
      logger.warn("Config resolve failed.", { error: e instanceof Error ? e.message : String(e) });
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad_gateway" }));
      return;
    }
    logger.info("Config resolve completed.", {
      routingToken: route.routingToken,
      targetUrl: resolveBody.targetUrl,
      hasServiceTokens: resolveBody.serviceTokens !== void 0,
      hasGoogleServiceToken: resolveBody.serviceTokens?.google !== void 0,
      // Scope identifiers are not secrets; logged to diagnose consent URL scopes.
      googleGrantedScopes: resolveBody.serviceTokens?.google?.grantedScopes ?? "(none)"
    });
    const dashboardUrl = deriveDashboardUrl(env.shieldApiBaseUrl);
    const headerRecord = headersToRecord(req.headers);
    const agentNameChanged = configResolver.trackAgentName(route.routingToken, resolveBody.agentName);
    if (agentNameChanged) {
      const scopeCacheKey = `${route.routingToken}|${keyHash}`;
      scopeCache.invalidate(scopeCacheKey);
    }
    const aggUpstreams = resolveBody.upstreams;
    if (aggUpstreams !== void 0 && aggUpstreams.length > 1) {
      const specs = aggUpstreams.filter(
        (u) => u.kind === "builtin" || u.kind === "hosted" || u.kind === "local" || u.kind === "http"
      ).map((u) => ({ url: u.targetUrl, kind: u.kind }));
      if (req.method === "GET") {
        const sessionKey2 = `${route.routingToken}|${keyHash}`;
        const endpointWithKey = `${route.pathPrefix}?key=${encodeURIComponent(apiKey)}`;
        bridgeStore.open(sessionKey2, res, endpointWithKey);
        req.on("close", () => bridgeStore.remove(sessionKey2));
        return;
      }
      let aggBody;
      try {
        aggBody = await bufferFromRequest(req, MCP_PROXY_MAX_BODY_BYTES);
      } catch {
        res.writeHead(413).end();
        return;
      }
      const aggCt = headerRecord["content-type"] ?? "";
      if (req.method === "POST" && aggCt.includes("application/json") && aggBody.length > 0) {
        const rpc = parseJsonRpcLine(aggBody.toString("utf8"));
        if (rpc !== null) {
          const ac2 = new AbortController();
          const timer2 = setTimeout(() => ac2.abort(), AGGREGATOR_UPSTREAM_TIMEOUT_MS);
          let aggregated;
          try {
            aggregated = await handleAggregatedRequest({
              rpc,
              upstreams: specs,
              apiKey,
              routingToken: route.routingToken,
              keyHash,
              signal: ac2.signal,
              logger,
              interceptLocal: (innerRpc) => maybeInterceptToolsCall({
                rpc: innerRpc,
                apiKey,
                baseUrl: env.shieldApiBaseUrl,
                dashboardUrl,
                serverName: resolveBody.serverName,
                routingToken: route.routingToken,
                keyHash,
                scopeCache,
                platform: resolveBody.platform ?? "other-mcp",
                agentName: resolveBody.agentName,
                googleGrantedScopes: resolveBody.serviceTokens?.google?.grantedScopes,
                logger
              }),
              // Serves the in-process built-in MCP (gmail/calendar/drive) with this proxy's
              // service tokens. Present only when the backend kept the built-in in-process
              // (i.e. this proxy holds the resolve secret); otherwise the built-in arrives as a
              // "hosted" upstream and is forwarded to the cloud instead.
              serveBuiltin: (innerRpc) => handleMulticornMcpRequest(innerRpc, {
                google: resolveBody.serviceTokens?.google,
                workspace: {
                  apiKey,
                  baseUrl: env.shieldApiBaseUrl,
                  userId: resolveBody.userId
                }
              })
            });
          } catch (err) {
            logger.warn("Aggregated request failed.", {
              error: err instanceof Error ? err.message : String(err)
            });
            aggregated = JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id ?? null,
              error: { code: -32603, message: "Aggregation failed" }
            });
          } finally {
            clearTimeout(timer2);
          }
          const sessionKey2 = `${route.routingToken}|${keyHash}`;
          const bridgeSession2 = bridgeStore.get(sessionKey2);
          if (aggregated === null) {
            res.writeHead(bridgeSession2 ? 202 : 204).end();
            return;
          }
          if (bridgeSession2) {
            bridgeStore.sendEvent(sessionKey2, aggregated);
            res.writeHead(202).end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(aggregated);
          }
          return;
        }
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request" }));
      return;
    }
    if (resolveBody.targetUrl === MULTICORN_MCP_SENTINEL2) {
      if (req.method === "GET") {
        const sessionKey2 = `${route.routingToken}|${keyHash}`;
        const endpointWithKey = `${route.pathPrefix}?key=${encodeURIComponent(apiKey)}`;
        bridgeStore.open(sessionKey2, res, endpointWithKey);
        req.on("close", () => bridgeStore.remove(sessionKey2));
        return;
      }
      let body2;
      try {
        body2 = await bufferFromRequest(req, MCP_PROXY_MAX_BODY_BYTES);
      } catch {
        res.writeHead(413).end();
        return;
      }
      const ct2 = headerRecord["content-type"] ?? "";
      if (req.method === "POST" && ct2.includes("application/json") && body2.length > 0) {
        const line = body2.toString("utf8");
        const rpc = parseJsonRpcLine(line);
        if (rpc !== null) {
          const override = await maybeInterceptToolsCall({
            rpc,
            apiKey,
            baseUrl: env.shieldApiBaseUrl,
            dashboardUrl,
            serverName: resolveBody.serverName,
            routingToken: route.routingToken,
            keyHash,
            scopeCache,
            platform: resolveBody.platform ?? "other-mcp",
            agentName: resolveBody.agentName,
            googleGrantedScopes: resolveBody.serviceTokens?.google?.grantedScopes,
            logger
          });
          if (override !== null) {
            const sessionKey2 = `${route.routingToken}|${keyHash}`;
            const bridgeSession2 = bridgeStore.get(sessionKey2);
            if (bridgeSession2) {
              bridgeStore.sendEvent(sessionKey2, override);
              res.writeHead(202).end();
            } else {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(override);
            }
            return;
          }
          const mcpResponse = await handleMulticornMcpRequest(rpc, {
            google: resolveBody.serviceTokens?.google,
            workspace: {
              apiKey,
              baseUrl: env.shieldApiBaseUrl,
              userId: resolveBody.userId
            }
          });
          if (mcpResponse !== null) {
            const sessionKey2 = `${route.routingToken}|${keyHash}`;
            const bridgeSession2 = bridgeStore.get(sessionKey2);
            if (bridgeSession2) {
              bridgeStore.sendEvent(sessionKey2, mcpResponse);
              res.writeHead(202).end();
            } else {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(mcpResponse);
            }
            return;
          }
          res.writeHead(204).end();
          return;
        }
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request" }));
      return;
    }
    let forwardUrl;
    try {
      forwardUrl = stripKeyQueryParamFromUrl(buildForwardUrl(resolveBody.targetUrl, route.restPath));
    } catch (e) {
      if (e instanceof PathTraversalError) {
        logger.warn("Rejected path traversal in proxy path.", {
          restPath: route.restPath,
          error: e.message
        });
        res.writeHead(400, { "Content-Type": "application/problem+json" });
        res.end(
          JSON.stringify({
            type: "https://multicorn.ai/errors/bad-request",
            title: "Bad Request",
            status: 400,
            detail: "Invalid path segment"
          })
        );
        return;
      }
      throw e;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const ac2 = new AbortController();
      const timer2 = setTimeout(() => ac2.abort(), UPSTREAM_TIMEOUT_MS2);
      try {
        const upstream = await forwardToMcp(forwardUrl, {
          method: req.method,
          headers: headerRecord,
          body: void 0,
          signal: ac2.signal
        }, { configUpstreamHeaders: resolveBody.upstreamHeaders });
        if (upstream.status === 405) {
          if (upstream.body) {
            await upstream.body.cancel();
          }
          logger.debug("Upstream returned 405 on GET; opening SSE bridge.", { forwardUrl });
          const sessionKey2 = `${route.routingToken}|${keyHash}`;
          const endpointWithKey = `${route.pathPrefix}?key=${encodeURIComponent(apiKey)}`;
          bridgeStore.open(sessionKey2, res, endpointWithKey);
          req.on("close", () => bridgeStore.remove(sessionKey2));
          return;
        }
        const upstreamCt = (upstream.headers.get("content-type") ?? "").toLowerCase();
        const isValidSseResponse = upstream.status === 200 && upstreamCt.includes("text/event-stream");
        if (!isValidSseResponse) {
          if (upstream.body) {
            await upstream.body.cancel();
          }
          logger.debug("Upstream did not return SSE on GET; opening SSE bridge.", {
            forwardUrl,
            upstreamStatus: upstream.status,
            upstreamContentType: upstreamCt
          });
          const sessionKey2 = `${route.routingToken}|${keyHash}`;
          const endpointWithKey = `${route.pathPrefix}?key=${encodeURIComponent(apiKey)}`;
          bridgeStore.open(sessionKey2, res, endpointWithKey);
          req.on("close", () => bridgeStore.remove(sessionKey2));
          return;
        }
        const upstreamHeaders = filterUpstreamResponseHeaders(upstream.headers, logger);
        res.writeHead(upstream.status, upstreamHeaders);
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        await pipeWebStreamToNode(upstream.body, res);
      } catch (err) {
        logger.warn("Upstream forward failed (GET).", {
          error: err instanceof Error ? err.message : String(err)
        });
        if (!res.headersSent) {
          res.writeHead(502).end();
        }
      } finally {
        clearTimeout(timer2);
      }
      return;
    }
    let body;
    try {
      body = await bufferFromRequest(req, MCP_PROXY_MAX_BODY_BYTES);
    } catch {
      res.writeHead(413).end();
      return;
    }
    const ct = headerRecord["content-type"] ?? "";
    if (req.method === "POST" && ct.includes("application/json") && body.length > 0) {
      const line = body.toString("utf8");
      const rpc = parseJsonRpcLine(line);
      if (rpc !== null) {
        const override = await maybeInterceptToolsCall({
          rpc,
          apiKey,
          baseUrl: env.shieldApiBaseUrl,
          dashboardUrl,
          serverName: resolveBody.serverName,
          routingToken: route.routingToken,
          keyHash,
          scopeCache,
          platform: resolveBody.platform ?? "other-mcp",
          agentName: resolveBody.agentName,
          googleGrantedScopes: resolveBody.serviceTokens?.google?.grantedScopes,
          // Pass the logger so action recording on the forwarded (e.g. local filesystem)
          // path is observable. Without it, a dropped or blocked audit write here was
          // completely silent - the exact blind spot for local-files agents.
          logger
        });
        if (override !== null) {
          const sessionKey2 = `${route.routingToken}|${keyHash}`;
          const bridgeSession2 = bridgeStore.get(sessionKey2);
          if (bridgeSession2) {
            bridgeStore.sendEvent(sessionKey2, override);
            res.writeHead(202).end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(override);
          }
          return;
        }
      }
    }
    const sessionKey = `${route.routingToken}|${keyHash}`;
    const bridgeSession = bridgeStore.get(sessionKey);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS2);
    try {
      const upstream = await forwardToMcp(forwardUrl, {
        method: req.method ?? "POST",
        headers: headerRecord,
        body: body.length > 0 ? body : void 0,
        signal: ac.signal
      }, { configUpstreamHeaders: resolveBody.upstreamHeaders });
      if (bridgeSession) {
        const upstreamCt = upstream.headers.get("content-type") ?? "";
        if (upstreamCt.includes("text/event-stream") && upstream.body) {
          await pipeSseUpstreamToBridge(upstream.body, sessionKey, bridgeStore);
        } else {
          const text = await readResponseText(upstream.body);
          if (text.length > 0) {
            bridgeStore.sendEvent(sessionKey, text);
          }
        }
        res.writeHead(202).end();
      } else {
        const upstreamHeaders = filterUpstreamResponseHeaders(upstream.headers, logger);
        res.writeHead(upstream.status, upstreamHeaders);
        await pipeWebStreamToNode(upstream.body, res);
      }
    } catch (err) {
      logger.warn("Upstream forward failed.", {
        error: err instanceof Error ? err.message : String(err)
      });
      if (bridgeSession) {
        bridgeStore.sendError(sessionKey, "Upstream request failed");
        res.writeHead(502).end();
      } else if (!res.headersSent) {
        res.writeHead(502).end();
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

// ../multicorn-proxy/src/rate-limiter.ts
function createRateLimiter(requestsPerMinute) {
  const windowMs = 6e4;
  const max = Math.max(1, requestsPerMinute);
  const windows = /* @__PURE__ */ new Map();
  function prune() {
    const now = Date.now();
    for (const [k, w] of windows) {
      if (w.resetAt <= now) windows.delete(k);
    }
  }
  return {
    /** @returns retryAfterSeconds when limited, otherwise null */
    check(key) {
      prune();
      const now = Date.now();
      let w = windows.get(key);
      if (w === void 0 || w.resetAt <= now) {
        w = { resetAt: now + windowMs, count: 0 };
        windows.set(key, w);
      }
      if (w.count >= max) {
        return Math.max(1, Math.ceil((w.resetAt - now) / 1e3));
      }
      w.count += 1;
      return null;
    }
  };
}

// ../multicorn-proxy/src/scope-cache.ts
function createScopeCache(ttlMs) {
  const store2 = /* @__PURE__ */ new Map();
  function prune() {
    const now = Date.now();
    for (const [k, b] of store2) {
      if (b.expiresAt <= now) store2.delete(k);
    }
  }
  return {
    get(key) {
      prune();
      const b = store2.get(key);
      if (b === void 0 || b.expiresAt <= Date.now()) {
        if (b !== void 0) store2.delete(key);
        return null;
      }
      return b.entry;
    },
    set(key, entry) {
      store2.set(key, { entry, expiresAt: Date.now() + ttlMs });
    },
    invalidate(key) {
      store2.delete(key);
    }
  };
}

// ../multicorn-proxy/src/sse-bridge.ts
var HEARTBEAT_INTERVAL_MS = 3e4;
function createSseBridgeStore(logger) {
  const sessions = /* @__PURE__ */ new Map();
  function closeSession(key, session) {
    clearInterval(session.heartbeatTimer);
    if (!session.res.writableEnded) {
      session.res.end();
    }
    sessions.delete(key);
    logger.debug("SSE bridge session closed.", { key });
  }
  return {
    /**
     * Open a new SSE stream for the given session key.
     * If a session already exists for this key, the old one is closed first.
     * Writes the SSE headers and the `event: endpoint` message.
     */
    open(key, res, endpointPath) {
      const existing = sessions.get(key);
      if (existing) {
        closeSession(key, existing);
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      res.write(`event: endpoint
data: ${endpointPath}

`);
      const heartbeatTimer = setInterval(() => {
        if (!res.writableEnded) {
          res.write(":\n\n");
        }
      }, HEARTBEAT_INTERVAL_MS);
      const session = { res, heartbeatTimer, createdAt: Date.now() };
      sessions.set(key, session);
      logger.debug("SSE bridge session opened.", { key, endpointPath });
    },
    /** Get the active session for a key, or undefined if none exists. */
    get(key) {
      return sessions.get(key);
    },
    /** Remove and close a session. */
    remove(key) {
      const session = sessions.get(key);
      if (session) {
        closeSession(key, session);
      }
    },
    /**
     * Send one SSE `message` event on the session's GET stream.
     * Returns false if the session doesn't exist or the stream is closed.
     */
    sendEvent(key, data) {
      const session = sessions.get(key);
      if (!session || session.res.writableEnded) {
        return false;
      }
      const lines = data.split("\n").map((line) => `data: ${line}`).join("\n");
      session.res.write(`event: message
${lines}

`);
      return true;
    },
    /**
     * Send an SSE error event, then close the session.
     */
    sendError(key, message) {
      const session = sessions.get(key);
      if (!session || session.res.writableEnded) {
        return;
      }
      session.res.write(`event: error
data: ${JSON.stringify({ error: message })}

`);
      closeSession(key, session);
    },
    /** Number of active sessions (for metrics/debugging). */
    size() {
      return sessions.size;
    }
  };
}

// ../multicorn-proxy/src/server.ts
var ROUTE_RE = /^\/r\/([^/]+)\/([^/]+)(.*)$/;
function matchRoute(pathname) {
  const m = ROUTE_RE.exec(pathname);
  if (m === null) return null;
  const routingToken = m[1] ?? "";
  const pathSegment = m[2] ?? "";
  const restPath = m[3] ?? "";
  if (routingToken.length === 0 || pathSegment.length === 0) return null;
  const pathPrefix = `/r/${routingToken}/${pathSegment}`;
  return { routingToken, pathSegment, pathPrefix, restPath };
}
function headersForDebugLog(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const val = Array.isArray(v) ? v.join(", ") : v ?? "";
    const keyLower = k.toLowerCase();
    if (keyLower === "authorization" || keyLower === "x-multicorn-key") {
      out[k] = val.length > 0 ? `[present:${String(val.length)} chars]` : "";
    } else {
      out[k] = val;
    }
  }
  return out;
}
function applyProxyServerTimeouts(server, env) {
  server.requestTimeout = env.serverRequestTimeoutMs;
  server.headersTimeout = env.serverHeadersTimeoutMs;
  server.keepAliveTimeout = 65e3;
}
function main() {
  const env = loadEnv();
  const logger = createLogger(env.logLevel);
  const configResolver = createConfigResolver(
    env.shieldApiBaseUrl,
    env.configResolveTtlMs,
    env.allowPrivateTargets,
    env.proxyResolveInternalSecret,
    env.configResolveMcpTtlMs
  );
  const scopeCache = createScopeCache(env.scopeCacheTtlMs);
  const rateLimiter = createRateLimiter(env.rateLimitRpm);
  const bridgeStore = createSseBridgeStore(logger);
  const handleProxied = createProxyRequestHandler({
    env,
    configResolver,
    scopeCache,
    rateLimiter,
    logger,
    bridgeStore
  });
  const server = createServer((req, res) => {
    req.setTimeout(env.serverRequestTimeoutMs, () => {
      req.destroy();
    });
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const redactedUrl = redactKeyQueryParamForLogs(req.url ?? "");
        logger.info("[DEBUG] Incoming request", {
          method: req.method,
          url: redactedUrl,
          hasKeyParam: url.searchParams.has("key"),
          headers: headersForDebugLog(req.headers)
        });
        if (req.method === "GET" && url.pathname === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", version: PROXY_VERSION }));
          return;
        }
        const route = matchRoute(url.pathname);
        if (route === null) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        if (route.restPath.toLowerCase().includes("/.well-known/")) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        logger.debug("Proxy request", { path: redactedUrl });
        const keyResult = extractApiKey(req.headers, url.searchParams);
        if (typeof keyResult !== "string") {
          if (req.method === "POST") {
            const rawCt = req.headers["content-type"];
            const ctHeader = typeof rawCt === "string" ? rawCt : Array.isArray(rawCt) ? rawCt[0] ?? "" : "";
            if (ctHeader.includes("application/json")) {
              try {
                const body = await bufferFromRequest(req, MCP_PROXY_MAX_BODY_BYTES);
                const bodyText = body.toString("utf8");
                const rpc = body.length > 0 ? parseJsonRpcLine(bodyText) : null;
                logger.info("[DEBUG] Unauthenticated POST body", {
                  url: redactedUrl,
                  bodyPreview: bodyText.slice(0, 500),
                  parsedMethod: rpc?.method ?? null
                });
                if (body.length > 0) {
                  const handshakeKind = classifyUnauthenticatedMcpHandshake(rpc);
                  if (handshakeKind === "initialize" && rpc !== null) {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(buildUnauthenticatedInitializeResponse(rpc));
                    return;
                  }
                  if (handshakeKind === "initialized_notification") {
                    res.writeHead(204);
                    res.end();
                    return;
                  }
                  if ((handshakeKind === "tools_list" || handshakeKind === "prompts_list" || handshakeKind === "resources_list") && rpc !== null) {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(buildUnauthenticatedDiscoveryListResponse(rpc, handshakeKind));
                    return;
                  }
                }
              } catch (readErr) {
                if (!res.headersSent) {
                  if (readErr instanceof Error && readErr.message === "request body too large") {
                    res.writeHead(413).end();
                  } else {
                    res.writeHead(400).end();
                  }
                }
                return;
              }
            }
          }
          res.writeHead(401, { "Content-Type": "application/problem+json" });
          res.end(
            JSON.stringify({
              type: "https://multicorn.ai/errors/unauthorized",
              title: "Unauthorized",
              status: 401,
              detail: "Missing or invalid Authorization / X-Multicorn-Key / key query parameter"
            })
          );
          return;
        }
        await handleProxied(req, res, route, keyResult);
      } catch (err) {
        logger.error("Unhandled server error.", {
          error: err instanceof Error ? err.message : String(err)
        });
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      }
    })();
  });
  applyProxyServerTimeouts(server, env);
  const listenCb = () => {
    logger.info("Hosted Shield proxy listening.", { port: env.port, host: env.host ?? "0.0.0.0", shieldApiBaseUrl: env.shieldApiBaseUrl });
  };
  if (env.host !== void 0) {
    server.listen(env.port, env.host, listenCb);
  } else {
    server.listen(env.port, listenCb);
  }
}
var entryScript = process.argv[1];
if (entryScript !== void 0 && fileURLToPath(import.meta.url) === entryScript) {
  main();
}

export { applyProxyServerTimeouts };
