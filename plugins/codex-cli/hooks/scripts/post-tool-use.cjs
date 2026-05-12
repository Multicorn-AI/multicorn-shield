"use strict";

var codexCliHooksShared_js = require("./codex-cli-hooks-shared.cjs");
var codexCliToolMap_js = require("./codex-cli-tool-map.cjs");

// AUTO-GENERATED from src/hooks/codex-cli-*.ts — do not edit manually. Run pnpm build from the package root to regenerate.

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
async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
  }
  const config = codexCliHooksShared_js.loadCodexCliConfig();
  if (config === null || config.apiKey.length === 0 || config.agentName.length === 0) {
    process.exit(0);
  }
  let hookPayload;
  try {
    hookPayload = JSON.parse(raw.length > 0 ? raw : "{}");
  } catch {
    process.exit(0);
  }
  const toolNameRaw =
    (typeof hookPayload["tool_name"] === "string" && hookPayload["tool_name"]) || "";
  const toolInput = hookPayload["tool_input"] !== void 0 ? hookPayload["tool_input"] : void 0;
  const toolResult =
    hookPayload["tool_response"] !== void 0
      ? hookPayload["tool_response"]
      : hookPayload["tool_result"] !== void 0
        ? hookPayload["tool_result"]
        : void 0;
  try {
    void (typeof toolInput === "string"
      ? toolInput
      : JSON.stringify(toolInput === void 0 ? null : toolInput));
    void (typeof toolResult === "string"
      ? toolResult
      : JSON.stringify(toolResult === void 0 ? null : toolResult));
  } catch {
    process.exit(0);
  }
  const { service, actionType } = codexCliToolMap_js.mapCodexCliToolToShield(
    toolNameRaw,
    toolInput,
  );
  const metadata = {
    tool_name: toolNameRaw,
    tool_input: codexCliHooksShared_js.serializeHookAuditFragment(toolInput),
    tool_result: codexCliHooksShared_js.serializeHookAuditFragment(toolResult),
    source: "codex-cli",
  };
  const payload = {
    agent: config.agentName,
    service,
    actionType,
    status: "approved",
    metadata,
    platform: "codex-cli",
  };
  try {
    await codexCliHooksShared_js.shieldPostJson(config.baseUrl, config.apiKey, payload);
  } catch (e) {
    const refusedHost = codexCliHooksShared_js.readHttpApiKeyRefusalHostname(e);
    if (refusedHost !== null) {
      process.stderr.write(codexCliHooksShared_js.formatHttpApiKeyRefusal(refusedHost));
      process.exit(0);
    }
    process.stderr.write("[Shield] Warning: failed to send logs to Shield.\n");
    process.stderr.write(codexCliHooksShared_js.formatShieldNetworkError(e));
  }
  process.exit(0);
}
main().catch((e) => {
  const refusedHost = codexCliHooksShared_js.readHttpApiKeyRefusalHostname(e);
  if (refusedHost !== null) {
    process.stderr.write(codexCliHooksShared_js.formatHttpApiKeyRefusal(refusedHost));
    process.exit(0);
  }
  process.stderr.write("[Shield] Warning: failed to send logs to Shield.\n");
  process.stderr.write(codexCliHooksShared_js.formatShieldNetworkError(e));
  process.exit(0);
});
