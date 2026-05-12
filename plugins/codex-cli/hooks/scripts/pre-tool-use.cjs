"use strict";

var child_process = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");
var codexCliHooksShared_js = require("./codex-cli-hooks-shared.cjs");
var codexCliToolMap_js = require("./codex-cli-tool-map.cjs");

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
var os__namespace = /*#__PURE__*/ _interopNamespace(os);
var path__namespace = /*#__PURE__*/ _interopNamespace(path);

// AUTO-GENERATED from src/hooks/codex-cli-*.ts — do not edit manually. Run pnpm build from the package root to regenerate.

var FAST_POLL =
  process.env["NODE_ENV"] === "test" &&
  process.env["MULTICORN_SHIELD_PRE_HOOK_TEST_FAST_POLL"] === "1";
var POLL_INTERVAL_MS = FAST_POLL ? 1 : 3e3;
var MAX_APPROVAL_POLLS = FAST_POLL ? 3 : 100;
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      resolve(chunks.join(""));
    });
    process.stdin.on("error", reject);
  });
}
function dashboardOrigin(apiBaseUrl) {
  try {
    const raw = apiBaseUrl.replace(/\/+$/, "");
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
function dashboardHintUrl(apiBaseUrl) {
  return `${dashboardOrigin(apiBaseUrl)}/approvals`;
}
function consentUrl(apiBaseUrl, agentName, service, actionType) {
  const origin = dashboardOrigin(apiBaseUrl);
  const params = new URLSearchParams();
  params.set("agent", agentName);
  params.set("scopes", `${service}:${actionType}`);
  params.set("platform", "codex-cli");
  return `${origin}/consent?${params.toString()}`;
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
  const o = body;
  return o["success"] === true ? o["data"] : null;
}
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
function blockedReason(data, service, actionType, approvalsUrl) {
  if (data !== null && typeof data === "object") {
    const d = data;
    const meta = d["metadata"];
    if (typeof meta === "string" && meta.length > 0) {
      try {
        const parsed = JSON.parse(meta);
        if (parsed !== null && typeof parsed === "object" && "block_reason" in parsed) {
          const br = parsed["block_reason"];
          if (typeof br === "string" && br.length > 0) {
            return `Shield blocked: ${br}. Grant access at ${approvalsUrl}`;
          }
        }
      } catch {}
    }
  }
  return `Shield blocked this tool call. Required permission: ${service} (${actionType}). Grant access at ${approvalsUrl}`;
}
function consentMarkerPath(agentName) {
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path__namespace.join(os__namespace.homedir(), ".multicorn", `.consent-${safe}`);
}
function hasConsentMarker(agentName) {
  try {
    fs__namespace.accessSync(consentMarkerPath(agentName));
    return true;
  } catch {
    return false;
  }
}
function writeConsentMarker(agentName) {
  try {
    const marker = consentMarkerPath(agentName);
    fs__namespace.mkdirSync(path__namespace.dirname(marker), { recursive: true });
    fs__namespace.writeFileSync(marker, String(Date.now()), "utf8");
  } catch {}
}
function removeConsentMarker(agentName) {
  try {
    fs__namespace.unlinkSync(consentMarkerPath(agentName));
  } catch {}
}
function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      child_process.execSync(`start "" ${JSON.stringify(url)}`, {
        shell: process.env["ComSpec"] ?? "cmd.exe",
        stdio: "ignore",
        windowsHide: true,
      });
    } else if (process.platform === "darwin") {
      child_process.execFileSync("open", [url], { stdio: "ignore" });
    } else {
      child_process.execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {}
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function pollApprovalStatus(config, approvalId) {
  let lastProgressWrite = Date.now();
  for (let i = 0; i < MAX_APPROVAL_POLLS; i++) {
    if (i > 0) {
      await sleep(POLL_INTERVAL_MS);
    }
    const now = Date.now();
    if (now - lastProgressWrite >= 3e4) {
      process.stderr.write(
        "[Shield] Waiting for approval... (open the consent screen in your browser)\n",
      );
      lastProgressWrite = now;
    }
    let statusCode;
    let bodyText;
    try {
      const res = await codexCliHooksShared_js.shieldGetJson(
        config.baseUrl,
        config.apiKey,
        `/api/v1/approvals/${approvalId}`,
      );
      statusCode = res.statusCode;
      bodyText = res.bodyText;
    } catch (e) {
      const refusedHost = codexCliHooksShared_js.readHttpApiKeyRefusalHostname(e);
      if (refusedHost !== null) {
        process.stderr.write(codexCliHooksShared_js.formatHttpApiKeyRefusal(refusedHost));
        process.exit(2);
      }
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
    const d = data;
    const statusRaw = d["status"];
    const st = (typeof statusRaw === "string" ? statusRaw : "").toLowerCase();
    if (st === "approved") {
      return true;
    }
    if (st === "blocked" || st === "denied" || st === "rejected") {
      const reasonRaw = d["reason"];
      const reason =
        typeof reasonRaw === "string" && reasonRaw.length > 0 ? reasonRaw : "Approval denied.";
      denyViaStdout(`Shield denied this approval request: ${reason}`);
      process.exit(0);
    }
    if (st === "expired") {
      denyViaStdout(
        "Shield approval request expired. Retry the tool call and complete approval when prompted.",
      );
      process.exit(0);
    }
    if (st === "pending") {
      continue;
    }
  }
  return false;
}
async function handlePendingWithConsentAndPoll(
  config,
  approvalId,
  service,
  actionType,
  approvalsUrl,
) {
  if (hasConsentMarker(config.agentName)) {
    process.stderr.write(
      `[Shield] Waiting for approval (up to 5 min)...
  Approve in the Shield dashboard: ${approvalsUrl}
`,
    );
    const approved2 = await pollApprovalStatus(config, approvalId);
    if (approved2) {
      process.exit(0);
    }
    removeConsentMarker(config.agentName);
    denyViaStdout(
      `Shield approval timed out after 5 minutes. Approve at ${approvalsUrl} and retry.`,
    );
    process.exit(0);
  }
  const url = consentUrl(config.baseUrl, config.agentName, service, actionType);
  writeConsentMarker(config.agentName);
  openBrowser(url);
  process.stderr.write(
    "[Shield] Opening Shield consent screen... Waiting for approval (up to 5 min).\n",
  );
  const approved = await pollApprovalStatus(config, approvalId);
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
  } catch {
    process.stderr.write("[Shield] Warning: could not read stdin. Allowing tool.\n");
    process.exit(0);
  }
  const config = codexCliHooksShared_js.loadCodexCliConfig();
  if (config === null) {
    process.exit(0);
  }
  if (config.apiKey.length === 0 || config.agentName.length === 0) {
    process.exit(0);
  }
  let hookPayload;
  try {
    hookPayload = JSON.parse(raw.length > 0 ? raw : "{}");
  } catch {
    process.stderr.write("[Shield] Warning: invalid hook JSON. Allowing tool.\n");
    process.exit(0);
  }
  const toolNameRaw =
    (typeof hookPayload["tool_name"] === "string" && hookPayload["tool_name"]) || "";
  const toolInput = hookPayload["tool_input"] !== void 0 ? hookPayload["tool_input"] : void 0;
  try {
    void (typeof toolInput === "string"
      ? toolInput
      : JSON.stringify(toolInput === void 0 ? null : toolInput));
  } catch {
    process.stderr.write("[Shield] Warning: could not serialize tool input. Allowing tool.\n");
    process.exit(0);
  }
  const { service, actionType } = codexCliToolMap_js.mapCodexCliToolToShield(
    toolNameRaw,
    toolInput,
  );
  const approvalsUrl = dashboardHintUrl(config.baseUrl);
  const metadata = {
    tool_name: toolNameRaw,
    tool_input: codexCliHooksShared_js.serializeHookAuditFragment(toolInput),
    source: "codex-cli",
  };
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
    const res = await codexCliHooksShared_js.shieldPostJson(config.baseUrl, config.apiKey, payload);
    statusCode = res.statusCode;
    bodyText = res.bodyText;
  } catch (e) {
    const refusedHost = codexCliHooksShared_js.readHttpApiKeyRefusalHostname(e);
    if (refusedHost !== null) {
      process.stderr.write(codexCliHooksShared_js.formatHttpApiKeyRefusal(refusedHost));
      process.exit(2);
    }
    process.stderr.write(codexCliHooksShared_js.formatShieldNetworkError(e));
    process.exit(2);
  }
  const parsed = safeJsonParse(bodyText);
  const data = unwrapData(parsed);
  if (statusCode === 202) {
    if (data === null || typeof data !== "object") {
      denyViaStdout("This action needs approval in the Shield dashboard before it can run.");
      process.exit(0);
    }
    const approvalIdRaw = data["approval_id"];
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
        `[Shield] Error: unexpected Shield response, cannot verify permissions.
  Detail: ${detail}
`,
      );
      process.exit(2);
    }
    const dataObj = data;
    const statusRaw = dataObj["status"];
    const st = (typeof statusRaw === "string" ? statusRaw : "").toLowerCase();
    if (st === "approved") {
      process.exit(0);
    }
    if (st === "blocked") {
      denyViaStdout(blockedReason(data, service, actionType, approvalsUrl));
      process.exit(0);
    }
    process.stderr.write(
      `[Shield] Error: ambiguous Shield status, cannot verify permissions.
  Detail: status=${JSON.stringify(dataObj["status"])}
`,
    );
    process.exit(2);
  }
  const httpDetail = bodyText.length > 300 ? `${bodyText.slice(0, 300)}...` : bodyText;
  process.stderr.write(
    `[Shield] Error: Shield returned HTTP ${String(statusCode)}, cannot verify permissions.
  Detail: HTTP ${String(statusCode)} body=${httpDetail}
`,
  );
  process.exit(2);
}
main().catch((e) => {
  const refusedHost = codexCliHooksShared_js.readHttpApiKeyRefusalHostname(e);
  if (refusedHost !== null) {
    process.stderr.write(codexCliHooksShared_js.formatHttpApiKeyRefusal(refusedHost));
    process.exit(2);
  }
  process.stderr.write(codexCliHooksShared_js.formatShieldNetworkError(e));
  process.exit(2);
});
