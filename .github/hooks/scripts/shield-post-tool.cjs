#!/usr/bin/env node
// Copyright (c) Multicorn AI Pty Ltd. MIT License. See LICENSE file.
/**
 * GitHub Copilot postToolUse hook: logs completed tool use to Shield.
 */

"use strict";

const {
  buildScrubbedParametersJson,
  loadConfig,
  logPrefix,
  mapToolName,
  parseToolArgsObject,
  postJson,
  readStdin,
  scrubResultForMetadata,
} = require("./shared.cjs");

const HOOK_PREFIX = logPrefix("post-hook");

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

  const toolName =
    typeof hookPayload.toolName === "string"
      ? hookPayload.toolName
      : typeof hookPayload.tool === "string"
        ? hookPayload.tool
        : "";

  if (toolName.length === 0) {
    process.exit(0);
  }

  const parameters = parseToolArgsObject(hookPayload.toolArgs);
  const { service, actionType } = mapToolName(toolName);

  const paramsSerialized = buildScrubbedParametersJson(parameters);
  const resultStr =
    typeof hookPayload.toolResult === "string"
      ? hookPayload.toolResult
      : hookPayload.toolResult != null
        ? JSON.stringify(hookPayload.toolResult)
        : "";

  /** @type {Record<string, unknown>} */
  const metadata = {
    tool_name: toolName,
    parameters: paramsSerialized,
    result: scrubResultForMetadata(resultStr),
    timestamp: typeof hookPayload.timestamp === "string" ? hookPayload.timestamp : "",
    source: "github-copilot",
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: config.agentName,
    service,
    actionType,
    status: "approved",
    metadata,
    platform: "github-copilot",
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

  process.exit(0);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(
    `${HOOK_PREFIX} Warning: failed to log action to Shield audit trail. Detail: ${msg}\n`,
  );
  process.exit(0);
});
