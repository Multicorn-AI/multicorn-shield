"use strict";

var fs = require("fs");
var http = require("http");
var https = require("https");
var os = require("os");
var path = require("path");

function _interopNamespace(e) {
  if (e && e.__esModule) return e;
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== "default") {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(
          n,
          k,
          d.get
            ? d
            : {
                enumerable: true,
                get: function () {
                  return e[k];
                },
              },
        );
      }
    });
  }
  n.default = e;
  return Object.freeze(n);
}

var fs__namespace = /*#__PURE__*/ _interopNamespace(fs);
var http__namespace = /*#__PURE__*/ _interopNamespace(http);
var https__namespace = /*#__PURE__*/ _interopNamespace(https);
var os__namespace = /*#__PURE__*/ _interopNamespace(os);
var path__namespace = /*#__PURE__*/ _interopNamespace(path);

// AUTO-GENERATED from src/hooks/codex-cli-*.ts — do not edit manually. Run pnpm build from the package root to regenerate.

var AUTH_HEADER = "X-Multicorn-Key";
var AUDIT_METADATA_MAX_CHARS = 1e4;
function redactSecretsForAudit(serialized) {
  let out = serialized;
  out = out.replace(/\bsk-[a-zA-Z0-9]{20,}\b/g, "[REDACTED]");
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]");
  out = out.replace(/\bghp_[a-zA-Z0-9]{20,}\b/g, "[REDACTED]");
  out = out.replace(/\bgho_[a-zA-Z0-9]{20,}\b/g, "[REDACTED]");
  out = out.replace(/\bghu_[a-zA-Z0-9]{20,}\b/g, "[REDACTED]");
  out = out.replace(/\bghs_[a-zA-Z0-9]{20,}\b/g, "[REDACTED]");
  out = out.replace(
    /-----BEGIN[A-Z0-9 \n\r-]+-----[\s\S]*?-----END[A-Z0-9 \n\r-]+-----/g,
    "[REDACTED]",
  );
  out = out.replace(/token=[^\s"&]+/gi, "token=[REDACTED]");
  out = out.replace(/\bBearer\s+[a-zA-Z0-9._\-+/=]+\b/gi, "Bearer [REDACTED]");
  return out;
}
function truncateForAudit(serialized, maxChars = AUDIT_METADATA_MAX_CHARS) {
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, maxChars)}[truncated]`;
}
function serializeHookAuditFragment(value) {
  try {
    const raw = typeof value === "string" ? value : JSON.stringify(value === void 0 ? null : value);
    return truncateForAudit(redactSecretsForAudit(raw));
  } catch {
    return "[unserializable]";
  }
}
function isLocalHostname(hostname) {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}
function assertHttpsOrLocalhostForApiKey(u) {
  if (u.protocol === "http:" && !isLocalHostname(u.hostname)) {
    throw new Error(`HTTP_API_KEY_REFUSED:${u.hostname}`);
  }
}
function cwdUnderWorkspacePath(cwdResolved, workspacePath) {
  const w = path__namespace.resolve(workspacePath);
  if (cwdResolved === w) return true;
  const prefix = w.endsWith(path__namespace.sep) ? w : w + path__namespace.sep;
  return cwdResolved.startsWith(prefix);
}
function resolveCodexCliAgentName(obj) {
  const pwd = process.env["PWD"];
  const cwdRaw = pwd !== void 0 && pwd.length > 0 ? pwd : process.cwd();
  const agents = obj["agents"];
  const defaultAgentRaw = obj["defaultAgent"];
  const defaultAgentName =
    typeof defaultAgentRaw === "string" && defaultAgentRaw.length > 0 ? defaultAgentRaw : "";
  if (!Array.isArray(agents)) {
    return typeof obj["agentName"] === "string" ? obj["agentName"] : "";
  }
  const matches = [];
  for (const entry of agents) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry;
    if (e["platform"] !== "codex-cli") continue;
    const n = e["name"];
    if (typeof n !== "string") continue;
    const wp = e["workspacePath"];
    matches.push({
      name: n,
      ...(typeof wp === "string" && wp.length > 0 ? { workspacePath: wp } : {}),
    });
  }
  if (matches.length === 0) {
    return typeof obj["agentName"] === "string" ? obj["agentName"] : "";
  }
  const withWs = matches.filter(
    (m) => typeof m.workspacePath === "string" && m.workspacePath.length > 0,
  );
  const resolvedCwd = path__namespace.resolve(cwdRaw);
  let best = null;
  let bestLen = -1;
  for (const m of withWs) {
    const wp = m.workspacePath;
    if (!cwdUnderWorkspacePath(resolvedCwd, wp)) continue;
    const len = path__namespace.resolve(wp).length;
    if (len > bestLen) {
      bestLen = len;
      best = { name: m.name, workspacePath: wp };
    }
  }
  if (best !== null) return best.name;
  if (defaultAgentName.length > 0) {
    const d = matches.find((m) => m.name === defaultAgentName);
    if (d !== void 0) return d.name;
  }
  const first = matches[0];
  return first !== void 0 ? first.name : "";
}
function warnIfConfigWorldReadable(configPath) {
  try {
    const st = fs__namespace.statSync(configPath);
    const mode777 = st.mode & 511;
    if ((st.mode & 63) !== 0) {
      process.stderr.write(
        `[Shield] Warning: ~/.multicorn/config.json is readable by other users (current: 0${mode777.toString(8)}). Run: chmod 600 ~/.multicorn/config.json
`,
      );
    }
  } catch {}
}
function loadCodexCliConfig() {
  try {
    const configPath = path__namespace.join(os__namespace.homedir(), ".multicorn", "config.json");
    const raw = fs__namespace.readFileSync(configPath, "utf8");
    warnIfConfigWorldReadable(configPath);
    const obj = JSON.parse(raw);
    const apiKey = typeof obj["apiKey"] === "string" ? obj["apiKey"] : "";
    const baseUrl =
      typeof obj["baseUrl"] === "string" && obj["baseUrl"].length > 0
        ? obj["baseUrl"].replace(/\/+$/, "")
        : "https://api.multicorn.ai";
    const agentName = resolveCodexCliAgentName(obj);
    return { apiKey, baseUrl, agentName };
  } catch {
    return null;
  }
}
function formatShieldNetworkError(err) {
  const debugEnv = process.env["MULTICORN_DEBUG"];
  const debug = debugEnv === "1" || debugEnv === "true" || debugEnv === "yes";
  let line =
    "[Shield] Error: failed to connect to Shield API. Check your network and baseUrl configuration.\n";
  if (debug && err instanceof Error && err.message.length > 0) {
    line += `  Debug: ${err.message}
`;
  }
  return line;
}
function formatHttpApiKeyRefusal(hostname) {
  return `[Shield] Error: refusing to send API key over unencrypted HTTP to ${hostname}. Use HTTPS or localhost.
`;
}
function readHttpApiKeyRefusalHostname(err) {
  if (!(err instanceof Error) || !err.message.startsWith("HTTP_API_KEY_REFUSED:")) {
    return null;
  }
  return err.message.slice("HTTP_API_KEY_REFUSED:".length);
}
async function shieldGetJson(baseUrl, apiKey, reqPath) {
  const root = baseUrl.replace(/\/+$/, "");
  const p = reqPath.startsWith("/") ? reqPath : `/${reqPath}`;
  const u = new URL(`${root}${p}`);
  assertHttpsOrLocalhostForApiKey(u);
  const isHttps = u.protocol === "https:";
  const lib = isHttps ? https__namespace : http__namespace;
  const port = u.port !== "" ? Number(u.port) : isHttps ? 443 : 80;
  return await new Promise((resolve2, reject) => {
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
        resolve2({
          statusCode: res.statusCode ?? 0,
          bodyText: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
async function shieldPostJson(baseUrl, apiKey, bodyObj) {
  const root = baseUrl.replace(/\/+$/, "");
  const u = new URL(`${root}/api/v1/actions`);
  assertHttpsOrLocalhostForApiKey(u);
  const payload = JSON.stringify(bodyObj);
  const isHttps = u.protocol === "https:";
  const lib = isHttps ? https__namespace : http__namespace;
  const port = u.port !== "" ? Number(u.port) : isHttps ? 443 : 80;
  return await new Promise((resolve2, reject) => {
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
        resolve2({
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
async function shieldPostJsonFireAndForget(baseUrl, apiKey, bodyObj) {
  await shieldPostJson(baseUrl, apiKey, bodyObj);
}

exports.AUTH_HEADER = AUTH_HEADER;
exports.assertHttpsOrLocalhostForApiKey = assertHttpsOrLocalhostForApiKey;
exports.cwdUnderWorkspacePath = cwdUnderWorkspacePath;
exports.formatHttpApiKeyRefusal = formatHttpApiKeyRefusal;
exports.formatShieldNetworkError = formatShieldNetworkError;
exports.isLocalHostname = isLocalHostname;
exports.loadCodexCliConfig = loadCodexCliConfig;
exports.readHttpApiKeyRefusalHostname = readHttpApiKeyRefusalHostname;
exports.redactSecretsForAudit = redactSecretsForAudit;
exports.resolveCodexCliAgentName = resolveCodexCliAgentName;
exports.serializeHookAuditFragment = serializeHookAuditFragment;
exports.shieldGetJson = shieldGetJson;
exports.shieldPostJson = shieldPostJson;
exports.shieldPostJsonFireAndForget = shieldPostJsonFireAndForget;
exports.truncateForAudit = truncateForAudit;
exports.warnIfConfigWorldReadable = warnIfConfigWorldReadable;
