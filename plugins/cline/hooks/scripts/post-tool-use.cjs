#!/usr/bin/env node
// Copyright (c) Multicorn AI Pty Ltd. MIT License. See LICENSE file.
/**
 * Cline PostToolUse hook: logs completed actions to the Shield audit trail.
 * Reads JSON from stdin (Cline Hooks API), posts to Shield API.
 * Always returns {"cancel": false} - post hooks never block.
 */

"use strict";

const {
  buildScrubbedParametersJson,
  loadConfig,
  logPrefix,
  mapToolName,
  postJson,
  readStdin,
  scrubResultForMetadata,
} = require("./shared.cjs");

const HOOK_PREFIX = logPrefix("post-hook");

/**
 * Outputs JSON response to stdout and exits.
 */
function respond() {
  process.stdout.write(JSON.stringify({ cancel: false }) + "\n");
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

  const config = loadConfig();
  if (config === null || config.apiKey.length === 0 || config.agentName.length === 0) {
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

  const postToolUse = hookPayload.postToolUse;
  if (postToolUse === null || typeof postToolUse !== "object") {
    respond();
    return;
  }

  const toolUse = /** @type {Record<string, unknown>} */ (postToolUse);
  const toolName = typeof toolUse.tool === "string" ? toolUse.tool : "";

  if (toolName.length === 0) {
    respond();
    return;
  }

  const { service, actionType } = mapToolName(toolName);

  const paramsSerialized = buildScrubbedParametersJson(toolUse.parameters);

  /** @type {Record<string, unknown>} */
  const metadata = {
    tool_name: toolName,
    task_id: typeof hookPayload.taskId === "string" ? hookPayload.taskId : "",
    cline_version: typeof hookPayload.clineVersion === "string" ? hookPayload.clineVersion : "",
    parameters: paramsSerialized,
    result: scrubResultForMetadata(toolUse.result),
    timing: typeof toolUse.timing === "object" ? JSON.stringify(toolUse.timing) : "",
    source: "cline",
  };

  /** @type {Record<string, unknown>} */
  const payload = {
    agent: config.agentName,
    service,
    actionType,
    status: "approved",
    metadata,
    platform: "cline",
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
