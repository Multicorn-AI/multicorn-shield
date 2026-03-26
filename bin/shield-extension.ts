#!/usr/bin/env node
/**
 * Entry point for the Claude Desktop Extension MCP server (.mcpb bundle).
 *
 * @module bin/shield-extension
 */

import { runShieldExtension } from "../src/extension/server.js";

void runShieldExtension().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`multicorn-shield-extension: ${message}\n`);
  process.exit(1);
});
