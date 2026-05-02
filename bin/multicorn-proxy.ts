#!/usr/bin/env node
/**
 * Backward-compat entry: prefer `multicorn-shield`.
 *
 * @module bin/multicorn-proxy
 */

process.stderr.write("Warning: multicorn-proxy is deprecated. Use multicorn-shield instead.\n");

const { runCli } = await import("./multicorn-shield.js");

void runCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});

export {};
