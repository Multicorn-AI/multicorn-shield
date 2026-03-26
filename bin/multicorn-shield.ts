#!/usr/bin/env node
/**
 * Multicorn Shield CLI (restore and future subcommands).
 *
 * @module bin/multicorn-shield
 */

import { restoreClaudeDesktopMcpFromBackup } from "../src/extension/restore.js";

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "restore") {
    await restoreClaudeDesktopMcpFromBackup();
    process.stderr.write(
      "Restored MCP server entries from ~/.multicorn/extension-backup.json into Claude Desktop config.\n" +
        "Restart Claude Desktop to apply changes.\n",
    );
    return;
  }

  process.stderr.write(
    [
      "Multicorn Shield command-line tool",
      "",
      "Usage:",
      "  npx multicorn-shield restore",
      "      Restore MCP servers in claude_desktop_config.json from the Shield extension backup.",
      "",
    ].join("\n"),
  );
  process.exit(arg === undefined || arg === "help" || arg === "--help" ? 0 : 1);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
