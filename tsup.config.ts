import { defineConfig } from "tsup";
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    splitting: true,
    sourcemap: false,
    clean: true,
    treeshake: true,
    minify: false,
    outDir: "dist",
  },
  {
    entry: { "multicorn-proxy": "bin/multicorn-proxy.ts" },
    format: ["esm"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    outDir: "dist",
    platform: "node",
    noExternal: [],
  },
  {
    entry: { "openclaw-hook/handler": "src/openclaw/hook/handler.ts" },
    format: ["esm"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    outDir: "dist",
    banner: {
      js: "// Multicorn Shield hook for OpenClaw (DEPRECATED - use the plugin instead) - https://multicorn.ai",
    },
    onSuccess: async () => {
      mkdirSync("dist/openclaw-hook", { recursive: true });
      copyFileSync("src/openclaw/hook/HOOK.md", "dist/openclaw-hook/HOOK.md");
    },
  },
  {
    entry: { "openclaw-plugin/multicorn-shield": "src/openclaw/plugin/index.ts" },
    format: ["esm"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    outDir: "dist",
    banner: {
      js: "// Multicorn Shield plugin for OpenClaw - https://multicorn.ai",
    },
    onSuccess: async () => {
      mkdirSync("dist/openclaw-plugin", { recursive: true });
      copyFileSync(
        "src/openclaw/plugin/openclaw.plugin.json",
        "dist/openclaw-plugin/openclaw.plugin.json",
      );
    },
  },
  {
    entry: { "shield-extension": "bin/shield-extension.ts" },
    format: ["esm"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    outDir: "dist",
    platform: "node",
    banner: {
      js: "// Multicorn Shield Claude Desktop Extension - https://multicorn.ai",
    },
    noExternal: ["@modelcontextprotocol/sdk", "zod"],
  },
  {
    entry: { "multicorn-shield": "bin/multicorn-shield.ts" },
    format: ["esm"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    outDir: "dist",
    platform: "node",
  },
  /** Claude Code plugin: shared tool mapping for CJS hook scripts (pre/post). */
  {
    entry: { "claude-code-tool-map": "src/hooks/claude-code-tool-map.ts" },
    format: ["cjs"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    outDir: "plugins/multicorn-shield/hooks/scripts",
    platform: "node",
    outExtension: () => ({ js: ".cjs" }),
    banner: {
      js: "// AUTO-GENERATED from src/hooks/claude-code-tool-map.ts — do not edit manually. Run pnpm build from the package root to regenerate.",
    },
    onSuccess: async () => {
      execFileSync(
        "pnpm",
        [
          "exec",
          "prettier",
          "--write",
          "plugins/multicorn-shield/hooks/scripts/claude-code-tool-map.cjs",
        ],
        { cwd: process.cwd(), stdio: "inherit" },
      );
    },
  },
  /** Codex CLI plugin: native hook scripts (CommonJS). */
  {
    entry: {
      "codex-cli-hooks-shared": "src/hooks/codex-cli-hooks-shared.ts",
      "codex-cli-tool-map": "src/hooks/codex-cli-tool-map.ts",
      "pre-tool-use": "src/hooks/codex-cli-pre-tool-use.ts",
      "post-tool-use": "src/hooks/codex-cli-post-tool-use.ts",
    },
    format: ["cjs"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    outDir: "plugins/codex-cli/hooks/scripts",
    platform: "node",
    outExtension: () => ({ js: ".cjs" }),
    banner: {
      js: "// AUTO-GENERATED from src/hooks/codex-cli-*.ts — do not edit manually. Run pnpm build from the package root to regenerate.\n",
    },
    esbuildOptions(options) {
      options.external ??= [];
      if (Array.isArray(options.external)) {
        options.external.push("./codex-cli-hooks-shared.js", "./codex-cli-tool-map.js");
      }
    },
    onSuccess: async () => {
      const hookDir = "plugins/codex-cli/hooks/scripts";
      for (const name of ["pre-tool-use.cjs", "post-tool-use.cjs"]) {
        const p = `${hookDir}/${name}`;
        let src = readFileSync(p, "utf8");
        src = src.replaceAll("./codex-cli-hooks-shared.js", "./codex-cli-hooks-shared.cjs");
        src = src.replaceAll("./codex-cli-tool-map.js", "./codex-cli-tool-map.cjs");
        writeFileSync(p, src);
      }
      execSync(`pnpm exec prettier --write ${hookDir}/*.cjs`, {
        cwd: process.cwd(),
        stdio: "inherit",
        shell: true,
      });
    },
  },
  {
    entry: { proxy: "src/proxy/exports.ts" },
    format: ["esm", "cjs"],
    dts: true,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    outDir: "dist",
    platform: "node",
  },
  {
    entry: { badge: "src/badge/badge-entrypoint.ts" },
    format: ["esm"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: true,
    outDir: "dist",
    platform: "browser",
  },
]);
