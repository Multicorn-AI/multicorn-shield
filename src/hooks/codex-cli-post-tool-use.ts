/**
 * MIT License
 *
 * Copyright (c) Multicorn AI Pty Ltd
 *
 * Codex CLI PostToolUse hook: sends completed tool calls to Shield for logging.
 * Never blocks; always exit 0.
 *
 * Built to `plugins/codex-cli/hooks/scripts/post-tool-use.cjs`. Do not edit the CJS output by hand.
 *
 * @module hooks/codex-cli-post-tool-use
 */

import {
  formatHttpApiKeyRefusal,
  formatShieldNetworkError,
  loadCodexCliConfig,
  readHttpApiKeyRefusalHostname,
  serializeHookAuditFragment,
  shieldPostJson,
} from "./codex-cli-hooks-shared.js";
import { mapCodexCliToolToShield } from "./codex-cli-tool-map.js";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => chunks.push(c));
    process.stdin.on("end", () => {
      resolve(chunks.join(""));
    });
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
  }

  const config = loadCodexCliConfig();
  if (config === null || config.apiKey.length === 0 || config.agentName.length === 0) {
    process.exit(0);
  }

  let hookPayload: Record<string, unknown>;
  try {
    hookPayload = JSON.parse(raw.length > 0 ? raw : "{}") as Record<string, unknown>;
  } catch {
    process.exit(0);
  }

  const toolNameRaw =
    (typeof hookPayload["tool_name"] === "string" && hookPayload["tool_name"]) || "";
  const toolInput = hookPayload["tool_input"] !== undefined ? hookPayload["tool_input"] : undefined;
  const toolResult =
    hookPayload["tool_response"] !== undefined
      ? hookPayload["tool_response"]
      : hookPayload["tool_result"] !== undefined
        ? hookPayload["tool_result"]
        : undefined;

  try {
    void (typeof toolInput === "string"
      ? toolInput
      : JSON.stringify(toolInput === undefined ? null : toolInput));
    void (typeof toolResult === "string"
      ? toolResult
      : JSON.stringify(toolResult === undefined ? null : toolResult));
  } catch {
    process.exit(0);
  }

  const { service, actionType } = mapCodexCliToolToShield(toolNameRaw, toolInput);

  const metadata: Record<string, unknown> = {
    tool_name: toolNameRaw,
    tool_input: serializeHookAuditFragment(toolInput),
    tool_result: serializeHookAuditFragment(toolResult),
    source: "codex-cli",
  };

  const payload: Record<string, unknown> = {
    agent: config.agentName,
    service,
    actionType,
    status: "approved",
    metadata,
    platform: "codex-cli",
  };

  try {
    await shieldPostJson(config.baseUrl, config.apiKey, payload);
  } catch (e: unknown) {
    const refusedHost = readHttpApiKeyRefusalHostname(e);
    if (refusedHost !== null) {
      process.stderr.write(formatHttpApiKeyRefusal(refusedHost));
      process.exit(0);
    }
    process.stderr.write("[Shield] Warning: failed to send logs to Shield.\n");
    process.stderr.write(formatShieldNetworkError(e));
  }

  process.exit(0);
}

main().catch((e: unknown) => {
  const refusedHost = readHttpApiKeyRefusalHostname(e);
  if (refusedHost !== null) {
    process.stderr.write(formatHttpApiKeyRefusal(refusedHost));
    process.exit(0);
  }
  process.stderr.write("[Shield] Warning: failed to send logs to Shield.\n");
  process.stderr.write(formatShieldNetworkError(e));
  process.exit(0);
});
