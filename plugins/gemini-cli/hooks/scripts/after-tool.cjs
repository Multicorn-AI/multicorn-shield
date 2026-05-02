#!/usr/bin/env node
// Copyright (c) Multicorn AI Pty Ltd. MIT License. See LICENSE file.
/**
 * Gemini CLI AfterTool hook: audit logging to Shield.
 * Always returns { "decision": "allow" } on stdout.
 */

"use strict";

const {
  loadConfig,
  logPrefix,
  mapToolName,
  postJson,
  readStdin,
  scrubParameters,
  scrubResultForMetadata,
} = require("./shared.cjs");

const HOOK_PREFIX = logPrefix("after-tool");

function respond() {
  process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
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

  /** @type {Record<string, unknown>} */
  let hookPayload;
  try {
    hookPayload = JSON.parse(raw.length > 0 ? raw : "{}");
  } catch {
    respond();
    return;
  }

  const toolName = typeof hookPayload.tool_name === "string" ? hookPayload.tool_name : "";
  const mapped = mapToolName(toolName);

  if (mapped === null) {
    respond();
    return;
  }
  const { service, actionType } = mapped;

  const config = loadConfig();
  if (config === null || config.apiKey.length === 0 || config.agentName.length === 0) {
    respond();
    return;
  }

  const toolInput =
    typeof hookPayload.tool_input === "object" && hookPayload.tool_input !== null
      ? /** @type {Record<string, unknown>} */ (hookPayload.tool_input)
      : {};

  const paramsSerialized = scrubParameters(toolInput);
  const toolResponse = hookPayload.tool_response;

  /** @type {Record<string, unknown>} */
  const metadata = {
    tool_name: toolName,
    session_id: typeof hookPayload.session_id === "string" ? hookPayload.session_id : "",
    cwd: typeof hookPayload.cwd === "string" ? hookPayload.cwd : "",
    parameters: paramsSerialized,
    result: scrubResultForMetadata(toolResponse),
    source: "gemini-cli",
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: config.agentName,
    service,
    actionType,
    status: "approved",
    metadata,
    platform: "gemini-cli",
  };

  try {
    const res = await postJson(config.baseUrl, config.apiKey, payload);
    const code = res.statusCode ?? 0;
    if (code < 200 || code >= 300) {
      throw new Error(`HTTP ${String(code)}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `${HOOK_PREFIX} Warning: failed to log action to Shield audit trail. Detail: ${msg}\n`,
    );
  }

  respond();
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(
    `${HOOK_PREFIX} Warning: failed to log action to Shield audit trail. Detail: ${msg}\n`,
  );
  respond();
});
